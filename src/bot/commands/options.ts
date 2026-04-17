import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AudioStreamInfo, SubtitleStreamInfo } from "../../services/ffprobe.js";
import type { SubtitleEntry } from "../../services/opensubtitles.js";

export type SubtitleSelection =
  | { type: "embedded"; stream: SubtitleStreamInfo }
  | { type: "external"; entry: SubtitleEntry };
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
    log.info(`Audio track selected: ${langName(selected.language)} (audio index ${index})`);
    await interaction.editReply({ content: `Audio: **${langName(selected.language)}**`, components: [] });
    return index;
  } catch {
    // Timeout — use default (first audio)
    return null;
  }
}

/**
 * Show subtitle picker with embedded streams (from the file) and external
 * subtitles (from OpenSubtitles). Embedded subs are shown first and clearly
 * labelled so users can tell them apart.
 *
 * Returns a SubtitleSelection indicating which type was chosen, or null for none.
 */
export async function pickSubtitleTrack(
  interaction: ChatInputCommandInteraction,
  externalSubs: SubtitleEntry[],
  embeddedSubs?: SubtitleStreamInfo[],
): Promise<SubtitleSelection | null> {
  // Only show text-based embedded subs (PGS/VobSub can't be burned via subtitles filter)
  const textEmbedded = (embeddedSubs ?? []).filter((s) => s.isTextBased);

  if (textEmbedded.length === 0 && externalSubs.length === 0) return null;

  // Build combined option list: embedded first, then external, max 4 + "None" = 5 buttons
  type Option = { id: string; label: string; style: ButtonStyle; selection: SubtitleSelection };
  const options: Option[] = [];

  for (const stream of textEmbedded) {
    if (options.length >= 4) break;
    const lang = langName(stream.language);
    options.push({
      id: `sub_emb_${options.length}`,
      label: `[FILE] ${lang}`,
      style: stream.language === "eng" ? ButtonStyle.Success : ButtonStyle.Primary,
      selection: { type: "embedded", stream },
    });
  }

  for (const entry of externalSubs) {
    if (options.length >= 4) break;
    options.push({
      id: `sub_ext_${options.length}`,
      label: langName(entry.lang),
      style: entry.lang === "eng" ? ButtonStyle.Primary : ButtonStyle.Secondary,
      selection: { type: "external", entry },
    });
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId("sub_none")
      .setLabel("No Subtitles")
      .setStyle(ButtonStyle.Secondary),
    ...options.map((opt) =>
      new ButtonBuilder()
        .setCustomId(opt.id)
        .setLabel(opt.label)
        .setStyle(opt.style)
    ),
  ];

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  await interaction.editReply({
    content: "**Select subtitles:**",
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
      await interaction.editReply({ content: "Subtitles: **None**", components: [] });
      return null;
    }

    const opt = options.find((o) => o.id === click.customId);
    if (!opt) return null;

    log.info(`Subtitle selected: ${opt.label} (${opt.selection.type})`);
    await interaction.editReply({ content: `Subtitles: **${opt.label}**`, components: [] });
    return opt.selection;
  } catch {
    // Timeout — no subtitles
    return null;
  }
}
