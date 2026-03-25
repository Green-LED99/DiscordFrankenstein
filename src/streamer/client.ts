import { Client } from "discord.js-selfbot-v13";
import { Streamer } from "@dank074/discord-video-stream";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("StreamerClient");

let selfbotClient: Client | null = null;
let streamer: Streamer | null = null;

export async function initStreamerClient(): Promise<void> {
  selfbotClient = new Client();
  streamer = new Streamer(selfbotClient);

  await selfbotClient.login(config.userToken);
  log.info(`Selfbot logged in as ${selfbotClient.user?.tag}`);
}

export function getStreamer(): Streamer {
  if (!streamer) throw new Error("Streamer not initialized");
  return streamer;
}

export function getSelfbotClient(): Client {
  if (!selfbotClient) throw new Error("Selfbot client not initialized");
  return selfbotClient;
}

export async function destroyStreamerClient(): Promise<void> {
  if (selfbotClient) {
    selfbotClient.destroy();
    selfbotClient = null;
    streamer = null;
    log.info("Selfbot client destroyed");
  }
}
