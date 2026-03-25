import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { handleInteraction } from "./interactions.js";
import { registerCommands } from "./commands/register.js";

const log = createLogger("Bot");

let botClient: Client | null = null;

export async function initBotClient(): Promise<void> {
  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  botClient.on("interactionCreate", handleInteraction);

  botClient.once("ready", async (client) => {
    log.info(`Bot logged in as ${client.user.tag}`);
    await registerCommands(client);
    log.info("Bot ready");
  });

  await botClient.login(config.botToken);
}

export function getBotClient(): Client {
  if (!botClient) throw new Error("Bot client not initialized");
  return botClient;
}

export async function destroyBotClient(): Promise<void> {
  if (botClient) {
    botClient.destroy();
    botClient = null;
    log.info("Bot client destroyed");
  }
}
