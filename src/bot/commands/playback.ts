import type { ChatInputCommandInteraction } from "discord.js";
import {
  isStreaming,
  isLiveStream,
  getPlaybackInfo,
  getPausedState,
  clearPausedState,
  pauseStream,
  startVideoStream,
  restartAtPosition,
  getCurrentElapsedSec,
  getSeriesInfo,
  isAutoplayEnabled,
  setAutoplay,
  setAutoplayCallback,
  getLastKnownVoiceChannel,
  type SeriesInfo,
} from "../../streamer/stream.js";
import { getNextEpisode } from "../../services/cinemeta.js";
import { fetchStreams, getTopStreams } from "../../services/torrentio.js";
import { offsetSubtitleFile } from "../../services/opensubtitles.js";
import { resolveVoiceChannel } from "./voice.js";
import { createLogger, errStr } from "../../utils/logger.js";

const log = createLogger("Playback");

function formatTime(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── /pause ──────────────────────────────────────────────────────────────

export async function handlePause(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isStreaming()) {
    await interaction.editReply("Nothing is currently playing.");
    return;
  }
  if (isLiveStream()) {
    await interaction.editReply("Cannot pause a live stream.");
    return;
  }

  try {
    const { elapsedSec, title } = await pauseStream();
    await interaction.editReply(
      `⏸️ Paused **${title}** at ${formatTime(elapsedSec)}. Use /play to resume.`
    );
    log.info(`Paused "${title}" at ${formatTime(elapsedSec)}`);
  } catch (err) {
    log.error(`Pause failed: ${errStr(err)}`);
    await interaction.editReply(
      `Failed to pause: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

// ── /play ───────────────────────────────────────────────────────────────

export async function handlePlay(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const paused = getPausedState();
  if (!paused) {
    await interaction.editReply("Nothing is paused. Use /pause first.");
    return;
  }

  const timeStr = formatTime(paused.elapsedSec);
  await interaction.editReply(
    `▶️ Resuming **${paused.contentTitle}** from ${timeStr}...`
  );

  try {
    // Adjust subtitles for the seek offset
    let subPath = paused.subtitlePath;
    if (subPath && paused.elapsedSec > 0) {
      try {
        subPath = await offsetSubtitleFile(subPath, paused.elapsedSec);
      } catch {
        log.warn("Failed to offset subtitles, continuing without");
        subPath = paused.subtitlePath;
      }
    }

    await startVideoStream(
      paused.guildId,
      paused.channelId,
      paused.streamUrl,
      paused.audioStreamIndex,
      subPath,
      paused.sourceInfo,
      paused.headers,
      false,
      paused.elapsedSec,
      paused.contentTitle,
      paused.seriesInfo ?? undefined,
    );

    clearPausedState();
    await interaction.editReply(
      `▶️ Resuming **${paused.contentTitle}** from ${timeStr}`
    );
    log.info(`Resumed "${paused.contentTitle}" from ${timeStr}`);
  } catch (err) {
    log.error(`Play/resume failed: ${errStr(err)}`);
    await interaction.editReply(
      `Failed to resume: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

// ── /skip ───────────────────────────────────────────────────────────────

export async function handleSkip(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const skipSec = interaction.options.getInteger("seconds", true);
  const playback = getPlaybackInfo();
  const paused = getPausedState();

  if (!playback && !paused) {
    await interaction.editReply("Nothing is playing or paused.");
    return;
  }
  if (playback?.isLive) {
    await interaction.editReply("Cannot skip in a live stream.");
    return;
  }

  // Current position from whichever state is active
  const currentElapsed = playback?.elapsedSec ?? paused!.elapsedSec;
  const title = playback?.title ?? paused!.contentTitle;
  const newElapsed = Math.max(0, currentElapsed + skipSec);
  const timeStr = formatTime(newElapsed);
  const direction = skipSec >= 0 ? "⏩" : "⏪";

  // If paused, just update the saved timestamp — no stream to restart
  if (!playback && paused) {
    paused.elapsedSec = newElapsed;
    await interaction.editReply(
      `${direction} Skipped to ${timeStr} in **${title}** (paused). Use /play to resume.`
    );
    log.info(`Skip while paused: "${title}" → ${timeStr}`);
    return;
  }

  // Stream is active — atomically restart FFmpeg at the new position
  await interaction.editReply(
    `${direction} Skipping to ${timeStr} in **${title}**...`
  );

  try {
    await restartAtPosition(newElapsed);
    await interaction.editReply(
      `${direction} Skipped to ${timeStr} in **${title}**`
    );
    log.info(`Skipped "${title}" to ${timeStr}`);
  } catch (err) {
    log.error(`Skip failed: ${errStr(err)}`);
    await interaction.editReply(
      `Failed to skip: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

// ── /seek ───────────────────────────────────────────────────────────────

export async function handleSeek(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const hours = interaction.options.getInteger("hours") ?? 0;
  const minutes = interaction.options.getInteger("minutes") ?? 0;
  const seconds = interaction.options.getInteger("seconds") ?? 0;
  const targetSec = Math.max(0, hours * 3600 + minutes * 60 + seconds);

  const playback = getPlaybackInfo();
  const paused = getPausedState();

  if (!playback && !paused) {
    await interaction.editReply("Nothing is playing or paused.");
    return;
  }
  if (playback?.isLive) {
    await interaction.editReply("Cannot seek in a live stream.");
    return;
  }

  const title = playback?.title ?? paused!.contentTitle;
  const timeStr = formatTime(targetSec);

  // If paused, just update the saved timestamp
  if (!playback && paused) {
    paused.elapsedSec = targetSec;
    await interaction.editReply(
      `⏩ Seek to ${timeStr} in **${title}** (paused). Use /play to resume.`
    );
    log.info(`Seek while paused: "${title}" → ${timeStr}`);
    return;
  }

  // Stream is active — atomically restart FFmpeg at the target position
  await interaction.editReply(`⏩ Seeking to ${timeStr} in **${title}**...`);

  try {
    await restartAtPosition(targetSec);
    await interaction.editReply(`⏩ Seeked to ${timeStr} in **${title}**`);
    log.info(`Seeked "${title}" to ${timeStr}`);
  } catch (err) {
    log.error(`Seek failed: ${errStr(err)}`);
    await interaction.editReply(
      `Failed to seek: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

// ── /np (Now Playing) ──────────────────────────────────────────────────

export async function handleNowPlaying(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const playback = getPlaybackInfo();
  const paused = getPausedState();

  if (playback) {
    const timeStr = formatTime(playback.elapsedSec);
    const status = playback.isLive ? "🔴 LIVE" : `▶️ Playing`;
    await interaction.editReply(
      `🎬 **${playback.title}**\n⏱️ ${timeStr} — ${status}`
    );
    return;
  }

  if (paused) {
    const timeStr = formatTime(paused.elapsedSec);
    await interaction.editReply(
      `🎬 **${paused.contentTitle}**\n⏱️ ${timeStr} — ⏸️ Paused`
    );
    return;
  }

  await interaction.editReply("Nothing is currently playing.");
}

// ── /next (Next Episode) ───────────────────────────────────────────────

export async function handleNext(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const series = getSeriesInfo();
  if (!series) {
    await interaction.editReply("No series is currently playing. Use /series first.");
    return;
  }

  await interaction.editReply(
    `⏭️ Finding next episode after **${series.showName}** S${String(series.season).padStart(2, "0")}E${String(series.episode).padStart(2, "0")}...`
  );

  try {
    await playNextEpisode(series, interaction);
  } catch (err) {
    log.error(`Next episode failed: ${errStr(err)}`);
    await interaction.editReply(
      `Failed to play next episode: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

// ── /autoplay ──────────────────────────────────────────────────────────

export async function handleAutoplay(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const newState = !isAutoplayEnabled();
  setAutoplay(newState);

  if (newState) {
    const series = getSeriesInfo();
    if (series) {
      registerAutoplayCallback(series);
      await interaction.editReply(
        `🔁 Autoplay **enabled** for **${series.showName}**. Next episodes will play automatically.`
      );
    } else {
      await interaction.editReply(
        `🔁 Autoplay **enabled**. Start a series with /series to auto-play episodes.`
      );
    }
  } else {
    setAutoplayCallback(null);
    await interaction.editReply("⏹️ Autoplay **disabled**.");
  }

  log.info(`Autoplay ${newState ? "enabled" : "disabled"}`);
}

// ── Shared: play next episode logic ────────────────────────────────────

async function playNextEpisode(
  series: SeriesInfo,
  interaction?: ChatInputCommandInteraction
): Promise<void> {
  const nextEp = await getNextEpisode(series.showId, series.season, series.episode);
  if (!nextEp) {
    const msg = `No more episodes after S${String(series.season).padStart(2, "0")}E${String(series.episode).padStart(2, "0")} of **${series.showName}**.`;
    if (interaction) await interaction.editReply(msg);
    else log.info(msg);
    setAutoplay(false);
    return;
  }

  const episodeLabel = `S${String(nextEp.season).padStart(2, "0")}E${String(nextEp.episode).padStart(2, "0")}`;
  const contentLabel = `${series.showName} ${episodeLabel} - ${nextEp.name}`;
  log.info(`Next episode: ${contentLabel}`);

  // Fetch fresh streams for the new episode
  const streams = await fetchStreams("series", series.showId, nextEp.season, nextEp.episode);
  const topStreams = getTopStreams(streams);

  if (topStreams.length === 0) {
    const msg = `No streams found for **${contentLabel}**.`;
    if (interaction) await interaction.editReply(msg);
    else log.info(msg);
    setAutoplay(false);
    return;
  }

  const selected = topStreams[0];
  log.info(`Auto-selected: ${selected.label}`);

  // Determine guild/channel — from interaction or last known
  let targetGuildId: string | null = null;
  let targetChannelId: string | null = null;

  if (interaction) {
    const voice = resolveVoiceChannel(interaction);
    if (!voice) {
      await interaction.editReply("You must be in a voice channel.");
      return;
    }
    targetGuildId = voice.guildId;
    targetChannelId = voice.channelId;
    await interaction.editReply(`⏭️ Now playing: **${contentLabel}**`);
  } else {
    const lastChannel = getLastKnownVoiceChannel();
    targetGuildId = lastChannel?.guildId ?? null;
    targetChannelId = lastChannel?.channelId ?? null;
  }

  if (!targetGuildId || !targetChannelId) {
    log.error("Next episode: no guild/channel available");
    if (interaction) await interaction.editReply("Could not determine voice channel.");
    return;
  }

  const newSeriesInfo: SeriesInfo = {
    showId: series.showId,
    showName: series.showName,
    season: nextEp.season,
    episode: nextEp.episode,
  };

  // startVideoStreamInner handles teardown of any existing stream internally —
  // no need to call stopVideoStream() which would clear autoplay state
  await startVideoStream(
    targetGuildId,
    targetChannelId,
    selected.stream.url,
    undefined, undefined, undefined, undefined,
    false, undefined, contentLabel, newSeriesInfo
  );

  // Re-register autoplay callback for the new episode
  if (isAutoplayEnabled()) {
    registerAutoplayCallback(newSeriesInfo);
  }
}

function registerAutoplayCallback(series: SeriesInfo): void {
  setAutoplayCallback(async () => {
    try {
      await playNextEpisodeAutoplay(series);
    } catch (err) {
      log.error(`Autoplay callback failed: ${errStr(err)}`);
      setAutoplay(false);
    }
  });
}

async function playNextEpisodeAutoplay(series: SeriesInfo): Promise<void> {
  const nextEp = await getNextEpisode(series.showId, series.season, series.episode);
  if (!nextEp) {
    log.info(`Autoplay: no more episodes after S${series.season}E${series.episode}`);
    setAutoplay(false);
    return;
  }

  const episodeLabel = `S${String(nextEp.season).padStart(2, "0")}E${String(nextEp.episode).padStart(2, "0")}`;
  const contentLabel = `${series.showName} ${episodeLabel} - ${nextEp.name}`;
  log.info(`Autoplay: fetching streams for ${contentLabel}`);

  const streams = await fetchStreams("series", series.showId, nextEp.season, nextEp.episode);
  const topStreams = getTopStreams(streams);

  if (topStreams.length === 0) {
    log.warn(`Autoplay: no streams for ${contentLabel}`);
    setAutoplay(false);
    return;
  }

  const selected = topStreams[0];
  log.info(`Autoplay: selected ${selected.label}`);

  const newSeriesInfo: SeriesInfo = {
    showId: series.showId,
    showName: series.showName,
    season: nextEp.season,
    episode: nextEp.episode,
  };

  const lastChannel = getLastKnownVoiceChannel();
  const guildId = lastChannel?.guildId ?? null;
  const channelId = lastChannel?.channelId ?? null;

  if (!guildId || !channelId) {
    log.error("Autoplay: no guild/channel available");
    setAutoplay(false);
    return;
  }

  await startVideoStream(
    guildId, channelId, selected.stream.url,
    undefined, undefined, undefined, undefined,
    false, undefined, contentLabel, newSeriesInfo
  );

  registerAutoplayCallback(newSeriesInfo);
}
