import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { searchMovie, getExternalIds } from "../../services/tmdb.js";
import { fetchStreams, getTopStreams } from "../../services/torrentio.js";
import { startVideoStream } from "../../streamer/stream.js";
import { pickStream } from "./picker.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("MovieCmd");

export async function handleMovie(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const title = interaction.options.getString("title", true);
  const member = interaction.member as GuildMember;

  // Check if user is in a voice channel
  if (!member.voice.channelId) {
    await interaction.editReply("You must be in a voice channel to use this command.");
    return;
  }

  const guildId = interaction.guildId!;
  const channelId = member.voice.channelId;

  // 1. Search TMDB
  await interaction.editReply(`Searching for "${title}"...`);
  const results = await searchMovie(title);
  if (results.length === 0) {
    await interaction.editReply(`No movies found for "${title}".`);
    return;
  }

  const movie = results[0];
  const year = movie.release_date?.substring(0, 4) ?? "Unknown";
  log.info(`Found: ${movie.title} (${year}) [TMDB: ${movie.id}]`);

  // 2. Get IMDB ID
  const imdbId = await getExternalIds(movie.id, "movie");

  // 3. Fetch streams from Torrentio
  await interaction.editReply(
    `Found **${movie.title}** (${year}). Fetching streams...`
  );
  const streams = await fetchStreams("movie", imdbId);
  const topStreams = getTopStreams(streams);

  if (topStreams.length === 0) {
    await interaction.editReply(
      `No suitable streams found for **${movie.title}** (${year}).`
    );
    return;
  }

  // 4. Let user pick a stream
  const contentLabel = `${movie.title} (${year})`;
  const selected = await pickStream(interaction, topStreams, contentLabel);

  if (!selected) {
    return; // Timed out or cancelled
  }

  // 5. Start streaming
  await interaction.editReply({
    content: `Preparing to stream **${contentLabel}**...`,
    components: [],
  });

  try {
    await startVideoStream(guildId, channelId, selected.stream.url);
    await interaction.editReply({
      content: `Now streaming: **${contentLabel}** - ${selected.stream.name}`,
      components: [],
    });
  } catch (err) {
    log.error(`Stream start failed: ${err}`);
    await interaction.editReply({
      content: `Failed to start stream for **${contentLabel}**: ${err instanceof Error ? err.message : "Unknown error"}`,
      components: [],
    });
  }
}
