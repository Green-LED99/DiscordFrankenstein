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
  hasBFrames: boolean;
  isVFR: boolean;
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
    has_b_frames?: number;
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
      "-analyzeduration", "2000000",
      "-probesize", "2000000",
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

  const rFrameRate = parseFraction(videoStream.r_frame_rate || "0/1");
  const avgFrameRate = parseFraction(videoStream.avg_frame_rate || "0/1");
  const fps = Math.round(rFrameRate || avgFrameRate);

  // Detect VFR: if r_frame_rate and avg_frame_rate differ by >10%, source is likely VFR.
  // r_frame_rate is the "real" base rate, avg_frame_rate is the average over the analyzed
  // portion. Significant divergence indicates variable frame timing.
  const isVFR =
    rFrameRate > 0 &&
    avgFrameRate > 0 &&
    Math.abs(rFrameRate - avgFrameRate) / rFrameRate > 0.1;

  // Detect B-frames. The library warns: "B-frames disabled. Failure to do so will
  // result in a glitchy stream." B-frames cause PTS != DTS (non-monotonic PTS in
  // decode order) which breaks PTS-based pacing.
  const hasBFrames = (videoStream.has_b_frames ?? 0) > 0;

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
    hasBFrames,
    isVFR,
  };

  log.info(
    `Probe result: ${info.videoCodec} ${info.width}x${info.height}@${info.fps}fps, ` +
      `audio: ${info.audioCodec}, bframes: ${info.hasBFrames}, vfr: ${info.isVFR}`
  );
  return info;
}

export function isCopyModeEligible(
  info: StreamInfo,
  maxWidth: number,
  maxHeight: number,
  maxFps: number
): boolean {
  // Copy mode requires ALL of:
  // - H264 codec
  // - Resolution within limits
  // - FPS within limits
  // - No B-frames (B-frames cause PTS != DTS, breaking PTS-based pacing)
  // - Not VFR (variable frame rate causes uneven pacing in copy mode)
  const eligible =
    info.videoCodec === "h264" &&
    info.width <= maxWidth &&
    info.height <= maxHeight &&
    info.fps <= maxFps &&
    !info.hasBFrames &&
    !info.isVFR;

  const reasons: string[] = [];
  if (info.videoCodec !== "h264") reasons.push(`codec=${info.videoCodec}`);
  if (info.width > maxWidth || info.height > maxHeight)
    reasons.push(`resolution=${info.width}x${info.height}`);
  if (info.fps > maxFps) reasons.push(`fps=${info.fps}`);
  if (info.hasBFrames) reasons.push("has B-frames");
  if (info.isVFR) reasons.push("variable frame rate");

  log.info(
    eligible
      ? `Copy mode eligible: ${info.videoCodec} ${info.width}x${info.height}@${info.fps}fps`
      : `Copy mode not eligible: ${reasons.join(", ")} (max: ${maxWidth}x${maxHeight}@${maxFps}fps)`
  );
  return eligible;
}
