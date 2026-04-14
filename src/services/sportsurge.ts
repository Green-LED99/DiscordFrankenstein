/**
 * Sportsurge client — fetches live sports events and resolves stream URLs.
 * Ported from WrappedStream's SportsurgeClient.ts with adaptations for our architecture.
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("Sportsurge");

const BASE_URL = "https://sportsurge.ws";
const EMBED_HOST = "https://gooz.aapmains.net";
const FETCH_TIMEOUT_MS = 10_000;

export const SPORTSURGE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export interface SportsurgeEvent {
  url: string;
  title: string;
  sport: string;
}

export interface ResolvedLiveStream {
  eventTitle: string;
  sport: string;
  streamUrl: string;
  headers: Record<string, string>;
}

/**
 * Fetch all events currently listed on sportsurge.ws.
 * Parses event links from the server-rendered HTML.
 */
export async function fetchEvents(): Promise<SportsurgeEvent[]> {
  const html = await fetchText(BASE_URL);

  // Links follow: /watch/{sport}/{team1-team2}/{id}
  const linkRegex =
    /href="https:\/\/sportsurge\.ws\/watch\/([^/]+)\/([^/]+)\/(\d+)"/g;

  const events: SportsurgeEvent[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(linkRegex)) {
    const sport = match[1]!;
    const slug = match[2]!;
    const id = match[3]!;
    const url = `${BASE_URL}/watch/${sport}/${slug}/${id}`;

    if (seen.has(id)) continue;
    seen.add(id);

    // Convert slug to human-readable title:
    // "golden-state-warriors-new-york-knicks" → "Golden State Warriors New York Knicks"
    const title = slug
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    events.push({ url, title, sport });
  }

  log.info(`Fetched ${events.length} live events`);
  return events;
}

/**
 * Fetch an event page and extract the internal stream embed ID.
 * Returns the numeric stream ID from the gooz.aapmains.net embed URL.
 */
export async function fetchStreamEmbedId(
  eventUrl: string
): Promise<string> {
  const html = await fetchText(eventUrl);

  const match = html.match(
    /gooz\.aapmains\.net\/new-stream-embed\/(\d+)/
  );
  if (!match?.[1]) {
    throw new Error(
      `No stream embed found on event page: ${eventUrl}`
    );
  }

  log.info(`Found embed ID: ${match[1]}`);
  return match[1];
}

/**
 * Resolve a stream embed ID to a direct HLS playlist URL.
 *
 * The embed page uses a Plyr + HLS.js player with a plaintext source URL:
 *   const source = "https://<host>/playlist/<id>/load-playlist";
 *   hls.loadSource(source);
 *
 * Returns the playlist URL and the HTTP headers required for playback.
 */
export async function resolveStreamUrl(
  streamId: string
): Promise<{ streamUrl: string; headers: Record<string, string> }> {
  const embedUrl = `${EMBED_HOST}/new-stream-embed/${streamId}`;

  const html = await fetchText(embedUrl, {
    Referer: `${BASE_URL}/`,
  });

  const match = html.match(/https?:\/\/[^\s'"]+\/playlist\/\d+\/load-playlist/);
  if (!match?.[0]) {
    throw new Error(
      `No playlist URL found in embed page for stream ${streamId}`
    );
  }

  const streamUrl = match[0];

  log.info(`Resolved stream URL: ${streamUrl.slice(0, 80)}...`);

  return {
    streamUrl,
    headers: {
      "User-Agent": SPORTSURGE_USER_AGENT,
      Referer: `${EMBED_HOST}/`,
      Origin: EMBED_HOST,
    },
  };
}

async function fetchText(
  url: string,
  extraHeaders?: Record<string, string>
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": SPORTSURGE_USER_AGENT,
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  return response.text();
}
