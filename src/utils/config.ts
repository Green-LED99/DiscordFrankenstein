import dotenv from "dotenv";
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[FATAL] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.error(`[FATAL] Invalid integer for ${name}: "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

const VALID_HW_ACCEL = ["auto", "nvidia", "vaapi", "none"] as const;
type HardwareAccel = (typeof VALID_HW_ACCEL)[number];

function parseHwAccel(): HardwareAccel {
  const raw = optionalEnv("HARDWARE_ACCEL", "auto");
  if (!VALID_HW_ACCEL.includes(raw as HardwareAccel)) {
    console.error(
      `[FATAL] Invalid HARDWARE_ACCEL: "${raw}". Must be one of: ${VALID_HW_ACCEL.join(", ")}`
    );
    process.exit(1);
  }
  return raw as HardwareAccel;
}

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  userToken: requireEnv("USER_TOKEN"),
  stremioAddonUrl: requireEnv("STREMIO_ADDON_URL"),

  // Optional: TMDB fallback when Cinemeta has no results
  tmdbApiKey: optionalEnv("TMDB_API_KEY", ""),

  // Streaming settings with validation
  maxResolution: parseIntEnv("MAX_RESOLUTION", 720),
  maxFps: parseIntEnv("MAX_FPS", 30),
  videoBitrate: parseIntEnv("VIDEO_BITRATE", 1500),
  hardwareAccel: parseHwAccel(),
} as const;
