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

export function selectBestStream(
  streams: TorrentioStream[],
  maxResolution: number = config.maxResolution
): TorrentioStream | null {
  if (streams.length === 0) return null;

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
  if (candidates.length === 0) {
    // Last resort: pick first stream regardless
    log.warn("No streams with parseable resolution, using first available");
    return streams[0];
  }

  // Sort: highest resolution first, then prefer h264 (copy mode friendly),
  // then largest file, then most seeders
  candidates.sort((a, b) => {
    // Higher resolution preferred
    if (a.resolution !== b.resolution) return b.resolution - a.resolution;
    // Prefer h264 for potential copy mode
    const codecScore = (c: string) => (c === "h264" ? 1 : 0);
    if (codecScore(a.codec) !== codecScore(b.codec))
      return codecScore(b.codec) - codecScore(a.codec);
    // Larger file = better quality
    if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
    // More seeders = more reliable
    return b.seeders - a.seeders;
  });

  const best = candidates[0];
  log.info(
    `Selected: ${best.resolution}p ${best.codec} (${(best.sizeBytes / 1024 / 1024).toFixed(0)} MB, ${best.seeders} seeders)`
  );
  return best.stream;
}
