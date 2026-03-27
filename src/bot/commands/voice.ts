import type { ChatInputCommandInteraction, GuildMember } from "discord.js";
import { getSelfbotClient } from "../../streamer/client.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("VoiceResolve");

/**
 * Resolve the invoking user's voice channel from the interaction.
 *
 * 1. Primary: bot gateway cache (`interaction.member.voice`) — works when bot is in the guild.
 * 2. Fallback: selfbot gateway cache — works when only the streamer account is in the guild.
 *
 * Returns `{ guildId, channelId }` or `null` if the user isn't in a voice channel
 * (or neither client is in the guild).
 */
export function resolveVoiceChannel(
  interaction: ChatInputCommandInteraction,
): { guildId: string; channelId: string } | null {
  const guildId = interaction.guildId;
  if (!guildId) return null;

  const userId = interaction.user.id;

  // Primary: bot's gateway cache (discord.js hydrates member.voice from cached voice states)
  if (interaction.member && "voice" in interaction.member) {
    const channelId = (interaction.member as GuildMember).voice?.channelId;
    if (channelId) {
      return { guildId, channelId };
    }
  }

  // Fallback: selfbot's gateway cache (covers guilds the bot isn't in)
  try {
    const selfbot = getSelfbotClient();
    const guild = selfbot.guilds.cache.get(guildId);
    if (guild) {
      const voiceState = guild.voiceStates?.cache?.get(userId);
      if (voiceState?.channelId) {
        log.info(
          `Resolved voice channel via selfbot cache (guild: ${guildId}, user: ${userId})`,
        );
        return { guildId, channelId: voiceState.channelId };
      }
    }
  } catch {
    // Selfbot not initialized — can't resolve
  }

  return null;
}
