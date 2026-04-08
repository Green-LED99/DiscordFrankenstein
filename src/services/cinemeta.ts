import { createLogger } from "../utils/logger.js";
import { config } from "../utils/config.js";
import {
  searchMovies as tmdbSearchMovies,
  searchSeries as tmdbSearchSeries,
  getMovieImdbId,
  getSeriesImdbId,
  findByImdbId,
} from "./tmdb.js";

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
    year?: string;
    releaseInfo?: string;
    videos?: CinemetaVideo[];
  };
}

interface CinemetaCatalogResponse {
  metas: CinemetaResult[];
}

export interface EpisodeInfo {
  season: number; // Cinemeta's actual value (may be year-based, e.g., 2010)
  episode: number;
  name: string;
  unmappedSeason?: number; // Ordinal season (e.g., 8) for Torrentio retry when Cinemeta uses year-based numbering
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

// --- IMDB input parsing ---

const IMDB_REGEX = /(?:imdb\.com\/title\/)?(tt\d{7,8})\b/;

export type ImdbInput =
  | { type: "imdb"; imdbId: string }
  | { type: "search"; query: string };

/** Detect whether input is an IMDB URL/ID or a plain search query. */
export function parseImdbInput(input: string): ImdbInput {
  const match = input.match(IMDB_REGEX);
  if (match) return { type: "imdb", imdbId: match[1] };
  return { type: "search", query: input };
}

// --- IMDB GraphQL resolution ---

const IMDB_GRAPHQL = "https://caching.graphql.imdb.com/";

export interface ResolvedImdbId {
  type: "movie" | "series" | "episode";
  imdbId: string; // For episodes: the PARENT series ID. Otherwise: the ID itself.
  season?: number; // Only for episodes
  episode?: number; // Only for episodes
}

/**
 * Query IMDB's public GraphQL API to determine if an ID is a movie, series,
 * or episode. For episodes, resolves the parent series ID and season/episode.
 */
export async function resolveImdbId(imdbId: string): Promise<ResolvedImdbId> {
  log.info(`Resolving IMDB ID type: ${imdbId}`);

  const query = `query { title(id: "${imdbId}") { titleType { id } series { series { id } episodeNumber { episodeNumber seasonNumber } } } }`;

  const res = await fetch(IMDB_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`IMDB GraphQL error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: {
      title?: {
        titleType?: { id?: string };
        series?: {
          series?: { id?: string };
          episodeNumber?: { seasonNumber?: number; episodeNumber?: number };
        } | null;
      } | null;
    };
  };

  const title = json.data?.title;
  if (!title) {
    throw new Error(`IMDB ID ${imdbId} not found`);
  }

  const titleType = title.titleType?.id ?? "";
  const seriesData = title.series;

  if (titleType === "tvEpisode" && seriesData?.series?.id) {
    const parentId = seriesData.series.id;
    const season = seriesData.episodeNumber?.seasonNumber;
    const episode = seriesData.episodeNumber?.episodeNumber;
    log.info(`Resolved ${imdbId} as episode → parent: ${parentId}, S${season}E${episode}`);
    return { type: "episode", imdbId: parentId, season, episode };
  }

  if (titleType === "tvSeries" || titleType === "tvMiniSeries") {
    return { type: "series", imdbId };
  }

  return { type: "movie", imdbId };
}

/** Fetch metadata for a known IMDB ID directly (no search needed). */
export async function fetchMeta(
  imdbId: string,
  type: "movie" | "series",
): Promise<CinemetaResult> {
  log.info(`Fetching ${type} meta for ${imdbId}`);
  const data = await cinemetaFetch<CinemetaMetaResponse>(
    `/meta/${type}/${imdbId}.json`,
  );
  if (!data.meta?.id) {
    // TMDB fallback when Cinemeta has no data for this IMDB ID
    if (config.tmdbApiKey) {
      log.info(`Cinemeta has no data for ${imdbId}, trying TMDB fallback...`);
      try {
        const found = await findByImdbId(imdbId);
        if (found) {
          log.info(`TMDB fallback: ${found.name} (${found.year})`);
          return { id: imdbId, name: found.name, type, year: found.year };
        }
      } catch (err) {
        log.warn(`TMDB fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`No ${type} found for IMDB ID ${imdbId}`);
  }
  return {
    id: data.meta.id,
    name: data.meta.name,
    type,
    year: data.meta.year,
    releaseInfo: data.meta.releaseInfo,
  };
}

// --- Helpers ---

/**
 * Map a user-provided season number to Cinemeta's actual season value.
 * Handles year-based numbering (e.g., 2003, 2004, ...) where user input "8"
 * means the 8th season, not season number 8.
 */
function mapSeason(seasons: number[], userSeason: number): number | undefined {
  // Direct match first (covers sequential numbering like 1, 2, 3)
  if (seasons.includes(userSeason)) return userSeason;
  // Ordinal fallback: treat userSeason as 1-based index into sorted seasons
  // (covers year-based numbering like 2003, 2004, ...)
  if (userSeason >= 1 && userSeason <= seasons.length) {
    return seasons[userSeason - 1];
  }
  return undefined;
}

