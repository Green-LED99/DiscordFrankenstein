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
    name: "stop",
    description: "Stop the current stream",
  },
];

export async function registerCommands(client: Client<true>): Promise<void> {
  log.info("Registering slash commands...");
  await client.application.commands.set(commands);
  log.info(`Registered ${commands.length} commands globally`);
}
