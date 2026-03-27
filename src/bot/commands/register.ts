import {
  ApplicationCommandOptionType,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { createLogger, errStr } from "../../utils/logger.js";
import { config } from "../../utils/config.js";

const log = createLogger("Commands");
const API_BASE = "https://discord.com/api/v10";

const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: "movie",
    description: "Stream a movie to your voice channel",
    options: [
      {
        name: "title",
        description: 'Movie name (e.g., "F1", "Fight Club")',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: "series",
    description: "Stream a TV series episode to your voice channel",
    options: [
      {
        name: "title",
        description: 'Series name (e.g., "Family Guy")',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: "season",
        description: "Season number (random if not specified)",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
      },
      {
        name: "episode",
        description: "Episode number (random if not specified)",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
      },
    ],
  },
  {
    name: "live",
    description: "Stream a live game to your voice channel",
    options: [
      {
        name: "team",
        description: 'Team or sport (e.g., "White Sox", "Lakers", "NFL")',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: "pause",
    description: "Pause the current stream",
  },
  {
    name: "play",
    description: "Resume the paused stream",
  },
  {
    name: "skip",
    description: "Skip forward or backward in the stream",
    options: [
      {
        name: "seconds",
        description: "Seconds to skip (negative to rewind, e.g., -30)",
        type: ApplicationCommandOptionType.Integer,
        required: true,
      },
    ],
  },
  {
    name: "seek",
    description: "Jump to a specific time in the stream",
    options: [
      {
        name: "hours",
        description: "Hours",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 0,
      },
      {
        name: "minutes",
        description: "Minutes",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 0,
      },
      {
        name: "seconds",
        description: "Seconds",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 0,
      },
    ],
  },
  {
    name: "np",
    description: "Show what's currently playing and the timestamp",
  },
  {
    name: "next",
    description: "Play the next episode in the series",
  },
  {
    name: "autoplay",
    description: "Toggle auto-play next episode when current one ends",
  },
  {
    name: "stop",
    description: "Stop the current stream",
  },
];

/**
 * Register guild commands using the Discord REST API directly.
 * Clears global commands first (prevents stale commands appearing on wrong accounts),
 * then always PUTs the full command set to each guild for a guaranteed fresh state.
 */
export async function registerCommands(client: Client<true>): Promise<void> {
  const appId = client.application.id;
  const guilds = client.guilds.cache;

  // 1. Clear any global commands (stale globals can show on all guilds / wrong accounts)
  await clearGlobalCommands(appId);

  // 2. Always register guild commands (idempotent PUT — ensures fresh state every boot)
  log.info(`Registering ${commands.length} commands to ${guilds.size} guild(s)...`);

  for (const [guildId, guild] of guilds) {
    try {
      await registerToGuild(appId, guildId);
      log.info(`Registered ${commands.length} commands in ${guild.name}`);
    } catch (err) {
      log.error(`Failed to register commands in ${guild.name}: ${errStr(err)}`);
    }
  }

  log.info("Guild command registration complete");
}

/** Clear all global (non-guild) commands for this application. */
async function clearGlobalCommands(appId: string): Promise<void> {
  const url = `${API_BASE}/applications/${appId}/commands`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${config.botToken}`,
        "Content-Type": "application/json",
      },
      body: "[]",
    });

    if (res.ok) {
      log.info("Cleared global commands");
    } else if (res.status === 429) {
      const body = await res.json() as { retry_after?: number };
      log.warn(`Rate limited clearing globals — retrying after ${body.retry_after ?? 5}s`);
      await sleep((body.retry_after ?? 5) * 1000);
      await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bot ${config.botToken}`,
          "Content-Type": "application/json",
        },
        body: "[]",
      });
    } else {
      const text = await res.text();
      log.warn(`Failed to clear global commands: HTTP ${res.status} — ${text}`);
    }
  } catch (err) {
    log.warn(`Failed to clear global commands: ${errStr(err)}`);
  }
}

/** PUT commands to a single guild, handling rate limits with one retry. */
async function registerToGuild(appId: string, guildId: string): Promise<void> {
  const url = `${API_BASE}/applications/${appId}/guilds/${guildId}/commands`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  // Rate limited — wait and retry once
  if (res.status === 429) {
    const body = await res.json() as { retry_after?: number };
    const retryAfter = body.retry_after ?? 5;
    log.warn(`Rate limited (429) — retrying after ${retryAfter}s...`);
    await sleep(retryAfter * 1000);

    const retry = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${config.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`HTTP ${retry.status} on retry: ${text}`);
    }
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
