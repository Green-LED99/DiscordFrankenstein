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
  return process.env[name] || fallback;
}

export const config = {
  botToken: requireEnv("BOT_TOKEN"),
  userToken: requireEnv("USER_TOKEN"),
  tmdbApiKey: requireEnv("TMDB_API_KEY"),
  stremioAddonUrl: requireEnv("STREMIO_ADDON_URL"),

  // AMP-overridable streaming settings
  maxResolution: parseInt(optionalEnv("MAX_RESOLUTION", "720"), 10),
  maxFps: parseInt(optionalEnv("MAX_FPS", "30"), 10),
  videoBitrate: parseInt(optionalEnv("VIDEO_BITRATE", "2500"), 10),
  hardwareAccel: optionalEnv("HARDWARE_ACCEL", "auto") as
    | "auto"
    | "nvidia"
    | "vaapi"
    | "none",
} as const;
