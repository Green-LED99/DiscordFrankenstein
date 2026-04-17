import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENV_PATH = join(process.cwd(), ".env");

const TORRENTIO_TEMPLATE =
  "https://torrentio.strem.fun/sort=seeders|qualityfilter=threed,4k,scr,cam,unknown|limit=5|realdebrid=";

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function readEnv(): Promise<string> {
  try {
    return await readFile(ENV_PATH, "utf-8");
  } catch {
    return "";
  }
}

function setEnvVar(envContent: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(envContent)) {
    return envContent.replace(regex, line);
  }
  // Append with newline if file doesn't end with one
  const sep = envContent.length > 0 && !envContent.endsWith("\n") ? "\n" : "";
  return `${envContent}${sep}${line}\n`;
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log();
    console.log("=== DiscordFrankenstein — RealDebrid Setup ===");
    console.log();
    console.log("RealDebrid provides premium streaming links for movies and TV series.");
    console.log("You need a RealDebrid account and API key to use this bot.");
    console.log();
    console.log("  1. Create an account at:  https://real-debrid.com/");
    console.log("  2. Get your API key at:   https://real-debrid.com/apitoken");
    console.log();

    const apiKey = await prompt(rl, "Paste your RealDebrid API key: ");

    if (!apiKey) {
      console.error("\nError: API key cannot be empty.");
      process.exit(1);
    }

    if (apiKey.length < 10 || !/^[a-zA-Z0-9]+$/.test(apiKey)) {
      console.error("\nError: API key looks invalid (expected alphanumeric, 10+ characters).");
      process.exit(1);
    }

    const addonUrl = `${TORRENTIO_TEMPLATE}${apiKey}/`;

    let envContent = await readEnv();
    envContent = setEnvVar(envContent, "STREMIO_ADDON_URL", addonUrl);
    await writeFile(ENV_PATH, envContent, "utf-8");

    console.log();
    console.log("Torrentio URL configured:");
    console.log(`  ${addonUrl}`);
    console.log();
    console.log(`Updated ${ENV_PATH}`);
    console.log();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
