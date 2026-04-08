import type { ChatInputCommandInteraction } from "discord.js";
import {
  searchContent,
  resolveEpisode,
  parseImdbInput,
  fetchMeta,
  resolveImdbId,
} from "../../services/cinemeta.js";
import { fetchStreams, getTopStreams } from "../../services/torrentio.js";
import { pickStream } from "./picker.js";
import { createLogger, errStr } from "../../utils/logger.js";

const log = createLogger("LinkCmd");

export async function handleLink(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const title = interaction.options.getString("title", true);
  const type = interaction.options.getString("type", true) as
    | "movie"
    | "series";
  let seasonInput = interaction.options.getInteger("season") ?? undefined;
  let episodeInput = interaction.options.getInteger("episode") ?? undefined;

  const parsed = parseImdbInput(title);

  if (type === "movie") {
    // --- Movie flow ---
    let movie: { id: string; name: string; year: string };

    if (parsed.type === "imdb") {
      await interaction.editReply(
        `Looking up IMDB ID \`${parsed.imdbId}\`...`,
      );
      const resolved = await resolveImdbId(parsed.imdbId);
      if (resolved.type === "episode" || resolved.type === "series") {
        await interaction.editReply(
          `That IMDB ID is a TV ${resolved.type}. Use \`/link type:series\` instead.`,
        );
        return;
      }
      const meta = await fetchMeta(parsed.imdbId, "movie");
      movie = {
        id: meta.id,
        name: meta.name,
        year: meta.releaseInfo ?? meta.year ?? "Unknown",
      };
    } else {
      await interaction.editReply(`Searching for "${title}"...`);
      const results = await searchContent(parsed.query, "movie");
      if (results.length === 0) {
        await interaction.editReply(`No movies found for "${title}".`);
        return;
      }
      const r = results[0];
      movie = {
        id: r.id,
        name: r.name,
        year: r.releaseInfo ?? r.year ?? "Unknown",
      };
    }

    const contentLabel = `${movie.name} (${movie.year})`;
    log.info(`Found: ${contentLabel} [IMDB: ${movie.id}]`);

    await interaction.editReply(
      `Found **${contentLabel}**. Fetching streams...`,
    );
    const streams = await fetchStreams("movie", movie.id);
    const topStreams = getTopStreams(streams);

    if (topStreams.length === 0) {
      await interaction.editReply(
        `No suitable streams found for **${contentLabel}**.`,
      );
      return;
    }

    const selected = await pickStream(interaction, topStreams, contentLabel);
    if (!selected) return;

    await interaction.editReply({
      content: `**${contentLabel}**\n\`\`\`\n${selected.stream.url}\n\`\`\``,
      components: [],
    });
  } else {
    // --- Series flow ---
    let show: { id: string; name: string };

    if (parsed.type === "imdb") {
      await interaction.editReply(
        `Looking up IMDB ID \`${parsed.imdbId}\`...`,
      );
      const resolved = await resolveImdbId(parsed.imdbId);
      if (resolved.type === "episode") {
        seasonInput = resolved.season;
        episodeInput = resolved.episode;
        const meta = await fetchMeta(resolved.imdbId, "series");
        show = { id: meta.id, name: meta.name };
      } else {
        const meta = await fetchMeta(parsed.imdbId, "series");
        show = { id: meta.id, name: meta.name };
      }
    } else {
      await interaction.editReply(`Searching for "${title}"...`);
      const results = await searchContent(parsed.query, "series");
      if (results.length === 0) {
        await interaction.editReply(`No TV series found for "${title}".`);
        return;
      }
      show = results[0];
    }

    log.info(`Found: ${show.name} [IMDB: ${show.id}]`);

    await interaction.editReply(
      `Found **${show.name}**. Resolving episode...`,
    );
    const episode = await resolveEpisode(show.id, seasonInput, episodeInput);
    const episodeLabel = `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;
    const contentLabel = `${show.name} ${episodeLabel} - ${episode.name}`;
    log.info(`Episode: ${episodeLabel} - ${episode.name}`);

    await interaction.editReply(
      `Fetching streams for **${show.name}** ${episodeLabel}...`,
    );
    const streams = await fetchStreams(
      "series",
      show.id,
      episode.season,
      episode.episode,
      episode.unmappedSeason,
    );
    const topStreams = getTopStreams(streams);

    if (topStreams.length === 0) {
      await interaction.editReply(
        `No suitable streams found for **${show.name}** ${episodeLabel}.`,
      );
      return;
    }

    const selected = await pickStream(interaction, topStreams, contentLabel);
    if (!selected) return;

    await interaction.editReply({
      content: `**${contentLabel}**\n\`\`\`\n${selected.stream.url}\n\`\`\``,
      components: [],
    });
  }
}
