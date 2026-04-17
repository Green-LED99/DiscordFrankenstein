import type { ChatInputCommandInteraction } from "discord.js";
import { searchContent, parseImdbInput, fetchMeta, resolveImdbId } from "../../services/cinemeta.js";
import { fetchStreams, getTopStreams } from "../../services/torrentio.js";
import { fetchSubtitles, downloadSubtitle, extractEmbeddedSubtitle } from "../../services/opensubtitles.js";
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

  // 1. Resolve movie — by IMDB ID/URL or text search
  const parsed = parseImdbInput(title);
  let movie: { id: string; name: string; year: string };

  if (parsed.type === "imdb") {
    await interaction.editReply(`Looking up IMDB ID \`${parsed.imdbId}\`...`);
    const resolved = await resolveImdbId(parsed.imdbId);
    if (resolved.type === "episode") {
      await interaction.editReply(`That IMDB ID is a TV episode. Use \`/series ${parsed.imdbId}\` instead.`);
      return;
    }
    if (resolved.type === "series") {
      await interaction.editReply(`That IMDB ID is a TV series. Use \`/series ${parsed.imdbId}\` instead.`);
      return;
    }
    const meta = await fetchMeta(parsed.imdbId, "movie");
    movie = { id: meta.id, name: meta.name, year: meta.releaseInfo ?? meta.year ?? "Unknown" };
  } else {
    await interaction.editReply(`Searching for "${title}"...`);
    const results = await searchContent(parsed.query, "movie");
    if (results.length === 0) {
      await interaction.editReply(`No movies found for "${title}".`);
      return;
    }
    const r = results[0];
    movie = { id: r.id, name: r.name, year: r.releaseInfo ?? r.year ?? "Unknown" };
  }

  const year = movie.year;
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

    // 6. Subtitle selection — embedded (from file) first, external (OpenSubtitles) as fallback
    const externalSubs = await fetchSubtitles("movie", movie.id);
    const selectedSub = await pickSubtitleTrack(interaction, externalSubs, sourceInfo.subtitleStreams);
    if (selectedSub?.type === "embedded") {
      subtitlePath = await extractEmbeddedSubtitle(selected.stream.url, selectedSub.stream.index, selectedSub.stream.language);
    } else if (selectedSub?.type === "external") {
      subtitlePath = await downloadSubtitle(selectedSub.entry);
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
