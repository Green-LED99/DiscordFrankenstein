import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Encoders, type EncoderSettingsGetter } from "@dank074/discord-video-stream";
import type { PrepareStreamOptions } from "@dank074/discord-video-stream";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import type { StreamInfo } from "../services/ffprobe.js";

const execFileAsync = promisify(execFile);
const log = createLogger("Encoder");

type X264Preset =
  | "ultrafast"
  | "superfast"
  | "veryfast"
  | "faster"
  | "fast"
  | "medium"
  | "slow";

interface TunedSettings {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  bitrateMax: number;
  preset: X264Preset;
  hwAccel: "nvidia" | "vaapi" | "none";
}

let cachedSettings: TunedSettings | null = null;

async function detectHardwareAccel(): Promise<"nvidia" | "vaapi" | "none"> {
  if (config.hardwareAccel !== "auto") {
    return config.hardwareAccel;
  }

  try {
    const { stdout } = await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-hwaccels",
    ]);
    if (/cuda|nvenc/i.test(stdout)) {
      log.info("Detected NVIDIA hardware acceleration");
      return "nvidia";
    }
    if (/vaapi/i.test(stdout)) {
      log.info("Detected VAAPI hardware acceleration");
      return "vaapi";
    }
  } catch {
    log.warn("Could not detect hardware acceleration, using software encoding");
  }
  return "none";
}

async function runBenchmark(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  preset: X264Preset,
  hwAccel: "nvidia" | "vaapi" | "none"
): Promise<number> {
  const args: string[] = [
    "-f", "lavfi",
    "-i", `testsrc2=duration=5:size=${width}x${height}:rate=${fps}`,
    "-f", "lavfi",
    "-i", "sine=frequency=440:duration=5",
  ];

  if (hwAccel === "nvidia") {
    args.push("-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq");
  } else if (hwAccel === "vaapi") {
    args.push("-c:v", "h264_vaapi");
  } else {
    args.push("-c:v", "libx264", "-preset", preset);
  }

  args.push(
    "-b:v", `${bitrate}k`,
    "-maxrate", `${Math.round(bitrate * 1.4)}k`,
    "-c:a", "libopus",
    "-b:a", "128k",
    "-r", `${fps}`,
    "-g", `${fps * 2}`,
    "-f", "null",
    process.platform === "win32" ? "NUL" : "/dev/null"
  );

  try {
    const { stderr } = await execFileAsync("ffmpeg", args, { timeout: 30_000 });
    // Parse speed from FFmpeg output (e.g., "speed=1.23x")
    const speedMatch = stderr.match(/speed=\s*([\d.]+)x/g);
    if (speedMatch && speedMatch.length > 0) {
      const lastSpeed = speedMatch[speedMatch.length - 1];
      const value = parseFloat(lastSpeed.match(/[\d.]+/)![0]);
      return value;
    }
  } catch (err) {
    log.warn(`Benchmark failed: ${err instanceof Error ? err.message : err}`);
  }
  return 0;
}

export async function autoTune(): Promise<TunedSettings> {
  if (cachedSettings) return cachedSettings;

  log.info("Starting auto-tuning...");

  const hwAccel = await detectHardwareAccel();
  const presets: X264Preset[] = ["medium", "fast", "faster", "veryfast", "superfast", "ultrafast"];
  const resolutions: [number, number][] = [
    [1280, 720],
    [854, 480],
  ];
  const fpsOptions = [30, 24];

  let bestSettings: TunedSettings = {
    width: { 1080: 1920, 720: 1280, 480: 854 }[config.maxResolution] ?? 1280,
    height: config.maxResolution,
    fps: config.maxFps,
    bitrate: config.videoBitrate,
    bitrateMax: Math.round(config.videoBitrate * 1.5),
    preset: "ultrafast",
    hwAccel,
  };

  // For hardware encoders, just verify they work
  if (hwAccel !== "none") {
    const speed = await runBenchmark(
      bestSettings.width,
      bestSettings.height,
      bestSettings.fps,
      bestSettings.bitrate,
      "medium",
      hwAccel
    );
    if (speed >= 2.0) {
      bestSettings.preset = "medium";
      log.info(
        `Hardware encoder works: ${hwAccel} at ${bestSettings.width}x${bestSettings.height}@${bestSettings.fps}fps (speed: ${speed.toFixed(2)}x)`
      );
      cachedSettings = bestSettings;
      return bestSettings;
    }
    log.warn("Hardware encoder too slow, falling back to software");
    bestSettings.hwAccel = "none";
  }

  // Software encoder: find best preset that maintains real-time speed
  for (const [w, h] of resolutions) {
    for (const fps of fpsOptions) {
      for (const preset of presets) {
        const speed = await runBenchmark(w, h, fps, bestSettings.bitrate, preset, "none");
        log.info(`Benchmark: ${w}x${h}@${fps}fps preset=${preset} -> speed=${speed.toFixed(2)}x`);

        if (speed >= 2.0) {
          bestSettings = {
            ...bestSettings,
            width: w,
            height: h,
            fps,
            preset,
            hwAccel: "none",
          };
          log.info(
            `Auto-tune result: ${w}x${h}@${fps}fps preset=${preset} (speed: ${speed.toFixed(2)}x)`
          );
          cachedSettings = bestSettings;
          return bestSettings;
        }
      }
    }
  }

  // Fallback: ultrafast at lowest settings
  log.warn("Auto-tune could not find adequate settings, using ultrafast 480p@24fps");
  bestSettings = {
    ...bestSettings,
    width: 854,
    height: 480,
    fps: 24,
    preset: "ultrafast",
    hwAccel: "none",
  };
  cachedSettings = bestSettings;
  return bestSettings;
}

