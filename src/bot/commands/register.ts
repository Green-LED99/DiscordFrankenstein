import {
  ApplicationCommandOptionType,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Commands");

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: "movie",
    description: "Stream a movie to your voice channel",
    options: [
      {
        name: "title",
        description: 'Movie name (e.g., "F1", "Fight Club")',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: "series",
    description: "Stream a TV series episode to your voice channel",
    options: [
      {
        name: "title",
        description: 'Series name (e.g., "Family Guy")',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: "season",
        description: "Season number (random if not specified)",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
      },
      {
        name: "episode",
        description: "Episode number (random if not specified)",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
      },
    ],
  },
  {
    name: "live",
    description: "Stream a live game to your voice channel",
    options: [
      {
        name: "team",
        description: 'Team or sport (e.g., "White Sox", "Lakers", "NFL")',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: "pause",
    description: "Pause the current stream",
  },
  {
    name: "play",
    description: "Resume the paused stream",
  },
  {
    name: "skip",
    description: "Skip forward or backward in the stream",
    options: [
      {
        name: "seconds",
        description: "Seconds to skip (negative to rewind, e.g., -30)",
        type: ApplicationCommandOptionType.Integer,
        required: true,
      },
    ],
  },
  {
    name: "seek",
    description: "Jump to a specific time in the stream",
    options: [
      {
        name: "hours",
        description: "Hours",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 0,
      },
      {
        name: "minutes",
        description: "Minutes",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 0,
      },
      {
        name: "seconds",
        description: "Seconds",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 0,
      },
    ],
  },
  {
    name: "np",
    description: "Show what's currently playing and the timestamp",
  },
  {
    name: "next",
    description: "Play the next episode in the series",
  },
  {
    name: "autoplay",
    description: "Toggle auto-play next episode when current one ends",
  },
  {
    name: "stop",
    description: "Stop the current stream",
  },
];

export async function registerCommands(client: Client<true>): Promise<void> {
  log.info("Clearing stale global commands...");
  await client.application.commands.set([]);
  log.info("Global commands cleared");

  const guilds = client.guilds.cache;

  // Clear existing guild commands first
  log.info(`Clearing guild commands from ${guilds.size} guild(s)...`);
  for (const [guildId, guild] of guilds) {
    try {
      await client.application.commands.set([], guildId);
      log.info(`Cleared commands in ${guild.name}`);
    } catch (err) {
      log.warn(`Failed to clear commands in ${guild.name}: ${err}`);
    }
  }

  log.info(`Registering slash commands to ${guilds.size} guild(s)...`);
  for (const [guildId, guild] of guilds) {
    try {
      await client.application.commands.set(commands, guildId);
      log.info(`Registered ${commands.length} commands in ${guild.name}`);
    } catch (err) {
      log.warn(`Failed to register commands in ${guild.name}: ${err}`);
    }
  }
  log.info("Guild command registration complete");
}
