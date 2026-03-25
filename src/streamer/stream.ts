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
}

let activeStream: ActiveStream | null = null;

export function isStreaming(): boolean {
  return activeStream !== null;
}

export function getActiveStreamGuild(): string | null {
  return activeStream?.guildId ?? null;
}

export async function startVideoStream(
  guildId: string,
  channelId: string,
  streamUrl: string
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
  const maxWidth = config.maxResolution === 720 ? 1280 : 854;
  const maxHeight = config.maxResolution;
  const copyMode = isCopyModeEligible(sourceInfo, maxWidth, maxHeight, config.maxFps);

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

  // Handle stream end
  Promise.allSettled([promise, playPromise]).then(([encodeResult, playResult]) => {
    if (encodeResult.status === "rejected" && !abortController.signal.aborted) {
      log.error(`FFmpeg error: ${encodeResult.reason}`);
    }
    if (playResult.status === "rejected" && !abortController.signal.aborted) {
      log.error(`Playback error: ${playResult.reason}`);
    }
    if (!abortController.signal.aborted) {
      log.info("Stream ended naturally");
      cleanup();
    }
  });

  log.info("Stream started successfully");
}

function cleanup(): void {
  stopSyncMonitor();
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
