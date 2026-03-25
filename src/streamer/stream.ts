import { prepareStream, playStream } from "@dank074/discord-video-stream";
import type ffmpeg from "fluent-ffmpeg";
import { getStreamer } from "./client.js";
import { autoTune, buildStreamOptions } from "./encoder.js";
import { probeStream, isCopyModeEligible } from "../services/ffprobe.js";
import { startSyncMonitor, stopSyncMonitor } from "../utils/sync.js";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Stream");

interface ActiveStream {
  command: ffmpeg.FfmpegCommand;
  guildId: string;
  channelId: string;
  abortController: AbortController;
  startedAt: number;
  copyMode: boolean;
  streamUrl: string;
}

let activeStream: ActiveStream | null = null;
// Prevent infinite retry loops
let retryingTranscode = false;

export function isStreaming(): boolean {
  return activeStream !== null;
}

export function getActiveStreamGuild(): string | null {
  return activeStream?.guildId ?? null;
}

export async function startVideoStream(
  guildId: string,
  channelId: string,
  streamUrl: string,
  forceCopyMode?: boolean
): Promise<void> {
  // Stop any existing stream first
  if (activeStream) {
    log.info("Stopping existing stream before starting new one");
    await stopVideoStream();
  }

  const streamer = getStreamer();

  // 1. Probe the source
  log.info("Probing source stream...");
  const sourceInfo = await probeStream(streamUrl);

  // 2. Get tuned settings
  const tuned = await autoTune();

  // 3. Determine copy vs transcode
  const resolutionMap: Record<number, number> = { 1080: 1920, 720: 1280, 480: 854 };
  const maxWidth = resolutionMap[config.maxResolution] ?? 1280;
  const maxHeight = config.maxResolution;
  const copyMode =
    forceCopyMode === undefined
      ? isCopyModeEligible(sourceInfo, maxWidth, maxHeight, config.maxFps)
      : forceCopyMode;

  // 4. Build stream options
  const options = buildStreamOptions(sourceInfo, tuned, copyMode);

  // 5. Join voice channel
  log.info(`Joining voice channel ${channelId} in guild ${guildId}`);
  await streamer.joinVoice(guildId, channelId);

  // 6. Prepare FFmpeg stream
  const abortController = new AbortController();
  log.info(`Preparing stream from: ${streamUrl.substring(0, 80)}...`);
  const { command, output, promise } = prepareStream(
    streamUrl,
    options,
    abortController.signal
  );

  activeStream = {
    command,
    guildId,
    channelId,
    abortController,
    startedAt: Date.now(),
    copyMode,
    streamUrl,
  };

  // 7. Monitor A/V sync via FFmpeg stderr
  const ffmpegProcess = (command as unknown as { _currentProcess?: { stderr?: NodeJS.ReadableStream } })
    ._currentProcess;
  if (ffmpegProcess?.stderr) {
    startSyncMonitor(ffmpegProcess.stderr, () => {
      log.warn("A/V drift detected - encoder may be struggling");
    });
  }

  // 8. Start Go Live playback
  log.info("Starting Go Live stream");
  const playPromise = playStream(output, streamer, {
    type: "go-live",
  }, abortController.signal);

  // Capture values NOW before the async gap — activeStream may be nulled
  // by stopVideoStream() before the Promise.allSettled callback fires.
  const streamStartedAt = Date.now();
  const streamWasCopyMode = copyMode;
  const streamGuildId = guildId;
  const streamChannelId = channelId;

  // Handle stream end
  Promise.allSettled([promise, playPromise]).then(async ([encodeResult, playResult]) => {
    if (abortController.signal.aborted) return;

    const elapsed = Date.now() - streamStartedAt;
    const wasCopyMode = streamWasCopyMode;
    const url = streamUrl;
    const guild = streamGuildId;
    const channel = streamChannelId;

    const encFailed = encodeResult.status === "rejected";
    const playFailed = playResult.status === "rejected";

    if (encFailed) {
      log.error(`FFmpeg error: ${encodeResult.reason}`);
    }
    if (playFailed) {
      log.error(`Playback error: ${playResult.reason}`);
    }

    // If copy mode failed (at any point), retry with transcoding.
    // The NUT muxer's h264_metadata BSF is incompatible with many Torrentio
    // streams, causing "Invalid NAL unit size" errors even minutes in.
    if ((encFailed || playFailed) && wasCopyMode && !retryingTranscode) {
      log.warn(
        `Copy mode failed after ${elapsed}ms — retrying with transcoding`
      );
      cleanup();

      retryingTranscode = true;
      try {
        await startVideoStream(guild, channel, url, false);
      } catch (err) {
        log.error(`Transcode retry also failed: ${err}`);
        cleanup();
      } finally {
        retryingTranscode = false;
      }
      return;
    }

    log.info("Stream ended naturally");
    cleanup();
  });

  log.info("Stream started successfully");
}

function cleanup(): void {
  stopSyncMonitor();

  // Always ensure we leave voice and stop stream on any end (natural or error)
  const streamer = getStreamer();
  try {
    streamer.stopStream();
  } catch {
    // May already be stopped
  }
  try {
    streamer.leaveVoice();
  } catch {
    // May already have left
  }

  activeStream = null;
}

export async function stopVideoStream(): Promise<void> {
  if (!activeStream) {
    log.info("No active stream to stop");
    return;
  }

  log.info("Stopping stream...");
  const streamer = getStreamer();

  // Abort FFmpeg and playback
  activeStream.abortController.abort();

  // Stop stream and leave voice
  try {
    streamer.stopStream();
  } catch {
    // May already be stopped
  }
  try {
    streamer.leaveVoice();
  } catch {
    // May already have left
  }

  cleanup();
  log.info("Stream stopped");
}
