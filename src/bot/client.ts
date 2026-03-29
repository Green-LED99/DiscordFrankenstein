import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../utils/config.js";
import { createLogger, errStr } from "../utils/logger.js";
import { handleInteraction } from "./interactions.js";
import { registerCommands, registerCommandsToNewGuild } from "./commands/register.js";

const log = createLogger("Bot");

let botClient: Client | null = null;
let cachedAppId: string | null = null;

export async function initBotClient(): Promise<void> {
  botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  botClient.on("interactionCreate", handleInteraction);
  botClient.on("error", (err: Error) => log.error(`Discord client error: ${err.stack ?? err.message}`));

  botClient.once("ready", (client) => {
    cachedAppId = client.application.id;
    log.info(`Bot logged in as ${client.user.tag}`);
    // Register commands in background — don't block the bot from handling interactions
    registerCommands(client)
      .then(() => log.info("Bot ready"))
      .catch((err) => log.error(`Command registration failed: ${errStr(err)} — bot is still functional with cached commands`));
  });

  botClient.on("guildCreate", (guild) => {
    log.info(`Joined guild: ${guild.name} (${guild.id})`);
    const appId = cachedAppId ?? guild.client.application?.id;
    if (!appId) {
      log.warn(`Cannot register commands in ${guild.name} — application ID not yet available`);
      return;
    }
    registerCommandsToNewGuild(appId, guild.id, guild.name).catch((err) =>
      log.error(`Failed to register commands in new guild ${guild.name}: ${errStr(err)}`),
    );
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
