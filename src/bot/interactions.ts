import type { Interaction } from "discord.js";
import { handleMovie } from "./commands/movie.js";
import { handleSeries } from "./commands/series.js";
import { handleStop } from "./commands/stop.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Interactions");

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  // Defer reply for all commands since they may take time
  await interaction.deferReply({ ephemeral: true });

  try {
    switch (interaction.commandName) {
      case "movie":
        await handleMovie(interaction);
        break;
      case "series":
        await handleSeries(interaction);
        break;
      case "stop":
        await handleStop(interaction);
        break;
      default:
        await interaction.editReply("Unknown command.");
    }
  } catch (err) {
    log.error(`Command "${interaction.commandName}" failed: ${err}`);
    try {
      await interaction.editReply(
        `An error occurred: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } catch {
      // Interaction may have timed out
    }
  }
}