/** Inverse of mapSeason: given a Cinemeta season value, return its 1-based ordinal position. */
function reverseMapSeason(seasons: number[], cinemetaSeason: number): number {
  const idx = seasons.indexOf(cinemetaSeason);
  return idx >= 0 ? idx + 1 : cinemetaSeason;
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

  if (data.metas.length > 0) {
    log.info(`Found ${data.metas.length} ${type} results`);
    return data.metas;
  }

  // TMDB fallback when Cinemeta returns nothing
  if (config.tmdbApiKey) {
    log.info(`Cinemeta returned 0 results, trying TMDB fallback...`);
    try {
      const tmdbResults =
        type === "movie"
          ? await tmdbSearchMovies(query)
          : await tmdbSearchSeries(query);

      if (tmdbResults.length > 0) {
        const top = tmdbResults[0];
        const imdbId =
          type === "movie"
            ? await getMovieImdbId(top.id)
            : await getSeriesImdbId(top.id);

        if (imdbId) {
          log.info(`TMDB fallback: ${top.name} (${top.year}) → ${imdbId}`);
          return [{ id: imdbId, name: top.name, type, year: top.year }];
        }
      }
    } catch (err) {
      log.warn(`TMDB fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`Found 0 ${type} results`);
  return [];
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
    // Both specified — resolve season (handles year-based numbering) and find exact match
    const actualSeason = mapSeason(seasons, season);
    if (actualSeason === undefined) {
      throw new Error(`Season ${season} not found for ${imdbId}`);
    }
    if (actualSeason !== season) {
      log.info(`Mapped season ${season} → ${actualSeason}`);
    }
    const match = regularEpisodes.find(
      (v) => v.season === actualSeason && v.episode === episode
    );
    if (!match) {
      throw new Error(`Episode S${season}E${episode} not found for ${imdbId}`);
    }
    const unmapped = actualSeason !== season ? season : undefined;
    return { season: actualSeason, episode, name: match.name ?? "Unknown", unmappedSeason: unmapped };
  }

  if (season !== undefined) {
    // Season specified — resolve season and pick random episode
    const actualSeason = mapSeason(seasons, season);
    if (actualSeason === undefined) {
      throw new Error(`Season ${season} not found for ${imdbId}`);
    }
    if (actualSeason !== season) {
      log.info(`Mapped season ${season} → ${actualSeason}`);
    }
    const seasonEps = regularEpisodes.filter((v) => v.season === actualSeason);
    const pick = seasonEps[Math.floor(Math.random() * seasonEps.length)];
    log.info(`Random pick: S${pick.season}E${pick.episode} - ${pick.name}`);
    const unmapped = actualSeason !== season ? season : undefined;
    return { season: pick.season, episode: pick.episode, name: pick.name ?? "Unknown", unmappedSeason: unmapped };
  }

  // Neither specified — pick random season and episode
  const randomSeason = seasons[Math.floor(Math.random() * seasons.length)];
  const seasonEps = regularEpisodes.filter((v) => v.season === randomSeason);
  const pick = seasonEps[Math.floor(Math.random() * seasonEps.length)];
  log.info(`Random pick: S${pick.season}E${pick.episode} - ${pick.name}`);
  const ordinal = reverseMapSeason(seasons, randomSeason);
  return { season: pick.season, episode: pick.episode, name: pick.name ?? "Unknown", unmappedSeason: ordinal !== randomSeason ? ordinal : undefined };
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
  // Build seasons array for ordinal mapping
  const seasons = [...new Set(regularEpisodes.map((v) => v.season))].sort(
    (a, b) => a - b
  );

  if (nextInSeason) {
    log.info(`Next episode: S${nextInSeason.season}E${nextInSeason.episode} - ${nextInSeason.name}`);
    const ordinal = reverseMapSeason(seasons, nextInSeason.season);
    return {
      season: nextInSeason.season,
      episode: nextInSeason.episode,
      name: nextInSeason.name ?? "Unknown",
      unmappedSeason: ordinal !== nextInSeason.season ? ordinal : undefined,
    };
  }

  // Try first episode of next season (supports year-based and sequential numbering)
  const currentIdx = seasons.indexOf(currentSeason);
  const nextSeason = currentIdx >= 0 ? seasons[currentIdx + 1] : undefined;

  if (nextSeason !== undefined) {
    const nextSeasonEps = regularEpisodes
      .filter((v) => v.season === nextSeason)
      .sort((a, b) => a.episode - b.episode);
    if (nextSeasonEps.length > 0) {
      const first = nextSeasonEps[0];
      log.info(`Next episode (new season): S${first.season}E${first.episode} - ${first.name}`);
      const ordinal = reverseMapSeason(seasons, first.season);
      return {
        season: first.season,
        episode: first.episode,
        name: first.name ?? "Unknown",
        unmappedSeason: ordinal !== first.season ? ordinal : undefined,
      };
    }
  }

  log.info(`No next episode after S${currentSeason}E${currentEpisode}`);
  return null;
}
