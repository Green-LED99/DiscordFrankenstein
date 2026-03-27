import { prepareStream, playStream } from "@dank074/discord-video-stream";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { getStreamer } from "./client.js";
import { autoTune, buildStreamOptions } from "./encoder.js";
import { probeStream, type StreamInfo } from "../services/ffprobe.js";
import { startSyncMonitor, stopSyncMonitor } from "../utils/sync.js";
import { createLogger, errStr } from "../utils/logger.js";

const log = createLogger("Stream");
const execFileAsync = promisify(execFileCb);

// ── FFmpeg Process Kill with Verification ──────────────────────────────

/** Kill all ffmpeg processes via OS and VERIFY they are dead. */
async function killAllFfmpegAndVerify(
  ffmpegCommand?: { kill: (signal: string) => void }
): Promise<void> {
  log.debug("killAllFfmpegAndVerify: starting...");

  // Step 1: Direct kill via fluent-ffmpeg command object
  if (ffmpegCommand) {
    try { ffmpegCommand.kill("SIGKILL"); } catch { /* already dead or never started */ }
  }

  // Step 2: OS-level kill
  await killAllFfmpegOs();

  // Step 3: Poll to verify (up to 3 attempts, 500ms apart)
  for (let attempt = 0; attempt < 3; attempt++) {
    const alive = await isAnyFfmpegRunning();
    if (!alive) {
      log.debug(`killAllFfmpegAndVerify: confirmed dead (attempt ${attempt})`);
      return;
    }
    log.warn(`killAllFfmpegAndVerify: ffmpeg still alive (attempt ${attempt}), retrying...`);
    await killAllFfmpegOs();
    await new Promise(r => setTimeout(r, 500));
  }

  // Final check
  const stillAlive = await isAnyFfmpegRunning();
  if (stillAlive) {
    log.error("CRITICAL: FFmpeg still alive after 3 kill attempts");
  } else {
    log.debug("killAllFfmpegAndVerify: confirmed dead after retries");
  }
}

async function killAllFfmpegOs(): Promise<void> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "taskkill" : "pkill";
  const args = isWin ? ["/F", "/IM", "ffmpeg.exe"] : ["-9", "ffmpeg"];
  try {
    await execFileAsync(cmd, args);
    log.debug("killAllFfmpegOs: kill command succeeded");
  } catch {
    // "no matching processes" is expected
    log.debug("killAllFfmpegOs: no processes to kill (or already dead)");
  }
}

