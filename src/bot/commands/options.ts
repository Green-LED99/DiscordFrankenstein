import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AudioStreamInfo } from "../../services/ffprobe.js";
import type { SubtitleEntry } from "../../services/opensubtitles.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Options");

// Common language code → display name mapping
const LANG_NAMES: Record<string, string> = {
  eng: "English", fre: "French", spa: "Spanish", ger: "German",
  ita: "Italian", por: "Portuguese", pob: "PT-BR", jpn: "Japanese",
  kor: "Korean", chi: "Chinese", zho: "Chinese", ara: "Arabic",
  rus: "Russian", hin: "Hindi", tur: "Turkish", pol: "Polish",
  nld: "Dutch", swe: "Swedish", nor: "Norwegian", dan: "Danish",
  fin: "Finnish", cze: "Czech", hun: "Hungarian", ron: "Romanian",
  tha: "Thai", vie: "Vietnamese", ind: "Indonesian", heb: "Hebrew",
  ell: "Greek", bul: "Bulgarian", hrv: "Croatian", srp: "Serbian",
  und: "Unknown",
};

function langName(code: string): string {
  return LANG_NAMES[code] ?? code.toUpperCase();
}

/**
 * Show audio track picker if multiple audio streams are available.
 * Returns the global stream index to pass to FFmpeg -map, or null for default.
 */
export async function pickAudioTrack(
  interaction: ChatInputCommandInteraction,
  audioStreams: AudioStreamInfo[]
): Promise<number | null> {
  if (audioStreams.length <= 1) return null; // Only one track, no choice needed

  const buttons = audioStreams.slice(0, 5).map((stream, i) => {
    const label = `${langName(stream.language)}${stream.channels > 2 ? ` ${stream.channels}ch` : ""}`;
    return new ButtonBuilder()
      .setCustomId(`audio_${i}`)
      .setLabel(label)
      .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary);
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  await interaction.editReply({
    content: "🔊 **Select audio track:**",
    components: [row],
  });

  try {
    const reply = await interaction.fetchReply();
    const click = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith("audio_"),
      time: 30_000,
    });

    const index = parseInt(click.customId.split("_")[1], 10);
    if (Number.isNaN(index) || index < 0 || index >= audioStreams.length) {
      await click.deferUpdate();
      return null;
    }

    const selected = audioStreams[index];
    await click.deferUpdate();
    // Return the audio-relative index (position in audio streams array),
    // NOT the global stream index. The library uses -map 0:a:{N}? which
    // is audio-relative (0 = first audio, 1 = second audio).
    log.info(`Audio track selected: ${langName(selected.language)} (audio index ${index})`);
    return index;
  } catch {
    // Timeout — use default (first audio)
    return null;
  }
}

/**
 * Show subtitle picker from available OpenSubtitles entries.
 * Returns the selected SubtitleEntry, or null for no subtitles.
 */
export async function pickSubtitleTrack(
  interaction: ChatInputCommandInteraction,
  subtitles: SubtitleEntry[]
): Promise<SubtitleEntry | null> {
  if (subtitles.length === 0) return null;

  // Show top languages + "None" button
  const topSubs = subtitles.slice(0, 4); // Max 4 + None = 5 buttons

  const buttons = [
    new ButtonBuilder()
      .setCustomId("sub_none")
      .setLabel("No Subtitles")
      .setStyle(ButtonStyle.Secondary),
    ...topSubs.map((sub, i) =>
      new ButtonBuilder()
        .setCustomId(`sub_${i}`)
        .setLabel(langName(sub.lang))
        .setStyle(sub.lang === "eng" ? ButtonStyle.Primary : ButtonStyle.Secondary)
    ),
  ];

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  await interaction.editReply({
    content: "📝 **Select subtitles:**",
    components: [row],
  });

  try {
    const reply = await interaction.fetchReply();
    const click = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith("sub_"),
      time: 30_000,
    });

    await click.deferUpdate();

    if (click.customId === "sub_none") {
      log.info("No subtitles selected");
      return null;
    }

    const index = parseInt(click.customId.split("_")[1], 10);
    if (Number.isNaN(index) || index < 0 || index >= topSubs.length) return null;

    const selected = topSubs[index];
    log.info(`Subtitle selected: ${langName(selected.lang)}`);
    return selected;
  } catch {
    // Timeout — no subtitles
    return null;
  }
}
