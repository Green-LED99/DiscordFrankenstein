import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Torrentio");

export interface TorrentioStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: {
    filename?: string;
    bingeGroup?: string;
  };
}

interface TorrentioResponse {
  streams: TorrentioStream[];
}

interface ParsedStreamInfo {
  stream: TorrentioStream;
  resolution: number;
  codec: string;
  sizeBytes: number;
  seeders: number;
}

function parseResolution(title: string, bingeGroup?: string): number {
  const combined = `${title} ${bingeGroup ?? ""}`;
  if (/2160p|4k/i.test(combined)) return 2160;
  if (/1080p/i.test(combined)) return 1080;
  if (/720p/i.test(combined)) return 720;
  if (/480p/i.test(combined)) return 480;
  if (/360p/i.test(combined)) return 360;
  return 0; // Unknown
}

function parseCodec(title: string, bingeGroup?: string): string {
  const combined = `${title} ${bingeGroup ?? ""}`;
  if (/x265|h\.?265|hevc/i.test(combined)) return "h265";
  if (/x264|h\.?264|avc/i.test(combined)) return "h264";
  if (/av1/i.test(combined)) return "av1";
  if (/vp9/i.test(combined)) return "vp9";
  return "unknown";
}

function parseSizeBytes(title: string): number {
  const match = title.match(/💾\s*([\d.]+)\s*(GB|MB|TB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "TB") return value * 1024 * 1024 * 1024 * 1024;
  if (unit === "GB") return value * 1024 * 1024 * 1024;
  return value * 1024 * 1024; // MB
}

function parseSeeders(title: string): number {
  const match = title.match(/👤\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export async function fetchStreams(
  type: "movie" | "series",
  imdbId: string,
  season?: number,
  episode?: number
): Promise<TorrentioStream[]> {
  let path: string;
  if (type === "movie") {
    path = `/stream/movie/${imdbId}.json`;
  } else {
    path = `/stream/series/${imdbId}:${season}:${episode}.json`;
  }

  const url = `${config.stremioAddonUrl}${path}`;
  log.info(`Fetching streams: ${path}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Torrentio error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as TorrentioResponse;
  log.info(`Found ${data.streams.length} streams`);
  return data.streams;
}

export interface RankedStream {
  stream: TorrentioStream;
  resolution: number;
  codec: string;
  sizeBytes: number;
  seeders: number;
  label: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return "? MB";
}

function rankStreams(
  streams: TorrentioStream[],
  maxResolution: number = config.maxResolution
): RankedStream[] {
  const parsed: ParsedStreamInfo[] = streams.map((stream) => ({
    stream,
    resolution: parseResolution(stream.title, stream.behaviorHints?.bingeGroup),
    codec: parseCodec(stream.title, stream.behaviorHints?.bingeGroup),
    sizeBytes: parseSizeBytes(stream.title),
    seeders: parseSeeders(stream.title),
  }));

  // Filter to streams within our max resolution
  const eligible = parsed.filter(
    (s) => s.resolution > 0 && s.resolution <= maxResolution
  );

  // If no eligible streams found, fall back to all streams with known resolution
  const candidates = eligible.length > 0 ? eligible : parsed.filter((s) => s.resolution > 0);
  if (candidates.length === 0 && streams.length > 0) {
    log.warn("No streams with parseable resolution, using all available");
    return streams.slice(0, 5).map((s, i) => ({
      stream: s,
      resolution: 0,
      codec: "unknown",
      sizeBytes: 0,
      seeders: 0,
      label: `${i + 1}. ${s.name}`,
    }));
  }

  // Sort: most seeders first (availability), then highest resolution, then h264, then size
  candidates.sort((a, b) => {
    if (a.seeders !== b.seeders) return b.seeders - a.seeders;
    if (a.resolution !== b.resolution) return b.resolution - a.resolution;
    const codecScore = (c: string) => (c === "h264" ? 1 : 0);
    if (codecScore(a.codec) !== codecScore(b.codec))
      return codecScore(b.codec) - codecScore(a.codec);
    return b.sizeBytes - a.sizeBytes;
  });

  return candidates.map((c, i) => ({
    ...c,
    label: `${i + 1}. ${c.resolution}p ${c.codec.toUpperCase()} | ${formatSize(c.sizeBytes)} | ${c.seeders} seeds`,
  }));
}

export function getTopStreams(
  streams: TorrentioStream[],
  count: number = 5,
  maxResolution: number = config.maxResolution
): RankedStream[] {
  const ranked = rankStreams(streams, maxResolution);
  const top = ranked.slice(0, count);
  for (const s of top) {
    log.info(`Candidate: ${s.label}`);
  }
  return top;
}

export function selectBestStream(
  streams: TorrentioStream[],
  maxResolution: number = config.maxResolution
): TorrentioStream | null {
  const ranked = rankStreams(streams, maxResolution);
  if (ranked.length === 0) return null;
  const best = ranked[0];
  log.info(
    `Auto-selected: ${best.resolution}p ${best.codec} (${formatSize(best.sizeBytes)}, ${best.seeders} seeders)`
  );
  return best.stream;
}
