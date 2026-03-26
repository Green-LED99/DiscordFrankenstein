import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { searchContent, resolveEpisode } from "../../services/cinemeta.js";
import { fetchStreams, getTopStreams } from "../../services/torrentio.js";
import { fetchSubtitles, downloadSubtitle } from "../../services/opensubtitles.js";
import { probeStream } from "../../services/ffprobe.js";
import { startVideoStream, isAutoplayEnabled } from "../../streamer/stream.js";
import { pickStream } from "./picker.js";
import { pickAudioTrack, pickSubtitleTrack } from "./options.js";
// Channel tracking now handled automatically by stream.ts
import { createLogger, errStr } from "../../utils/logger.js";

const log = createLogger("SeriesCmd");

export async function handleSeries(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const title = interaction.options.getString("title", true);
  const seasonInput = interaction.options.getInteger("season") ?? undefined;
  const episodeInput = interaction.options.getInteger("episode") ?? undefined;
  const member = interaction.member;

  if (!member || !("voice" in member)) {
    await interaction.editReply("Could not determine your voice channel.");
    return;
  }

  if (!(member as GuildMember).voice.channelId) {
    await interaction.editReply("You must be in a voice channel to use this command.");
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const channelId = (member as GuildMember).voice.channelId!;

  // 1. Search Cinemeta
  await interaction.editReply(`Searching for "${title}"...`);
  const results = await searchContent(title, "series");
  if (results.length === 0) {
    await interaction.editReply(`No TV series found for "${title}".`);
    return;
  }

  const show = results[0];
  log.info(`Found: ${show.name} [IMDB: ${show.id}]`);

  // 2. Resolve episode
  await interaction.editReply(`Found **${show.name}**. Resolving episode...`);
  const episode = await resolveEpisode(show.id, seasonInput, episodeInput);
  const episodeLabel = `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;
  log.info(`Episode: ${episodeLabel} - ${episode.name}`);

  // 3. Fetch streams from Torrentio
  await interaction.editReply(
    `Fetching streams for **${show.name}** ${episodeLabel}...`
  );
  const streams = await fetchStreams("series", show.id, episode.season, episode.episode);
  const topStreams = getTopStreams(streams);

  if (topStreams.length === 0) {
    await interaction.editReply(
      `No suitable streams found for **${show.name}** ${episodeLabel}.`
    );
    return;
  }

  // 4. Let user pick a stream
  const contentLabel = `${show.name} ${episodeLabel} - ${episode.name}`;
  const selected = await pickStream(interaction, topStreams, contentLabel);
  if (!selected) return;

  // 5. Probe the selected stream for audio tracks
  await interaction.editReply({
    content: `Analyzing **${show.name}** ${episodeLabel}...`,
    components: [],
  });

  let audioStreamIndex: number | undefined;
  let subtitlePath: string | undefined;
  let sourceInfo;

  try {
    sourceInfo = await probeStream(selected.stream.url);

    // 6. Audio track selection (only if multiple audio streams)
    const audioIdx = await pickAudioTrack(interaction, sourceInfo.audioStreams);
    if (audioIdx !== null) audioStreamIndex = audioIdx;

    // 7. Subtitle selection from OpenSubtitles
    const subtitles = await fetchSubtitles("series", show.id, episode.season, episode.episode);
    const selectedSub = await pickSubtitleTrack(interaction, subtitles);
    if (selectedSub) {
      subtitlePath = await downloadSubtitle(selectedSub);
    }
  } catch (err) {
    log.warn(`Audio/subtitle selection failed, continuing without: ${errStr(err)}`);
  }

  // 8. Start streaming (pass sourceInfo to avoid re-probing)
  await interaction.editReply({
    content: `Preparing to stream **${show.name}** ${episodeLabel}...`,
    components: [],
  });

  try {
    await startVideoStream(guildId, channelId, selected.stream.url, audioStreamIndex, subtitlePath, sourceInfo, undefined, false, undefined, contentLabel, {
      showId: show.id,
      showName: show.name,
      season: episode.season,
      episode: episode.episode,
    });
    await interaction.editReply({
      content: `Now streaming: **${show.name}** ${episodeLabel} - ${episode.name}`,
      components: [],
    });
  } catch (err) {
    log.error(`Stream start failed: ${errStr(err)}`);
    await interaction.editReply({
      content: `Failed to start stream for **${show.name}** ${episodeLabel}: ${err instanceof Error ? err.message : "Unknown error"}`,
      components: [],
    });
  }
}