async function isAnyFfmpegRunning(): Promise<boolean> {
  const isWin = process.platform === "win32";
  try {
    if (isWin) {
      const { stdout } = await execFileAsync("tasklist", [
        "/FI", "IMAGENAME eq ffmpeg.exe", "/FO", "CSV", "/NH",
      ]);
      return stdout.includes("ffmpeg.exe");
    } else {
      const { stdout } = await execFileAsync("pgrep", ["-x", "ffmpeg"]);
      return stdout.trim().length > 0;
    }
  } catch {
    return false; // pgrep exit code 1 = no match
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface SeriesInfo {
  showId: string;
  showName: string;
  season: number;
  episode: number;
}

interface ActiveStream {
  guildId: string;
  channelId: string;
  abortController: AbortController;
  startedAt: number;
  streamUrl: string;
  subtitlePath?: string;
  isLive: boolean;
  headers?: Record<string, string>;
  reconnectCount: number;
  seekOffsetSec: number;
  contentTitle: string;
  audioStreamIndex?: number;
  sourceInfo?: StreamInfo;
  seriesInfo?: SeriesInfo;
  streamEndPromise?: Promise<void>;
  ffmpegCommand?: { kill: (signal: string) => void };
  watchdogTimer?: ReturnType<typeof setInterval>;
  lastFrameTime: number;
}

interface PausedState {
  guildId: string;
  channelId: string;
  streamUrl: string;
  elapsedSec: number;
  contentTitle: string;
  audioStreamIndex?: number;
  subtitlePath?: string;
  sourceInfo?: StreamInfo;
  headers?: Record<string, string>;
  seriesInfo?: SeriesInfo;
}

let activeStream: ActiveStream | null = null;
let pausedState: PausedState | null = null;

// Simple async mutex
let streamLock: Promise<void> = Promise.resolve();
function acquireStreamLock(): { promise: Promise<void>; release: () => void } {
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const acquired = streamLock;
  streamLock = next;
  return { promise: acquired, release: release! };
}

// Autoplay state
let autoplayEnabled = false;
let autoplayCallback: (() => Promise<void>) | null = null;

// Last known voice channel (set by every stream start, used by autoplay)
let lastKnownGuildId: string | null = null;
let lastKnownChannelId: string | null = null;

// ── Public Getters ──────────────────────────────────────────────────────

export function isStreaming(): boolean { return activeStream !== null; }

export function getSeriesInfo(): SeriesInfo | null {
  return activeStream?.seriesInfo ?? pausedState?.seriesInfo ?? null;
}

export function isAutoplayEnabled(): boolean { return autoplayEnabled; }

export function setAutoplay(enabled: boolean): void {
  autoplayEnabled = enabled;
  if (!enabled) autoplayCallback = null;
}

export function setAutoplayCallback(cb: (() => Promise<void>) | null): void {
  autoplayCallback = cb;
}

export function isLiveStream(): boolean { return activeStream?.isLive ?? false; }

export function getPlaybackInfo(): { title: string; elapsedSec: number; isLive: boolean } | null {
  if (!activeStream) return null;
  const wallElapsed = (Date.now() - activeStream.startedAt) / 1000;
  return {
    title: activeStream.contentTitle,
    elapsedSec: wallElapsed + activeStream.seekOffsetSec,
    isLive: activeStream.isLive,
  };
}

export function getPausedState(): PausedState | null { return pausedState; }
export function clearPausedState(): void { pausedState = null; }

export function getLastKnownVoiceChannel(): { guildId: string; channelId: string } | null {
  if (lastKnownGuildId && lastKnownChannelId) {
    return { guildId: lastKnownGuildId, channelId: lastKnownChannelId };
  }
  return null;
}

// ── Core: Unified Teardown ──────────────────────────────────────────────

interface TeardownResult {
  seriesInfo: SeriesInfo | null;
  wasAutoplay: boolean;
  cb: (() => Promise<void>) | null;
}

/**
 * Tear down the current stream with VERIFIED FFmpeg kill.
 * @param leaveVoice - true for /stop, /pause, autoplay end. false for /seek, /skip (preserves Go Live).
 */
async function teardownStream(leaveVoice: boolean): Promise<TeardownResult> {
  const result: TeardownResult = {
    seriesInfo: activeStream?.seriesInfo ?? null,
    wasAutoplay: autoplayEnabled,
    cb: autoplayCallback,
  };

  if (!activeStream) return result;

  log.info(`teardownStream(leaveVoice=${leaveVoice}): starting`);

  // 1. Clear watchdog FIRST to prevent it from racing
  if (activeStream.watchdogTimer) {
    clearInterval(activeStream.watchdogTimer);
    activeStream.watchdogTimer = undefined;
  }

  // 2. Abort the signal (tells library to stop demuxer)
  activeStream.abortController.abort();
  log.debug("teardownStream: abort controller signaled");

  // 3. Stop sync monitor
  stopSyncMonitor();

  // 4. Stop the library's stream sender (always — voice state gets corrupted by abort)
  const streamer = getStreamer();
  try { streamer.stopStream(); } catch { /* may already be stopped */ }

  // 5. Kill FFmpeg and VERIFY it is dead (awaits with polling)
  await killAllFfmpegAndVerify(activeStream.ffmpegCommand);

  // 6. Wait for library promises to settle (hard 5s timeout)
  const endPromise = activeStream.streamEndPromise;
  if (endPromise) {
    log.debug("teardownStream: waiting for settle promise (up to 5s)...");
    await Promise.race([endPromise, new Promise<void>(r => setTimeout(r, 5000))]);
    log.debug("teardownStream: settle promise resolved or timed out");
  }

  // 7. Final verification
  const stillAlive = await isAnyFfmpegRunning();
  if (stillAlive) {
    log.error("CRITICAL: FFmpeg still alive after teardown, force killing...");
    await killAllFfmpegOs();
    await new Promise(r => setTimeout(r, 500));
  }

  // 8. Clean up subtitle temp file (only if not paused)
  const subPath = activeStream.subtitlePath;
  if (subPath && !pausedState) {
    rm(dirname(subPath), { recursive: true, force: true }).catch(() => {});
  }

  // 9. Null out active stream
  activeStream = null;

  // 10. Leave voice only when requested (skip/seek preserve voice for faster restart)
  if (leaveVoice) {
    try { streamer.leaveVoice(); } catch { /* already left */ }
  }

  log.info(`teardownStream: complete (leaveVoice=${leaveVoice})`);
  return result;
}

// ── Core: Unified Stream End Handler ────────────────────────────────────

/**
 * Handle stream end from BOTH natural exit and watchdog.
 * Acquires stream lock, runs full teardown, then triggers autoplay.
 */
async function handleStreamEnd(reason: "natural" | "watchdog"): Promise<void> {
  const { promise: waitForLock, release } = acquireStreamLock();
  await waitForLock;

  try {
    if (!activeStream) {
      log.debug(`handleStreamEnd(${reason}): no active stream, already cleaned up`);
      return;
    }

    log.info(`Stream ended (${reason}), starting teardown`);
    const { seriesInfo, wasAutoplay, cb } = await teardownStream(true);

    // Trigger autoplay AFTER full verified teardown
    if (wasAutoplay && cb && seriesInfo) {
      log.info(`Autoplay: triggering next episode for ${seriesInfo.showName} S${seriesInfo.season}E${seriesInfo.episode}`);

      // Small delay for OS to fully reap the process
      await new Promise(r => setTimeout(r, 1000));

      // Verify AGAIN before spawning new FFmpeg
      const zombieCheck = await isAnyFfmpegRunning();
      if (zombieCheck) {
        log.error("Autoplay: zombie FFmpeg detected, killing before autoplay...");
        await killAllFfmpegAndVerify();
      }

      cb().catch((err) => log.error(`Autoplay failed: ${errStr(err)}`));
    }
  } finally {
    release();
  }
}

// ── Public: Pause ───────────────────────────────────────────────────────

/**
 * Pause the current stream. Saves elapsed time + stream context for resume.
 * Kills FFmpeg and leaves voice channel (ends Go Live).
 */
export async function pauseStream(): Promise<{ elapsedSec: number; title: string }> {
  const { promise: waitForLock, release } = acquireStreamLock();
  await waitForLock;

  try {
    if (!activeStream) throw new Error("No active stream to pause");
    if (activeStream.isLive) throw new Error("Cannot pause a live stream");

    const wallElapsed = (Date.now() - activeStream.startedAt) / 1000;
    const elapsedSec = wallElapsed + activeStream.seekOffsetSec;
    const title = activeStream.contentTitle;

    pausedState = {
      guildId: activeStream.guildId,
      channelId: activeStream.channelId,
      streamUrl: activeStream.streamUrl,
      elapsedSec,
      contentTitle: title,
      audioStreamIndex: activeStream.audioStreamIndex,
      subtitlePath: activeStream.subtitlePath,
      sourceInfo: activeStream.sourceInfo,
      headers: activeStream.headers,
      seriesInfo: activeStream.seriesInfo,
    };

    log.info(`Pausing "${title}" at ${elapsedSec.toFixed(1)}s`);
    await teardownStream(true);

    return { elapsedSec, title };
  } finally {
    release();
  }
}

// ── Public: Restart at Position (for /skip and /seek) ───────────────────

/**
 * Atomically stop the current stream and relaunch at a new position.
 * Runs entirely under ONE lock so nothing can race between teardown and restart.
 * FFmpeg is relaunched with `-ss <seekSec>` for fast keyframe seek.
 *
 * Must leave voice and rejoin — the library cannot preserve Go Live across
 * FFmpeg restarts. A 1-second delay ensures the old FFmpeg process is fully
 * reaped before spawning a new one (prevents zombie overlap).
 */
export async function restartAtPosition(seekSec: number): Promise<void> {
  const { promise: waitForLock, release } = acquireStreamLock();
  await waitForLock;

  try {
    if (!activeStream) throw new Error("No active stream to restart");
    if (activeStream.isLive) throw new Error("Cannot seek/skip in a live stream");

    // Capture everything we need from the active stream before teardown
    const {
      guildId, channelId, streamUrl, audioStreamIndex,
      subtitlePath, sourceInfo, headers, contentTitle, seriesInfo,
    } = activeStream;

    log.info(`restartAtPosition: "${contentTitle}" → ${seekSec.toFixed(1)}s`);

    // Teardown current stream — must leave voice (library can't reuse Go Live)
    await teardownStream(true);

    // Wait for OS to fully reap the old FFmpeg process
    await new Promise(r => setTimeout(r, 1000));

    // Verify no zombie FFmpeg before spawning new one
    const zombieCheck = await isAnyFfmpegRunning();
    if (zombieCheck) {
      log.warn("restartAtPosition: zombie FFmpeg detected, killing...");
      await killAllFfmpegAndVerify();
    }

    // Relaunch at the new position (inline, no second lock acquisition)
    await startVideoStreamInner(
      guildId, channelId, streamUrl, audioStreamIndex,
      subtitlePath, sourceInfo, headers, false,
      seekSec, contentTitle, seriesInfo,
    );

    log.info(`restartAtPosition: relaunched at ${seekSec.toFixed(1)}s`);
  } finally {
    release();
  }
}

/**
 * Get the current elapsed time in seconds for the active stream.
 * Returns null if nothing is playing.
 */
export function getCurrentElapsedSec(): number | null {
  if (!activeStream) return null;
  const wallElapsed = (Date.now() - activeStream.startedAt) / 1000;
  return wallElapsed + activeStream.seekOffsetSec;
}

// ── Public: Stop ────────────────────────────────────────────────────────

export async function stopVideoStream(): Promise<void> {
  const { promise: waitForLock, release } = acquireStreamLock();
  await waitForLock;

  try {
    if (!activeStream && !pausedState) {
      log.info("No active stream to stop");
      return;
    }

    log.info("Stopping stream...");

    if (activeStream) {
      await teardownStream(true);
    }

    // Clear paused state and clean up subtitle temps
    if (pausedState) {
      if (pausedState.subtitlePath) {
        rm(dirname(pausedState.subtitlePath), { recursive: true, force: true }).catch(() => {});
      }
      pausedState = null;
      log.info("Cleared paused state");
    }

    // Disable autoplay on explicit stop
    setAutoplay(false);
    setAutoplayCallback(null);

    log.info("Stream stopped");
  } finally {
    release();
  }
}

// ── Public: Start ───────────────────────────────────────────────────────

export async function startVideoStream(
  guildId: string,
  channelId: string,
  streamUrl: string,
  audioStreamIndex?: number,
  subtitlePath?: string,
  sourceInfo?: StreamInfo,
  headers?: Record<string, string>,
  isLive = false,
  seekSeconds?: number,
  contentTitle?: string,
  seriesInfo?: SeriesInfo,
): Promise<void> {
  const { promise: waitForLock, release } = acquireStreamLock();
  await waitForLock;

  try {
    await startVideoStreamInner(
      guildId, channelId, streamUrl, audioStreamIndex, subtitlePath,
      sourceInfo, headers, isLive, seekSeconds, contentTitle, seriesInfo
    );
  } finally {
    release();
  }
}

async function startVideoStreamInner(
  guildId: string,
  channelId: string,
  streamUrl: string,
  audioStreamIndex?: number,
  subtitlePath?: string,
  existingProbe?: StreamInfo,
  headers?: Record<string, string>,
  isLive = false,
  seekSeconds?: number,
  contentTitle?: string,
  seriesInfo?: SeriesInfo,
): Promise<void> {
  // Tear down any existing stream — must leave voice (library can't reuse Go Live)
  if (activeStream) {
    log.info("Tearing down existing stream before starting new one");
    await teardownStream(true);

    // Wait for OS to fully reap the old FFmpeg process
    await new Promise(r => setTimeout(r, 1000));

    // Verify no zombie FFmpeg before spawning new one
    const zombieCheck = await isAnyFfmpegRunning();
    if (zombieCheck) {
      log.warn("Zombie FFmpeg detected after teardown — killing");
      await killAllFfmpegAndVerify();
    }
  }

  // Pre-spawn safety: also check for stale FFmpeg even if there was no active stream
  const stale = await isAnyFfmpegRunning();
  if (stale) {
    log.warn("Stale FFmpeg detected before prepareStream — killing");
    await killAllFfmpegAndVerify();
  }

  const streamer = getStreamer();

  // 1. Probe
  const sourceInfo = existingProbe ?? await (async () => {
    log.info("Probing source stream...");
    return probeStream(streamUrl, headers);
  })();

  // 2. Build options
  const tuned = await autoTune();
  const options = buildStreamOptions(sourceInfo, tuned, audioStreamIndex, subtitlePath, headers, seekSeconds);

  // 3. Join voice channel (always rejoin — library voice state gets corrupted after abort)
  log.info(`Joining voice channel ${channelId} in guild ${guildId}`);
  await streamer.joinVoice(guildId, channelId);

  // 4. Track last known channel for autoplay
  lastKnownGuildId = guildId;
  lastKnownChannelId = channelId;

  // 5. Prepare FFmpeg stream
  const abortController = new AbortController();
  log.info(`Preparing stream from: ${streamUrl.substring(0, 80)}...`);
  const { command, output, promise } = prepareStream(streamUrl, options, abortController.signal);

  const now = Date.now();
  activeStream = {
    guildId,
    channelId,
    abortController,
    startedAt: now,
    streamUrl,
    subtitlePath,
    isLive,
    headers,
    reconnectCount: 0,
    seekOffsetSec: seekSeconds ?? 0,
    contentTitle: contentTitle ?? "Unknown",
    audioStreamIndex,
    sourceInfo,
    seriesInfo,
    ffmpegCommand: command as unknown as { kill: (signal: string) => void },
    lastFrameTime: now,
  };

  // 6. Sync monitor
  const ffmpegProcess = (command as unknown as { _currentProcess?: { stderr?: NodeJS.ReadableStream } })
    ._currentProcess;
  if (ffmpegProcess?.stderr) {
    startSyncMonitor(ffmpegProcess.stderr, () => {
      log.warn("A/V drift detected - encoder may be struggling");
    });
  }

  // 7. Start Go Live
  log.info("Starting Go Live stream");
  const playPromise = playStream(output, streamer, { type: "go-live" }, abortController.signal);

  // 8. Stream end handler — delegates to unified handleStreamEnd
  const settlePromise = Promise.allSettled([promise, playPromise]).then(async ([encodeResult, playResult]) => {
    if (abortController.signal.aborted) {
      log.debug("Stream-end handler: aborted externally, skipping");
      return;
    }

    if (encodeResult.status === "rejected") {
      log.error(`FFmpeg error: ${errStr(encodeResult.reason)}`);
    }
    if (playResult.status === "rejected") {
      log.error(`Playback error: ${errStr(playResult.reason)}`);
    }

    await handleStreamEnd("natural");
  }).catch((err) => {
    log.error(`Stream end handler error: ${errStr(err)}`);
  });

  // 9. Watchdog: if no frames for 15s, force end
  const watchdogInterval = setInterval(() => {
    if (!activeStream || activeStream.abortController !== abortController) {
      clearInterval(watchdogInterval);
      return;
    }
    const silentMs = Date.now() - activeStream.lastFrameTime;
    if (silentMs > 15_000 && activeStream.lastFrameTime !== activeStream.startedAt) {
      log.info(`Watchdog: no frames for ${(silentMs / 1000).toFixed(0)}s — stream appears ended`);
      clearInterval(watchdogInterval);
      handleStreamEnd("watchdog").catch(err => log.error(`Watchdog handler error: ${errStr(err)}`));
    }
  }, 5_000);

  if (activeStream) {
    activeStream.watchdogTimer = watchdogInterval;
  }

  // 10. Update lastFrameTime on output data
  output.on("data", () => {
    if (activeStream) activeStream.lastFrameTime = Date.now();
  });

  // 11. Store settle promise
  if (activeStream) {
    activeStream.streamEndPromise = settlePromise;
  }

  log.info("Stream started successfully");
}
