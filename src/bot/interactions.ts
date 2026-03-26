import { type Interaction, MessageFlags } from "discord.js";
import { handleMovie } from "./commands/movie.js";
import { handleSeries } from "./commands/series.js";
import { handleStop } from "./commands/stop.js";
import { handleLive } from "./commands/live.js";
import {
  handlePause,
  handlePlay,
  handleSkip,
  handleSeek,
  handleNowPlaying,
} from "./commands/playback.js";
import { createLogger, errStr } from "../utils/logger.js";

const log = createLogger("Interactions");

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  try {
    // Defer reply for all commands since they may take time
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    switch (interaction.commandName) {
      case "movie":
        await handleMovie(interaction);
        break;
      case "series":
        await handleSeries(interaction);
        break;
      case "live":
        await handleLive(interaction);
        break;
      case "pause":
        await handlePause(interaction);
        break;
      case "play":
        await handlePlay(interaction);
        break;
      case "skip":
        await handleSkip(interaction);
        break;
      case "seek":
        await handleSeek(interaction);
        break;
      case "np":
        await handleNowPlaying(interaction);
        break;
      case "stop":
        await handleStop(interaction);
        break;
      default:
        await interaction.editReply("Unknown command.");
    }
  } catch (err) {
    log.error(`Command "${interaction.commandName}" failed: ${errStr(err)}`);
    try {
      await interaction.editReply(
        `An error occurred: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } catch {
      // Interaction may have timed out
    }
  }
}
