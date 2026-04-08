import { type Interaction, MessageFlags } from "discord.js";
import { handleMovie } from "./commands/movie.js";
import { handleSeries } from "./commands/series.js";
import { handleStop } from "./commands/stop.js";
import { handleLive } from "./commands/live.js";
import { handleLink } from "./commands/link.js";
import {
  handlePause,
  handlePlay,
  handleSkip,
  handleSeek,
  handleNowPlaying,
  handleNext,
  handleAutoplay,
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
    // Defer reply ASAP — Discord gives only 3 seconds from interaction creation.
    // If deferReply fails (token expired due to network/gateway lag), log it but
    // still attempt the command so the bot doesn't silently ignore user input.
    let deferred = false;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      deferred = true;
    } catch (deferErr) {
      log.warn(`deferReply failed for "${interaction.commandName}" (interaction may have expired): ${errStr(deferErr)}`);
    }

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
      case "link":
        await handleLink(interaction);
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
      case "next":
        await handleNext(interaction);
        break;
      case "autoplay":
        await handleAutoplay(interaction);
        break;
      case "stop":
        await handleStop(interaction);
        break;
      default:
        if (deferred) await interaction.editReply("Unknown command.");
    }
  } catch (err) {
    log.error(`Command "${interaction.commandName}" failed: ${errStr(err)}`);
    try {
      await interaction.editReply(
        `An error occurred: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } catch {
      // Interaction may have timed out — editReply won't work
    }
  }
}
