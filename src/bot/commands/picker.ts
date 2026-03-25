import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { RankedStream } from "../../services/torrentio.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Picker");

/**
 * Shows a button picker for the top streams and waits for the user to choose.
 * Returns the selected stream, or null if timed out / cancelled.
 */
export async function pickStream(
  interaction: ChatInputCommandInteraction,
  streams: RankedStream[],
  contentLabel: string
): Promise<RankedStream | null> {
  if (streams.length === 0) return null;
  if (streams.length === 1) return streams[0];

  // Build button rows (max 5 buttons per row)
  const buttons = streams.map((s, i) =>
    new ButtonBuilder()
      .setCustomId(`stream_${i}`)
      .setLabel(`${i + 1}`)
      .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  // Build the stream list description
  const lines = streams.map((s) => s.label);
  const description = lines.join("\n");

  await interaction.editReply({
    content: `**${contentLabel}** — Pick a stream:\n\`\`\`\n${description}\n\`\`\``,
    components: [row],
  });

  // Wait for button click (30 second timeout)
  try {
    const response = await interaction.fetchReply();
    const click = await response.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: 30_000,
    });

    const index = parseInt(click.customId.split("_")[1], 10);
    const selected = streams[index];

    await click.deferUpdate();

    log.info(`User picked stream ${index + 1}: ${selected.label}`);
    return selected;
  } catch {
    // Timeout or error — clear buttons and return null
    await interaction.editReply({
      content: `Stream selection timed out for **${contentLabel}**.`,
      components: [],
    }).catch(() => {});
    log.info("Stream selection timed out");
    return null;
  }
}
