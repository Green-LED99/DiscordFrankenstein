import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { searchMovie, getExternalIds } from "../../services/tmdb.js";
import { fetchStreams, selectBestStream } from "../../services/torrentio.js";
import { startVideoStream } from "../../streamer/stream.js";
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
  const bestStream = selectBestStream(streams);

  if (!bestStream) {
    await interaction.editReply(
      `No suitable streams found for **${movie.title}** (${year}).`
    );
    return;
  }

  // 4. Start streaming
  await interaction.editReply(
    `Preparing to stream **${movie.title}** (${year})...`
  );

  try {
    await startVideoStream(guildId, channelId, bestStream.url);
    await interaction.editReply(
      `Now streaming: **${movie.title}** (${year}) - ${bestStream.name}`
    );
  } catch (err) {
    log.error(`Stream start failed: ${err}`);
    await interaction.editReply(
      `Failed to start stream for **${movie.title}** (${year}): ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
