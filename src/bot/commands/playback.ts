import type { ChatInputCommandInteraction } from "discord.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isStreaming,
  isLiveStream,
  getPlaybackInfo,
  getPausedState,
  clearPausedState,
  pauseStream,
  stopVideoStream,
  startVideoStream,
} from "../../streamer/stream.js";
import { offsetSubtitleFile } from "../../services/opensubtitles.js";
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
    // Adjust subtitles for seek offset if needed
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

  // Get current elapsed time from whichever state is active
  const currentElapsed = playback?.elapsedSec ?? paused!.elapsedSec;
  const title = playback?.title ?? paused!.contentTitle;
  const newElapsed = Math.max(0, currentElapsed + skipSec);
  const timeStr = formatTime(newElapsed);

  // If paused, just update the saved timestamp
  if (!playback && paused) {
    paused.elapsedSec = newElapsed;
    const direction = skipSec >= 0 ? "⏩" : "⏪";
    await interaction.editReply(
      `${direction} Skipped to ${timeStr} in **${title}** (paused). Use /play to resume.`
    );
    log.info(`Skip while paused: "${title}" → ${timeStr}`);
    return;
  }

  // If streaming, stop and restart at new position
  const direction = skipSec >= 0 ? "⏩" : "⏪";
  await interaction.editReply(
    `${direction} Skipping to ${timeStr} in **${title}**...`
  );

  try {
    // Save current stream info before stopping
    const info = getPlaybackInfo()!;
    // Pause saves state, then we modify the elapsed time
    await pauseStream();
    // Wait for FFmpeg to fully terminate before starting new stream
    await sleep(1000);
    const saved = getPausedState()!;
    saved.elapsedSec = newElapsed;

    // Adjust subtitles for new seek offset
    let subPath = saved.subtitlePath;
    if (subPath && newElapsed > 0) {
      try {
        subPath = await offsetSubtitleFile(subPath, newElapsed);
      } catch {
        log.warn("Failed to offset subtitles, continuing without");
        subPath = saved.subtitlePath;
      }
    }

    await startVideoStream(
      saved.guildId,
      saved.channelId,
      saved.streamUrl,
      saved.audioStreamIndex,
      subPath,
      saved.sourceInfo,
      saved.headers,
      false,
      newElapsed,
      saved.contentTitle,
    );

    clearPausedState();
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

  // If streaming, stop and restart at target position
  await interaction.editReply(`⏩ Seeking to ${timeStr} in **${title}**...`);

  try {
    await pauseStream();
    // Wait for FFmpeg to fully terminate before starting new stream
    await sleep(1000);
    const saved = getPausedState()!;
    saved.elapsedSec = targetSec;

    // Adjust subtitles for seek offset
    let subPath = saved.subtitlePath;
    if (subPath && targetSec > 0) {
      try {
        subPath = await offsetSubtitleFile(subPath, targetSec);
      } catch {
        log.warn("Failed to offset subtitles, continuing without");
        subPath = saved.subtitlePath;
      }
    }

    await startVideoStream(
      saved.guildId,
      saved.channelId,
      saved.streamUrl,
      saved.audioStreamIndex,
      subPath,
      saved.sourceInfo,
      saved.headers,
      false,
      targetSec,
      saved.contentTitle,
    );

    clearPausedState();
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
