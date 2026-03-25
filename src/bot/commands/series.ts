import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import {
  searchTV,
  getExternalIds,
  resolveEpisode,
} from "../../services/tmdb.js";
import { fetchStreams, selectBestStream } from "../../services/torrentio.js";
import { startVideoStream } from "../../streamer/stream.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("SeriesCmd");

export async function handleSeries(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const title = interaction.options.getString("title", true);
  const seasonInput = interaction.options.getInteger("season") ?? undefined;
  const episodeInput = interaction.options.getInteger("episode") ?? undefined;
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
  const results = await searchTV(title);
  if (results.length === 0) {
    await interaction.editReply(`No TV series found for "${title}".`);
    return;
  }

  const show = results[0];
  log.info(`Found: ${show.name} [TMDB: ${show.id}]`);

  // 2. Get IMDB ID
  const imdbId = await getExternalIds(show.id, "tv");

  // 3. Resolve episode (handle random selection)
  await interaction.editReply(
    `Found **${show.name}**. Resolving episode...`
  );

  const episode = await resolveEpisode(show.id, seasonInput, episodeInput);
  const episodeLabel = `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;

  log.info(`Episode: ${episodeLabel} - ${episode.episodeName}`);

  // 4. Fetch streams from Torrentio
  await interaction.editReply(
    `Fetching streams for **${show.name}** ${episodeLabel}...`
  );

  const streams = await fetchStreams(
    "series",
    imdbId,
    episode.season,
    episode.episode
  );
  const bestStream = selectBestStream(streams);

  if (!bestStream) {
    await interaction.editReply(
      `No suitable streams found for **${show.name}** ${episodeLabel}.`
    );
    return;
  }

  // 5. Start streaming
  await interaction.editReply(
    `Preparing to stream **${show.name}** ${episodeLabel} - ${episode.episodeName}...`
  );

  try {
    await startVideoStream(guildId, channelId, bestStream.url);
    await interaction.editReply(
      `Now streaming: **${show.name}** ${episodeLabel} - ${episode.episodeName} (${bestStream.name})`
    );
  } catch (err) {
    log.error(`Stream start failed: ${err}`);
    await interaction.editReply(
      `Failed to start stream for **${show.name}** ${episodeLabel}: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
