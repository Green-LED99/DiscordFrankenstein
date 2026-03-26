import { createLogger } from "../utils/logger.js";

const log = createLogger("Cinemeta");

const BASE_URL = "https://v3-cinemeta.strem.io";

// --- Types ---

export interface CinemetaResult {
  id: string; // IMDB ID (e.g., "tt0126029")
  name: string;
  type: "movie" | "series";
  year?: string;
  releaseInfo?: string;
  poster?: string;
}

interface CinemetaVideo {
  id: string; // format: "tt0388629:1:1" (imdbId:season:episode)
  season: number;
  episode: number;
  name?: string;
  released?: string;
  overview?: string;
}

interface CinemetaMetaResponse {
  meta: {
    id: string;
    imdb_id: string;
    type: string;
    name: string;
    videos?: CinemetaVideo[];
  };
}

interface CinemetaCatalogResponse {
  metas: CinemetaResult[];
}

export interface EpisodeInfo {
  season: number;
  episode: number;
  name: string;
}

// --- API helpers ---

async function cinemetaFetch<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Cinemeta error: ${res.status} ${res.statusText} for ${path}`);
  }
  return res.json() as Promise<T>;
}

// --- Public API ---

/**
 * Search for movies or series by title.
 * Returns results with IMDB IDs — no conversion needed.
 */
export async function searchContent(
  query: string,
  type: "movie" | "series"
): Promise<CinemetaResult[]> {
  log.info(`Searching ${type}: "${query}"`);
  const encoded = encodeURIComponent(query);
  const data = await cinemetaFetch<CinemetaCatalogResponse>(
    `/catalog/${type}/top/search=${encoded}.json`
  );
  log.info(`Found ${data.metas.length} ${type} results`);
  return data.metas;
}

/**
 * Resolve which episode to play for a series.
 * If season/episode not specified, picks randomly.
 * Returns episode info with season, episode number, and name.
 */
export async function resolveEpisode(
  imdbId: string,
  season?: number,
  episode?: number
): Promise<EpisodeInfo> {
  // Fetch full series metadata with all episodes
  const data = await cinemetaFetch<CinemetaMetaResponse>(
    `/meta/series/${imdbId}.json`
  );

  const videos = data.meta.videos ?? [];
  if (videos.length === 0) {
    throw new Error(`No episodes found for ${imdbId}`);
  }

  // Filter out specials (season 0) for random selection
  const regularEpisodes = videos.filter((v) => v.season > 0);
  if (regularEpisodes.length === 0) {
    throw new Error(`No regular episodes found for ${imdbId}`);
  }

  // Get available seasons (excluding season 0)
  const seasons = [...new Set(regularEpisodes.map((v) => v.season))].sort(
    (a, b) => a - b
  );

  if (season !== undefined && episode !== undefined) {
    // Both specified — find exact match
    const match = regularEpisodes.find(
      (v) => v.season === season && v.episode === episode
    );
    if (!match) {
      throw new Error(`Episode S${season}E${episode} not found for ${imdbId}`);
    }
    return { season, episode, name: match.name ?? "Unknown" };
  }

  if (season !== undefined) {
    // Season specified, pick random episode from that season
    const seasonEps = regularEpisodes.filter((v) => v.season === season);
    if (seasonEps.length === 0) {
      throw new Error(`Season ${season} not found for ${imdbId}`);
    }
    const pick = seasonEps[Math.floor(Math.random() * seasonEps.length)];
    log.info(`Random pick: S${pick.season}E${pick.episode} - ${pick.name}`);
    return { season: pick.season, episode: pick.episode, name: pick.name ?? "Unknown" };
  }

  // Neither specified — pick random season and episode
  const randomSeason = seasons[Math.floor(Math.random() * seasons.length)];
  const seasonEps = regularEpisodes.filter((v) => v.season === randomSeason);
  const pick = seasonEps[Math.floor(Math.random() * seasonEps.length)];
  log.info(`Random pick: S${pick.season}E${pick.episode} - ${pick.name}`);
  return { season: pick.season, episode: pick.episode, name: pick.name ?? "Unknown" };
}

/**
 * Get the next episode after the given season/episode.
 * Tries: same season next episode, then first episode of next season.
 * Returns null if no next episode exists.
 */
export async function getNextEpisode(
  imdbId: string,
  currentSeason: number,
  currentEpisode: number
): Promise<EpisodeInfo | null> {
  const data = await cinemetaFetch<CinemetaMetaResponse>(
    `/meta/series/${imdbId}.json`
  );

  const videos = data.meta.videos ?? [];
  const regularEpisodes = videos.filter((v) => v.season > 0);

  // Try next episode in same season
  const nextInSeason = regularEpisodes.find(
    (v) => v.season === currentSeason && v.episode === currentEpisode + 1
  );
  if (nextInSeason) {
    log.info(`Next episode: S${nextInSeason.season}E${nextInSeason.episode} - ${nextInSeason.name}`);
    return {
      season: nextInSeason.season,
      episode: nextInSeason.episode,
      name: nextInSeason.name ?? "Unknown",
    };
  }

  // Try first episode of next season
  const nextSeasonEps = regularEpisodes
    .filter((v) => v.season === currentSeason + 1)
    .sort((a, b) => a.episode - b.episode);
  if (nextSeasonEps.length > 0) {
    const first = nextSeasonEps[0];
    log.info(`Next episode (new season): S${first.season}E${first.episode} - ${first.name}`);
    return {
      season: first.season,
      episode: first.episode,
      name: first.name ?? "Unknown",
    };
  }

  log.info(`No next episode after S${currentSeason}E${currentEpisode}`);
  return null;
}
