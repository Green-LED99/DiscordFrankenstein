import type { ChatInputCommandInteraction } from "discord.js";
import { searchContent } from "../../services/cinemeta.js";
import { fetchStreams, getTopStreams } from "../../services/torrentio.js";
import { fetchSubtitles, downloadSubtitle } from "../../services/opensubtitles.js";
import { probeStream } from "../../services/ffprobe.js";
import { startVideoStream } from "../../streamer/stream.js";
import { pickStream } from "./picker.js";
import { pickAudioTrack, pickSubtitleTrack } from "./options.js";
import { resolveVoiceChannel } from "./voice.js";
import { createLogger, errStr } from "../../utils/logger.js";

const log = createLogger("MovieCmd");

export async function handleMovie(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const title = interaction.options.getString("title", true);

  const voice = resolveVoiceChannel(interaction);
  if (!voice) {
    await interaction.editReply("You must be in a voice channel to use this command.");
    return;
  }
  const { guildId, channelId } = voice;

  // 1. Search Cinemeta
  await interaction.editReply(`Searching for "${title}"...`);
  const results = await searchContent(title, "movie");
  if (results.length === 0) {
    await interaction.editReply(`No movies found for "${title}".`);
    return;
  }

  const movie = results[0];
  const year = movie.releaseInfo ?? movie.year ?? "Unknown";
  log.info(`Found: ${movie.name} (${year}) [IMDB: ${movie.id}]`);

  // 2. Fetch streams from Torrentio
  await interaction.editReply(
    `Found **${movie.name}** (${year}). Fetching streams...`
  );
  const streams = await fetchStreams("movie", movie.id);
  const topStreams = getTopStreams(streams);

  if (topStreams.length === 0) {
    await interaction.editReply(
      `No suitable streams found for **${movie.name}** (${year}).`
    );
    return;
  }

  // 3. Let user pick a stream
  const contentLabel = `${movie.name} (${year})`;
  const selected = await pickStream(interaction, topStreams, contentLabel);
  if (!selected) return;

  // 4. Probe the selected stream for audio tracks
  await interaction.editReply({
    content: `Analyzing **${contentLabel}**...`,
    components: [],
  });

  let audioStreamIndex: number | undefined;
  let subtitlePath: string | undefined;
  let sourceInfo;

  try {
    sourceInfo = await probeStream(selected.stream.url);

    // 5. Audio track selection (only if multiple audio streams)
    const audioIdx = await pickAudioTrack(interaction, sourceInfo.audioStreams);
    if (audioIdx !== null) audioStreamIndex = audioIdx;

    // 6. Subtitle selection from OpenSubtitles
    const subtitles = await fetchSubtitles("movie", movie.id);
    const selectedSub = await pickSubtitleTrack(interaction, subtitles);
    if (selectedSub) {
      subtitlePath = await downloadSubtitle(selectedSub);
    }
  } catch (err) {
    log.warn(`Audio/subtitle selection failed, continuing without: ${errStr(err)}`);
  }

  // 7. Start streaming (pass sourceInfo to avoid re-probing)
  await interaction.editReply({
    content: `Preparing to stream **${contentLabel}**...`,
    components: [],
  });

  try {
    await startVideoStream(guildId, channelId, selected.stream.url, audioStreamIndex, subtitlePath, sourceInfo, undefined, false, undefined, contentLabel);
    await interaction.editReply({
      content: `Now streaming: **${contentLabel}**`,
      components: [],
    });
  } catch (err) {
    log.error(`Stream start failed: ${errStr(err)}`);
    await interaction.editReply({
      content: `Failed to start stream for **${contentLabel}**: ${err instanceof Error ? err.message : "Unknown error"}`,
      components: [],
    });
  }
}
