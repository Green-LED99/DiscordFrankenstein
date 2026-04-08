import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("TMDB");

const BASE_URL = "https://api.themoviedb.org/3";

export interface TmdbResult {
  id: number; // TMDB ID
  name: string;
  year: string;
}

async function tmdbFetch<T>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}${path}${sep}api_key=${config.tmdbApiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`TMDB error: ${res.status} ${res.statusText} for ${path}`);
  }
  return res.json() as Promise<T>;
}

/** Search TMDB for movies by title. */
export async function searchMovies(query: string): Promise<TmdbResult[]> {
  log.info(`Searching movies: "${query}"`);
  const data = await tmdbFetch<{
    results: { id: number; title: string; release_date?: string }[];
  }>(`/search/movie?query=${encodeURIComponent(query)}`);

  return data.results.map((r) => ({
    id: r.id,
    name: r.title,
    year: r.release_date?.slice(0, 4) ?? "Unknown",
  }));
}

/** Search TMDB for TV series by title. */
export async function searchSeries(query: string): Promise<TmdbResult[]> {
  log.info(`Searching series: "${query}"`);
  const data = await tmdbFetch<{
    results: { id: number; name: string; first_air_date?: string }[];
  }>(`/search/tv?query=${encodeURIComponent(query)}`);

  return data.results.map((r) => ({
    id: r.id,
    name: r.name,
    year: r.first_air_date?.slice(0, 4) ?? "Unknown",
  }));
}

/** Get the IMDB ID for a TMDB movie. */
export async function getMovieImdbId(
  tmdbId: number,
): Promise<string | null> {
  const data = await tmdbFetch<{ imdb_id?: string | null }>(
    `/movie/${tmdbId}/external_ids`,
  );
  return data.imdb_id ?? null;
}

/** Get the IMDB ID for a TMDB TV series. */
export async function getSeriesImdbId(
  tmdbId: number,
): Promise<string | null> {
  const data = await tmdbFetch<{ imdb_id?: string | null }>(
    `/tv/${tmdbId}/external_ids`,
  );
  return data.imdb_id ?? null;
}

/** Find metadata by IMDB ID (reverse lookup). */
export async function findByImdbId(
  imdbId: string,
): Promise<{ name: string; year: string; type: "movie" | "series" } | null> {
  log.info(`Finding metadata for ${imdbId}`);
  const data = await tmdbFetch<{
    movie_results: { title: string; release_date?: string }[];
    tv_results: { name: string; first_air_date?: string }[];
  }>(`/find/${imdbId}?external_source=imdb_id`);

  if (data.movie_results.length > 0) {
    const m = data.movie_results[0];
    return {
      name: m.title,
      year: m.release_date?.slice(0, 4) ?? "Unknown",
      type: "movie",
    };
  }

  if (data.tv_results.length > 0) {
    const t = data.tv_results[0];
    return {
      name: t.name,
      year: t.first_air_date?.slice(0, 4) ?? "Unknown",
      type: "series",
    };
  }

  return null;
}
