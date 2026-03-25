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
    args.push("-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll");
  } else if (hwAccel === "vaapi") {
    args.push("-c:v", "h264_vaapi");
  } else {
    args.push("-c:v", "libx264", "-preset", preset, "-tune", "zerolatency");
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
    width: config.maxResolution === 720 ? 1280 : 854,
    height: config.maxResolution === 720 ? 720 : 480,
    fps: config.maxFps,
    bitrate: config.videoBitrate,
    bitrateMax: Math.round(config.videoBitrate * 1.4),
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
    if (speed >= 0.98) {
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

        if (speed >= 0.98) {
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

export function getEncoderSettings(tuned: TunedSettings): EncoderSettingsGetter {
  if (tuned.hwAccel === "nvidia") {
    return Encoders.nvenc();
  }
  if (tuned.hwAccel === "vaapi") {
    return Encoders.vaapi();
  }
  return Encoders.software({
    x264: { preset: tuned.preset, tune: "zerolatency" },
    x265: { preset: tuned.preset, tune: "zerolatency" },
  });
}

export function buildStreamOptions(
  sourceInfo: StreamInfo,
  tuned: TunedSettings,
  copyMode: boolean
): Partial<PrepareStreamOptions> {
  if (copyMode) {
    log.info("Using copy mode (no transcoding)");
    return {
      noTranscoding: true,
      width: sourceInfo.width,
      height: sourceInfo.height,
      frameRate: sourceInfo.fps,
      videoCodec: "H264",
      includeAudio: true,
      bitrateAudio: 128,
      bitrateVideo: 0,
      bitrateVideoMax: 0,
      hardwareAcceleratedDecoding: false,
      minimizeLatency: false,
      encoder: Encoders.software(),
    };
  }

  log.info(
    `Transcoding to ${tuned.width}x${tuned.height}@${tuned.fps}fps ` +
      `(${tuned.preset}, ${tuned.hwAccel}, ${tuned.bitrate}kbps)`
  );

  return {
    noTranscoding: false,
    width: tuned.width,
    height: tuned.height,
    frameRate: tuned.fps,
    videoCodec: "H264",
    bitrateVideo: tuned.bitrate,
    bitrateVideoMax: tuned.bitrateMax,
    bitrateAudio: 128,
    includeAudio: true,
    hardwareAcceleratedDecoding: tuned.hwAccel !== "none",
    minimizeLatency: false,
    encoder: getEncoderSettings(tuned),
    customFfmpegFlags: [
      "-async", "1",
      "-vsync", "cfr",
      "-g", `${tuned.fps * 2}`,
      "-keyint_min", `${tuned.fps * 2}`,
    ],
  };
}