// Map x264 presets to NVENC presets (quality-matched)
const NVENC_PRESET_MAP: Record<X264Preset, "p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7"> = {
  ultrafast: "p1",
  superfast: "p2",
  veryfast: "p3",
  faster: "p3",
  fast: "p4",
  medium: "p4",
  slow: "p5",
};

export function getEncoderSettings(tuned: TunedSettings): EncoderSettingsGetter {
  if (tuned.hwAccel === "nvidia") {
    const nvPreset = NVENC_PRESET_MAP[tuned.preset] ?? "p4";
    log.info(`NVENC encoder: preset ${nvPreset} (from x264 "${tuned.preset}")`);
    return Encoders.nvenc({ preset: nvPreset });
  }
  if (tuned.hwAccel === "vaapi") {
    return Encoders.vaapi();
  }
  // Use autoTune's chosen preset — it benchmarked this machine and picked
  // the highest quality preset that runs at >=2x realtime.
  // Do NOT add tune: "zerolatency" — causes frame freezing (upstream Issue #39).
  log.info(`Software encoder: x264 preset "${tuned.preset}"`);
  return Encoders.software({
    x264: { preset: tuned.preset },
    x265: { preset: tuned.preset },
  });
}


export function buildStreamOptions(
  sourceInfo: StreamInfo,
  tuned: TunedSettings,
  audioStreamIndex?: number,
  subtitlePath?: string,
  headers?: Record<string, string>,
  seekSeconds?: number,
): Partial<PrepareStreamOptions> {
  // Use source framerate if within limits, avoiding 24→30 judder from 3:2 pulldown.
  // Only upscale fps if source is below a minimum threshold.
  const outputFps = Math.min(sourceInfo.fps > 0 ? sourceInfo.fps : tuned.fps, tuned.fps);

  log.info(
    `Transcoding to ${tuned.width}x${tuned.height}@${outputFps}fps ` +
      `(${tuned.preset}, ${tuned.hwAccel}, ${tuned.bitrate}kbps)`
  );

  // Build custom FFmpeg flags
  const customFfmpegFlags: string[] = [
    "-max_delay", "0",
    "-flush_packets", "1",
    "-bufsize:v", `${tuned.bitrate}k`,
    "-profile:v", "baseline",
    "-level:v", "3.1",
    "-af", "aresample=async=4:first_pts=0,volume@internal_lib=1.0",
  ];

  // Audio + subtitle support is handled by the patched library (newApi.js).
  // We pass subtitlePath and audioStreamIndex as extra options that the
  // patched prepareStream reads directly.
  if (audioStreamIndex !== undefined) {
    log.info(`Audio stream index: ${audioStreamIndex}`);
  }
  if (subtitlePath) {
    log.info(`Burning subtitles from: ${subtitlePath}`);
  }

  // The patched library reads subtitlePath and audioStreamIndex from options
  const extraOptions: Record<string, unknown> = {};
  if (subtitlePath) extraOptions.subtitlePath = subtitlePath;
  if (audioStreamIndex !== undefined) extraOptions.audioStreamIndex = audioStreamIndex;

  // Seek support: -ss before -i = fast keyframe seek
  const customInputOptions: string[] = [];
  if (seekSeconds !== undefined && seekSeconds > 0) {
    customInputOptions.push("-ss", seekSeconds.toFixed(3));
    log.info(`Seeking to ${seekSeconds.toFixed(1)}s`);
  }

  return {
    noTranscoding: false,
    width: tuned.width,
    height: tuned.height,
    frameRate: outputFps,
    videoCodec: "H264",
    bitrateVideo: tuned.bitrate,
    bitrateVideoMax: tuned.bitrateMax,
    bitrateAudio: 128,
    includeAudio: true,
    hardwareAcceleratedDecoding: tuned.hwAccel !== "none",
    encoder: getEncoderSettings(tuned),
    customFfmpegFlags,
    ...(customInputOptions.length > 0 ? { customInputOptions } : {}),
    ...(headers ? { customHeaders: headers } : {}),
    ...extraOptions,
  };
}
