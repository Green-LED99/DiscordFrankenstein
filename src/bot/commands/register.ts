import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApplicationCommandOptionType,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { createLogger, errStr } from "../../utils/logger.js";
import { config } from "../../utils/config.js";

const log = createLogger("Commands");
const HASH_FILE = join(process.cwd(), ".command-hash");
const API_BASE = "https://discord.com/api/v10";

export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: "movie",
    description: "Stream a movie to your voice channel",
    options: [
      {
        name: "title",
        description: 'Movie name or IMDB URL (e.g., "Fight Club", "tt0137523")',
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
        description: 'Series name or IMDB URL (e.g., "Family Guy", "tt0182576")',
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
    name: "link",
    description: "Get a stream URL without joining voice",
    options: [
      {
        name: "title",
        description: 'Movie/series name or IMDB URL (e.g., "Fight Club", "tt0137523")',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: "type",
        description: "Content type",
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: "Movie", value: "movie" },
          { name: "Series", value: "series" },
        ],
      },
      {
        name: "season",
        description: "Season number (for series, random if not specified)",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
      },
      {
        name: "episode",
        description: "Episode number (for series, random if not specified)",
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

interface HashFile {
  global: string;
  guilds: Record<string, string>;
}

async function loadHashFile(): Promise<HashFile> {
  try {
    const raw: unknown = JSON.parse(await readFile(HASH_FILE, "utf-8"));
    if (typeof raw === "object" && raw !== null) {
      const obj = raw as Record<string, unknown>;
      return {
        global: typeof obj.global === "string" ? obj.global : "",
        guilds:
          typeof obj.guilds === "object" && obj.guilds !== null
            ? (obj.guilds as Record<string, string>)
            : {},
      };
    }
  } catch {
    // File doesn't exist or is invalid — register everything
  }
  return { global: "", guilds: {} };
}

async function saveHashFile(data: HashFile): Promise<void> {
  await writeFile(HASH_FILE, JSON.stringify(data, null, 2), "utf-8").catch(
    (err) => log.warn(`Failed to save command hash: ${errStr(err)}`),
  );
}

function computeCommandHash(): string {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

/**
 * Register commands using the Discord REST API directly.
 * Uses both global (universal coverage) and guild-specific (instant availability).
 * Hash-based deduplication skips registration when nothing has changed.
 */
export async function registerCommands(client: Client<true>): Promise<void> {
  const appId = client.application.id;
  const guilds = client.guilds.cache;
  const currentHash = computeCommandHash();
  const hashFile = await loadHashFile();
  const commandsChanged = hashFile.global !== currentHash;

  if (commandsChanged) {
    // --- Commands changed: re-register globally + all guilds ---
    log.info("Command definitions changed — registering globally and to all guilds");

    try {
      await registerGlobal(appId);
      hashFile.global = currentHash;
      await saveHashFile(hashFile);
      log.info("Global commands registered");
    } catch (err) {
      log.error(`Failed to register global commands: ${errStr(err)}`);
      // Continue to guild registration — guild commands work independently
    }

    log.info(
      `Registering ${commands.length} commands to ${guilds.size} guild(s)...`,
    );
    for (const [guildId, guild] of guilds) {
      try {
        await registerToGuild(appId, guildId);
        hashFile.guilds[guildId] = currentHash;
        await saveHashFile(hashFile);
        log.info(`Registered ${commands.length} commands in ${guild.name}`);
      } catch (err) {
        log.error(
          `Failed to register commands in ${guild.name}: ${errStr(err)}`,
        );
      }
    }
  } else {
    // --- Commands unchanged: only register to new guilds ---
    const pending = [...guilds.entries()].filter(
      ([guildId]) => hashFile.guilds[guildId] !== currentHash,
    );

    if (pending.length === 0) {
      log.info(
        `Commands unchanged (hash: ${currentHash.slice(0, 8)}...), all ${guilds.size} guild(s) up to date — skipping`,
      );
      return;
    }

    log.info(
      `Commands unchanged — registering to ${pending.length} new guild(s)...`,
    );
    for (const [guildId, guild] of pending) {
      try {
        await registerToGuild(appId, guildId);
        hashFile.guilds[guildId] = currentHash;
        await saveHashFile(hashFile);
        log.info(`Registered ${commands.length} commands in ${guild.name}`);
      } catch (err) {
        log.error(
          `Failed to register commands in ${guild.name}: ${errStr(err)}`,
        );
      }
    }
  }

  log.info("Command registration complete");
}

/** Register commands to a guild that was joined at runtime. */
export async function registerCommandsToNewGuild(
  appId: string,
  guildId: string,
  guildName: string,
): Promise<void> {
  const currentHash = computeCommandHash();
  const hashFile = await loadHashFile();

  if (hashFile.guilds[guildId] === currentHash) {
    log.info(`Commands already registered in ${guildName} — skipping`);
    return;
  }

  await registerToGuild(appId, guildId);
  hashFile.guilds[guildId] = currentHash;
  await saveHashFile(hashFile);
  log.info(`Registered ${commands.length} commands in new guild ${guildName}`);
}

/** PUT commands to the global endpoint, handling rate limits with one retry. */
async function registerGlobal(appId: string): Promise<void> {
  const url = `${API_BASE}/applications/${appId}/commands`;
  const res = await putCommands(url);

  if (res.status === 429) {
    await retryAfterRateLimit(res, url);
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

/** PUT commands to a single guild, handling rate limits with one retry. */
async function registerToGuild(appId: string, guildId: string): Promise<void> {
  const url = `${API_BASE}/applications/${appId}/guilds/${guildId}/commands`;
  const res = await putCommands(url);

  if (res.status === 429) {
    await retryAfterRateLimit(res, url);
    return;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

/** Shared PUT request for command registration. */
async function putCommands(url: string): Promise<Response> {
  return fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
}

/** Handle 429 rate limit: wait and retry once. */
async function retryAfterRateLimit(res: Response, url: string): Promise<void> {
  const body = (await res.json()) as { retry_after?: number };
  const retryAfter = body.retry_after ?? 5;
  log.warn(`Rate limited (429) — retrying after ${retryAfter}s...`);
  await sleep(retryAfter * 1000);

  const retry = await putCommands(url);
  if (!retry.ok) {
    const text = await retry.text();
    throw new Error(`HTTP ${retry.status} on retry: ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
