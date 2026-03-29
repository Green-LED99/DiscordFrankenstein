import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const log = createLogger("FFprobe");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export interface AudioStreamInfo {
  index: number;       // global stream index (for -map 0:{index})
  codec: string;
  language: string;    // ISO 639 code or "und"
  channels: number;
  title?: string;      // e.g., "Stereo", "5.1 Surround"
}

export interface StreamInfo {
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  hasBFrames: boolean;
  isVFR: boolean;
  audioStreams: AudioStreamInfo[];
}

interface FFprobeStream {
  index?: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  has_b_frames?: number;
  channels?: number;
  tags?: {
    language?: string;
    title?: string;
  };
}

interface FFprobeOutput {
  streams: FFprobeStream[];
  format: {
    bit_rate?: string;
  };
}

function parseFraction(frac: string): number {
  const [num, den] = frac.split("/").map(Number);
  if (!den || den === 0) return 0;
  return num / den;
}

export async function probeStream(
  url: string,
  headers?: Record<string, string>,
): Promise<StreamInfo> {
  log.info("Probing stream metadata...");

  const args = [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    "-analyzeduration", "10000000",
    "-probesize", "10000000",
  ];

  // Always send a User-Agent (many CDNs/resolvers block bare requests)
  const ua = headers?.["User-Agent"] ?? DEFAULT_UA;
  args.push("-user_agent", ua);

  // For HLS/authenticated streams, inject additional headers before the URL.
  // -extension_picky 0 allows HLS segments with non-standard extensions (e.g., .txt).
  if (headers) {
    const otherHeaders = Object.entries(headers)
      .filter(([k]) => k !== "User-Agent")
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    if (otherHeaders) args.push("-headers", otherHeaders);
    args.push("-extension_picky", "0");
  }

  args.push(url); // URL must be LAST

  let stdout: string;
  try {
    const result = await execFileAsync("ffprobe", args, { timeout: 30_000 });
    stdout = result.stdout;
  } catch (err) {
    // Include stderr in the error for better diagnostics
    const stderr = (err as { stderr?: string }).stderr?.trim();
    if (stderr) {
      throw new Error(`ffprobe failed: ${stderr}`);
    }
    throw err;
  }

  const data: FFprobeOutput = JSON.parse(stdout);

  const videoStream = data.streams.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new Error("No video stream found in source");
  }

  // Collect all audio streams with metadata
  const audioStreams: AudioStreamInfo[] = data.streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => ({
      index: s.index ?? 0,
      codec: s.codec_name ?? "unknown",
      language: s.tags?.language ?? "und",
      channels: s.channels ?? 2,
      title: s.tags?.title,
    }));

  const firstAudio = audioStreams[0];

  const rFrameRate = parseFraction(videoStream.r_frame_rate || "0/1");
  const avgFrameRate = parseFraction(videoStream.avg_frame_rate || "0/1");
  const fps = Math.round(rFrameRate || avgFrameRate);

  const isVFR =
    rFrameRate > 0 &&
    avgFrameRate > 0 &&
    Math.abs(rFrameRate - avgFrameRate) / rFrameRate > 0.1;

  const hasBFrames = (videoStream.has_b_frames ?? 0) > 0;

  const videoBitrate = videoStream.bit_rate
    ? parseInt(videoStream.bit_rate, 10)
    : data.format.bit_rate
      ? parseInt(data.format.bit_rate, 10)
      : 0;

  const info: StreamInfo = {
    videoCodec: videoStream.codec_name ?? "unknown",
    audioCodec: firstAudio?.codec ?? "unknown",
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps,
    videoBitrate,
    hasBFrames,
    isVFR,
    audioStreams,
  };

  const audioSummary = audioStreams.length > 1
    ? `${audioStreams.length} audio tracks [${audioStreams.map((a) => a.language).join(", ")}]`
    : `audio: ${info.audioCodec}`;

  log.info(
    `Probe result: ${info.videoCodec} ${info.width}x${info.height}@${info.fps}fps, ` +
      `${audioSummary}, bframes: ${info.hasBFrames}, vfr: ${info.isVFR}`
  );
  return info;
}

