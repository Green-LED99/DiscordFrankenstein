import { prepareStream, playStream } from "@dank074/discord-video-stream";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { getStreamer } from "./client.js";
import { autoTune, buildStreamOptions } from "./encoder.js";
import { probeStream, type StreamInfo } from "../services/ffprobe.js";
import { startSyncMonitor, stopSyncMonitor } from "../utils/sync.js";
import { createLogger, errStr } from "../utils/logger.js";

const log = createLogger("Stream");

export interface SeriesInfo {
  showId: string;      // IMDB ID
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
  // Playback tracking
  seekOffsetSec: number;
  contentTitle: string;
  audioStreamIndex?: number;
  sourceInfo?: StreamInfo;
  seriesInfo?: SeriesInfo;
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

// Simple async mutex to prevent concurrent stream starts
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

export function isStreaming(): boolean {
  return activeStream !== null;
}

export function getSeriesInfo(): SeriesInfo | null {
  return activeStream?.seriesInfo ?? pausedState?.seriesInfo ?? null;
}

export function isAutoplayEnabled(): boolean {
  return autoplayEnabled;
}

export function setAutoplay(enabled: boolean): void {
  autoplayEnabled = enabled;
  if (!enabled) autoplayCallback = null;
}

export function setAutoplayCallback(cb: (() => Promise<void>) | null): void {
  autoplayCallback = cb;
}

export function isLiveStream(): boolean {
  return activeStream?.isLive ?? false;
}

/**
 * Get current playback info (title + elapsed time).
 */
export function getPlaybackInfo(): { title: string; elapsedSec: number; isLive: boolean } | null {
  if (!activeStream) return null;
  const wallElapsed = (Date.now() - activeStream.startedAt) / 1000;
  return {
    title: activeStream.contentTitle,
    elapsedSec: wallElapsed + activeStream.seekOffsetSec,
    isLive: activeStream.isLive,
  };
}

/**
 * Get the paused state (if stream is paused).
 */
export function getPausedState(): PausedState | null {
  return pausedState;
}

/**
 * Clear the paused state (called after play resumes).
 */
export function clearPausedState(): void {
  pausedState = null;
}

/**
 * Pause the current stream: save elapsed time, stop playback.
 * Returns the elapsed time and title for display.
 */
/**
 * Pause the current stream: save elapsed time, stop playback, leave voice.
 */
export async function pauseStream(): Promise<{ elapsedSec: number; title: string }> {
  if (!activeStream) throw new Error("No active stream to pause");
  if (activeStream.isLive) throw new Error("Cannot pause a live stream");

  const wallElapsed = (Date.now() - activeStream.startedAt) / 1000;
  const elapsedSec = wallElapsed + activeStream.seekOffsetSec;
  const title = activeStream.contentTitle;

  // Save state for resume
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

  // Stop FFmpeg and leave voice
  activeStream.abortController.abort();
  stopSyncMonitor();
  const streamer = getStreamer();
  try { streamer.stopStream(); } catch { /* may already be stopped */ }
  try { streamer.leaveVoice(); } catch { /* may already have left */ }
  activeStream = null;

  return { elapsedSec, title };
}

/**
 * Start streaming to a voice channel.
 * @param sourceInfo - If provided, skips re-probing the URL (avoids double probe).
 * @param seekSeconds - If provided, seeks to this position via FFmpeg -ss.
 * @param contentTitle - Display title for /np command.
 */
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
  if (activeStream) {
    log.info("Stopping existing stream before starting new one");
    await stopVideoStream();
  }

  const streamer = getStreamer();

  // 1. Probe the source (skip if already probed by command handler)
  const sourceInfo = existingProbe ?? await (async () => {
    log.info("Probing source stream...");
    return probeStream(streamUrl, headers);
  })();

  // 2. Build stream options (always transcode)
  const tuned = await autoTune();
  const options = buildStreamOptions(sourceInfo, tuned, audioStreamIndex, subtitlePath, headers, seekSeconds);

  // 3. Join voice channel
  log.info(`Joining voice channel ${channelId} in guild ${guildId}`);
  await streamer.joinVoice(guildId, channelId);

  // 4. Prepare FFmpeg stream
  const abortController = new AbortController();
  log.info(`Preparing stream from: ${streamUrl.substring(0, 80)}...`);
  const { command, output, promise } = prepareStream(
    streamUrl,
    options,
    abortController.signal
  );

  activeStream = {
    guildId,
    channelId,
    abortController,
    startedAt: Date.now(),
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
  };

  // 5. Monitor A/V sync via FFmpeg stderr
  const ffmpegProcess = (command as unknown as { _currentProcess?: { stderr?: NodeJS.ReadableStream } })
    ._currentProcess;
  if (ffmpegProcess?.stderr) {
    startSyncMonitor(ffmpegProcess.stderr, () => {
      log.warn("A/V drift detected - encoder may be struggling");
    });
  }

  // 6. Start Go Live playback
  log.info("Starting Go Live stream");
  const playPromise = playStream(output, streamer, {
    type: "go-live",
  }, abortController.signal);

  // Handle stream end (with .catch to prevent unhandled rejection)
  Promise.allSettled([promise, playPromise]).then(([encodeResult, playResult]) => {
    if (abortController.signal.aborted) return;

    if (encodeResult.status === "rejected") {
      log.error(`FFmpeg error: ${errStr(encodeResult.reason)}`);
    }
    if (playResult.status === "rejected") {
      log.error(`Playback error: ${errStr(playResult.reason)}`);
    }

    log.info("Stream ended naturally");

    // Trigger autoplay if enabled and this was a series
    const cb = autoplayCallback;
    const series = activeStream?.seriesInfo;
    cleanup();

    if (autoplayEnabled && cb && series) {
      log.info(`Autoplay: triggering next episode for ${series.showName} S${series.season}E${series.episode}`);
      cb().catch((err) => log.error(`Autoplay failed: ${errStr(err)}`));
    }
  }).catch((err) => {
    log.error(`Stream end handler error: ${errStr(err)}`);
  });

  log.info("Stream started successfully");
}

/** Idempotent cleanup — safe to call multiple times. */
function cleanup(): void {
  if (!activeStream) return; // Already cleaned up

  // Clean up subtitle temp file (only if NOT paused — paused needs it for resume)
  const subPath = activeStream.subtitlePath;
  if (subPath && !pausedState) {
    rm(dirname(subPath), { recursive: true, force: true }).catch(() => {});
  }

  activeStream = null;
  stopSyncMonitor();

  const streamer = getStreamer();
  try { streamer.stopStream(); } catch { /* may already be stopped */ }
  try { streamer.leaveVoice(); } catch { /* may already have left */ }
}

export async function stopVideoStream(): Promise<void> {
  if (!activeStream && !pausedState) {
    log.info("No active stream to stop");
    return;
  }

  log.info("Stopping stream...");

  if (activeStream) {
    activeStream.abortController.abort();
    cleanup();
  }

  // Clear paused state and clean up its subtitle temp files
  if (pausedState) {
    if (pausedState.subtitlePath) {
      rm(dirname(pausedState.subtitlePath), { recursive: true, force: true }).catch(() => {});
    }
    pausedState = null;
    log.info("Cleared paused state");
  }

  log.info("Stream stopped");
}
