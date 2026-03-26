import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { fetchEvents } from "../../services/sportsurge.js";
import { matchAllEvents } from "../../services/livematch.js";
import {
  fetchStreamEmbedId,
  resolveStreamUrl,
} from "../../services/sportsurge.js";
import type { SportsurgeEvent } from "../../services/sportsurge.js";
import { probeStream } from "../../services/ffprobe.js";
import { startVideoStream } from "../../streamer/stream.js";
import { createLogger, errStr } from "../../utils/logger.js";

const log = createLogger("LiveCmd");

export async function handleLive(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const query = interaction.options.getString("team", true);
  const member = interaction.member;

  // Validate voice channel (same pattern as movie.ts)
  if (!member || !("voice" in member)) {
    await interaction.editReply("Could not determine your voice channel.");
    return;
  }

  if (!(member as GuildMember).voice.channelId) {
    await interaction.editReply(
      "You must be in a voice channel to use this command."
    );
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const channelId = (member as GuildMember).voice.channelId!;

  // 1. Search for live events
  await interaction.editReply(`🔍 Searching for "${query}" games...`);
  log.info(`Searching live events: "${query}"`);

  let events: SportsurgeEvent[];
  try {
    events = await fetchEvents();
  } catch (err) {
    log.error(`Failed to fetch events: ${errStr(err)}`);
    await interaction.editReply(
      "Failed to fetch live events. The site may be down."
    );
    return;
  }

  if (events.length === 0) {
    await interaction.editReply("No live events found right now. Check back during game time.");
    return;
  }

  // 2. Fuzzy match
  const allMatches = matchAllEvents(events, query);

  if (allMatches.length === 0) {
    const available = events
      .slice(0, 15)
      .map((e) => `• **${e.sport}**: ${e.title}`)
      .join("\n");
    await interaction.editReply(
      `No games matching "${query}". Currently live:\n${available}`
    );
    return;
  }

  // 3. Pick (auto-select if 1, picker if multiple)
  let selected: SportsurgeEvent;

  if (allMatches.length === 1) {
    selected = allMatches[0];
    log.info(`Auto-selected: ${selected.sport} — ${selected.title}`);
  } else {
    const top = allMatches.slice(0, 5);
    const picked = await pickLiveGame(interaction, top);
    if (!picked) return;
    selected = picked;
    log.info(`User picked: ${selected.sport} — ${selected.title}`);
  }

  // 4. Resolve stream URL
  await interaction.editReply({
    content: `📡 Resolving stream for **${selected.title}**...`,
    components: [],
  });

  let streamUrl: string;
  let headers: Record<string, string>;

  try {
    const embedId = await fetchStreamEmbedId(selected.url);
    const resolved = await resolveStreamUrl(embedId);
    streamUrl = resolved.streamUrl;
    headers = resolved.headers;
  } catch (err) {
    log.error(`Stream resolution failed: ${errStr(err)}`);
    await interaction.editReply({
      content: `Failed to resolve stream for **${selected.title}**: ${err instanceof Error ? err.message : "Unknown error"}`,
      components: [],
    });
    return;
  }

  // 5. Probe stream (with auth headers for HLS)
  await interaction.editReply({
    content: `🎬 Preparing stream for **${selected.title}**...`,
    components: [],
  });

  let sourceInfo;
  try {
    sourceInfo = await probeStream(streamUrl, headers);
  } catch (err) {
    log.error(`Stream probe failed: ${errStr(err)}`);
    await interaction.editReply({
      content: `Could not access stream — it may not have started yet or the URL expired.`,
      components: [],
    });
    return;
  }

  // 6. Start streaming
  try {
    const contentTitle = `${selected.sport.toUpperCase()} — ${selected.title}`;
    await startVideoStream(
      guildId,
      channelId,
      streamUrl,
      undefined,  // no audio track selection for live
      undefined,  // no subtitles for live
      sourceInfo,
      headers,
      true,       // isLive = true (enables reconnect)
      undefined,  // no seek
      contentTitle,
    );
    await interaction.editReply({
      content: `🔴 Now streaming: **${selected.sport.toUpperCase()}** — ${selected.title}`,
      components: [],
    });
  } catch (err) {
    log.error(`Stream start failed: ${errStr(err)}`);
    await interaction.editReply({
      content: `Failed to start stream: ${err instanceof Error ? err.message : "Unknown error"}`,
      components: [],
    });
  }
}

/**
 * Show a button picker for multiple live game matches.
 */
async function pickLiveGame(
  interaction: ChatInputCommandInteraction,
  games: SportsurgeEvent[]
): Promise<SportsurgeEvent | null> {
  const sportEmoji: Record<string, string> = {
    nba: "🏀",
    nfl: "🏈",
    mlb: "⚾",
    nhl: "🏒",
    soccer: "⚽",
    mma: "🥊",
    boxing: "🥊",
    tennis: "🎾",
    golf: "⛳",
    f1: "🏎️",
    nascar: "🏁",
  };

  const buttons = games.map((game, i) => {
    const emoji = sportEmoji[game.sport.toLowerCase()] ?? "🎮";
    const label = `${emoji} ${game.title}`.slice(0, 80);
    return new ButtonBuilder()
      .setCustomId(`live_${i}`)
      .setLabel(label)
      .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary);
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

  await interaction.editReply({
    content: `Found ${games.length} matching games. Pick one:`,
    components: [row],
  });

  try {
    const reply = await interaction.fetchReply();
    const click = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith("live_"),
      time: 30_000,
    });

    await click.deferUpdate();
    const index = parseInt(click.customId.split("_")[1] ?? "", 10);
    if (Number.isNaN(index) || index < 0 || index >= games.length) {
      await interaction.editReply({ content: "Invalid selection.", components: [] });
      return null;
    }

    return games[index];
  } catch {
    await interaction.editReply({ content: "Game selection timed out.", components: [] }).catch(() => {});
    return null;
  }
}
