import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("FFprobe");

export interface StreamInfo {
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
}

interface FFprobeOutput {
  streams: Array<{
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    bit_rate?: string;
    avg_frame_rate?: string;
  }>;
  format: {
    bit_rate?: string;
  };
}

function parseFraction(frac: string): number {
  const [num, den] = frac.split("/").map(Number);
  if (!den || den === 0) return 0;
  return num / den;
}

export async function probeStream(url: string): Promise<StreamInfo> {
  log.info("Probing stream metadata...");

  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      "-analyzeduration", "5000000",
      "-probesize", "5000000",
      url,
    ],
    { timeout: 30_000 }
  );

  const data: FFprobeOutput = JSON.parse(stdout);

  const videoStream = data.streams.find((s) => s.codec_type === "video");
  const audioStream = data.streams.find((s) => s.codec_type === "audio");

  if (!videoStream) {
    throw new Error("No video stream found in source");
  }

  const fpsStr = videoStream.r_frame_rate || videoStream.avg_frame_rate || "0/1";
  const fps = Math.round(parseFraction(fpsStr));

  const videoBitrate = videoStream.bit_rate
    ? parseInt(videoStream.bit_rate, 10)
    : data.format.bit_rate
      ? parseInt(data.format.bit_rate, 10)
      : 0;

  const info: StreamInfo = {
    videoCodec: videoStream.codec_name ?? "unknown",
    audioCodec: audioStream?.codec_name ?? "unknown",
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps,
    videoBitrate,
  };

  log.info(
    `Probe result: ${info.videoCodec} ${info.width}x${info.height}@${info.fps}fps, audio: ${info.audioCodec}`
  );
  return info;
}

export function isCopyModeEligible(
  info: StreamInfo,
  maxWidth: number,
  maxHeight: number,
  maxFps: number
): boolean {
  const eligible =
    info.videoCodec === "h264" &&
    info.width <= maxWidth &&
    info.height <= maxHeight &&
    info.fps <= maxFps;

  log.info(
    `Copy mode ${eligible ? "eligible" : "not eligible"}: ` +
      `codec=${info.videoCodec} ${info.width}x${info.height}@${info.fps}fps ` +
      `(max: ${maxWidth}x${maxHeight}@${maxFps}fps)`
  );
  return eligible;
}
