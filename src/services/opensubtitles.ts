import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("OpenSubs");

const BASE_URL = "https://opensubtitles-v3.strem.io";

export interface SubtitleEntry {
  id: string;
  url: string;
  lang: string; // ISO 639-2B (e.g., "eng", "spa", "fre", "jpn")
}

interface OpenSubsResponse {
  subtitles: Array<{
    id: string;
    url: string;
    lang: string;
    SubEncoding: string;
    m: string;
    g: string;
  }>;
}

/**
 * Fetch available subtitles from the OpenSubtitles Stremio addon.
 * No API key required. Returns ALL languages — filter client-side.
 */
export async function fetchSubtitles(
  type: "movie" | "series",
  imdbId: string,
  season?: number,
  episode?: number
): Promise<SubtitleEntry[]> {
  const videoId =
    type === "series" && season != null && episode != null
      ? `${imdbId}:${season}:${episode}`
      : imdbId;

  const url = `${BASE_URL}/subtitles/${type}/${videoId}.json`;
  log.info(`Fetching subtitles: /subtitles/${type}/${videoId}.json`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log.warn(`OpenSubtitles returned ${res.status} for ${videoId}`);
      return [];
    }

    const data = (await res.json()) as OpenSubsResponse;
    const subs = data.subtitles.map((s) => ({
      id: s.id,
      url: s.url,
      lang: s.lang,
    }));

    // Deduplicate by language — keep first (best) per language
    const seen = new Set<string>();
    const unique = subs.filter((s) => {
      if (seen.has(s.lang)) return false;
      seen.add(s.lang);
      return true;
    });

    log.info(`Found ${unique.length} subtitle languages`);
    return unique;
  } catch (err) {
    log.warn(`Failed to fetch subtitles: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * Download an SRT subtitle file to a temp directory.
 * Returns the local file path for FFmpeg's -vf subtitles= filter.
 */
export async function downloadSubtitle(subtitle: SubtitleEntry): Promise<string> {
  log.info(`Downloading ${subtitle.lang} subtitle...`);

  const res = await fetch(subtitle.url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Failed to download subtitle: ${res.status}`);
  }

  const content = await res.text();
  const tempDir = await mkdtemp(join(tmpdir(), "df-subs-"));
  const filePath = join(tempDir, `subtitle_${subtitle.lang}.srt`);

  await writeFile(filePath, content, "utf-8");
  log.info(`Subtitle saved to: ${filePath}`);
  return filePath;
}

/**
 * Offset all SRT timestamps by a given number of seconds.
 * Used when seeking: `-ss` before `-i` resets PTS to 0, so subtitles
 * must be shifted backward to match the new timeline.
 * Entries before the offset are dropped.
 * Returns the path to the new offset subtitle file.
 */
export async function offsetSubtitleFile(
  srtPath: string,
  offsetSec: number
): Promise<string> {
  const content = await readFile(srtPath, "utf-8");
  const offsetMs = Math.round(offsetSec * 1000);

  // Parse SRT timestamps: "HH:MM:SS,mmm"
  function parseSrtTime(ts: string): number {
    const [time, ms] = ts.split(",");
    const [h, m, s] = time!.split(":").map(Number);
    return h! * 3600000 + m! * 60000 + s! * 1000 + Number(ms);
  }

  function formatSrtTime(ms: number): string {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const ml = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ml).padStart(3, "0")}`;
  }

  // Split into blocks (separated by blank lines)
  const blocks = content.trim().split(/\n\s*\n/);
  const adjusted: string[] = [];
  let counter = 1;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    // Line 1: sequence number, Line 2: timestamps, Lines 3+: text
    const tsLine = lines[1]!;
    const tsMatch = tsLine.match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );
    if (!tsMatch) continue;

    const startMs = parseSrtTime(tsMatch[1]!) - offsetMs;
    const endMs = parseSrtTime(tsMatch[2]!) - offsetMs;

    // Drop entries that end before the seek point
    if (endMs <= 0) continue;

    // Clamp start to 0 if it's slightly before
    const adjStart = Math.max(0, startMs);
    const text = lines.slice(2).join("\n");

    adjusted.push(`${counter}\n${formatSrtTime(adjStart)} --> ${formatSrtTime(endMs)}\n${text}`);
    counter++;
  }

  const offsetPath = join(dirname(srtPath), `subtitle_offset.srt`);
  await writeFile(offsetPath, adjusted.join("\n\n"), "utf-8");
  log.info(`Offset subtitle saved to: ${offsetPath} (offset: -${offsetSec.toFixed(1)}s, ${adjusted.length} entries)`);
  return offsetPath;
}
