import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("TMDB");
const BASE_URL = "https://api.themoviedb.org/3";

export interface TMDBMovieResult {
  id: number;
  title: string;
  release_date: string;
  overview: string;
}

export interface TMDBTVResult {
  id: number;
  name: string;
  first_air_date: string;
  overview: string;
}

export interface TMDBEpisode {
  episode_number: number;
  name: string;
  season_number: number;
}

interface TMDBSearchResponse<T> {
  results: T[];
  total_results: number;
}

interface TMDBExternalIds {
  imdb_id: string | null;
}

interface TMDBTVDetails {
  number_of_seasons: number;
}

interface TMDBSeasonDetails {
  episodes: TMDBEpisode[];
}

async function tmdbFetch<T>(path: string): Promise<T> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}${path}${separator}api_key=${config.tmdbApiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB API error: ${res.status} ${res.statusText} for ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function searchMovie(query: string): Promise<TMDBMovieResult[]> {
  log.info(`Searching movies: "${query}"`);
  const data = await tmdbFetch<TMDBSearchResponse<TMDBMovieResult>>(
    `/search/movie?query=${encodeURIComponent(query)}`
  );
  log.info(`Found ${data.total_results} movie results`);
  return data.results;
}

export async function searchTV(query: string): Promise<TMDBTVResult[]> {
  log.info(`Searching TV series: "${query}"`);
  const data = await tmdbFetch<TMDBSearchResponse<TMDBTVResult>>(
    `/search/tv?query=${encodeURIComponent(query)}`
  );
  log.info(`Found ${data.total_results} TV results`);
  return data.results;
}

export async function getExternalIds(
  tmdbId: number,
  type: "movie" | "tv"
): Promise<string> {
  const data = await tmdbFetch<TMDBExternalIds>(`/${type}/${tmdbId}/external_ids`);
  if (!data.imdb_id) {
    throw new Error(`No IMDB ID found for TMDB ${type} ${tmdbId}`);
  }
  log.info(`TMDB ${tmdbId} -> IMDB ${data.imdb_id}`);
  return data.imdb_id;
}

export async function getTVDetails(tmdbId: number): Promise<TMDBTVDetails> {
  return tmdbFetch<TMDBTVDetails>(`/tv/${tmdbId}`);
}

export async function getSeasonDetails(
  tmdbId: number,
  season: number
): Promise<TMDBSeasonDetails> {
  return tmdbFetch<TMDBSeasonDetails>(`/tv/${tmdbId}/season/${season}`);
}

export async function resolveEpisode(
  tmdbId: number,
  season?: number,
  episode?: number
): Promise<{ season: number; episode: number; episodeName: string }> {
  if (season !== undefined && episode !== undefined) {
    const seasonData = await getSeasonDetails(tmdbId, season);
    const ep = seasonData.episodes.find((e) => e.episode_number === episode);
    return {
      season,
      episode,
      episodeName: ep?.name ?? `Episode ${episode}`,
    };
  }

  if (season !== undefined) {
    // Season specified, pick random episode
    const seasonData = await getSeasonDetails(tmdbId, season);
    if (seasonData.episodes.length === 0) {
      throw new Error(`No episodes found for season ${season}`);
    }
    const randomEp =
      seasonData.episodes[Math.floor(Math.random() * seasonData.episodes.length)];
    log.info(`Random episode: S${season}E${randomEp.episode_number} - ${randomEp.name}`);
    return {
      season,
      episode: randomEp.episode_number,
      episodeName: randomEp.name,
    };
  }

  // Neither specified, pick random season then random episode
  const tvDetails = await getTVDetails(tmdbId);
  if (tvDetails.number_of_seasons === 0) {
    throw new Error("TV show has no seasons");
  }
  const randomSeason = Math.floor(Math.random() * tvDetails.number_of_seasons) + 1;
  const seasonData = await getSeasonDetails(tmdbId, randomSeason);
  if (seasonData.episodes.length === 0) {
    throw new Error(`No episodes found for season ${randomSeason}`);
  }
  const randomEp =
    seasonData.episodes[Math.floor(Math.random() * seasonData.episodes.length)];
  log.info(
    `Random pick: S${randomSeason}E${randomEp.episode_number} - ${randomEp.name}`
  );
  return {
    season: randomSeason,
    episode: randomEp.episode_number,
    episodeName: randomEp.name,
  };
}
