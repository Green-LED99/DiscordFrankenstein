import { config } from "./utils/config.js";
import { createLogger, errStr } from "./utils/logger.js";
import { autoTune } from "./streamer/encoder.js";
import { initStreamerClient, destroyStreamerClient } from "./streamer/client.js";
import { initBotClient, destroyBotClient } from "./bot/client.js";
import { stopVideoStream } from "./streamer/stream.js";

const log = createLogger("Main");

async function shutdown(): Promise<void> {
  log.info("Shutting down...");
  try {
    await stopVideoStream();
  } catch {
    // Best-effort
  }
  try { await destroyStreamerClient(); } catch { /* best-effort */ }
  try { await destroyBotClient(); } catch { /* best-effort */ }
  log.info("Shutdown complete");
  process.exit(0);
}

async function main(): Promise<void> {
  log.info("DiscordFrankenstein starting...");

  // Validate config is loaded (will exit if missing required vars)
  log.info("Configuration loaded");

  // Run auto-tuner to find optimal FFmpeg settings
  log.info("Running encoder auto-tune...");
  const tuned = await autoTune();
  log.info(
    `Auto-tune complete: ${tuned.width}x${tuned.height}@${tuned.fps}fps ` +
      `preset=${tuned.preset} hwaccel=${tuned.hwAccel}`
  );

  // Initialize selfbot client (must be first - bot commands depend on it)
  log.info("Initializing streamer client...");
  await initStreamerClient();

  // Initialize bot client (registers commands on ready)
  log.info("Initializing bot client...");
  await initBotClient();

  // Graceful shutdown handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // This line is matched by AMP's AppReadyRegex
  log.info("Bot ready");
}

main().catch((err: unknown) => {
  log.error(`Fatal error: ${errStr(err)}`);
  process.exit(1);
});
