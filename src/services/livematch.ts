/**
 * Live event matching — fuzzy search with team alias expansion.
 * Ported from WrappedStream's LiveResolver.ts.
 */

import type { SportsurgeEvent } from "./sportsurge.js";

// ── Team nickname / abbreviation map ────────────────────────────────────
// Maps common abbreviations and nicknames to tokens that appear in
// sportsurge event slugs (which use full team/city names).
// Only lowercase — lookups are case-insensitive via tokenize().
const TEAM_ALIASES: Record<string, string[]> = {
  // NHL
  avs: ["avalanche", "colorado"],
  pens: ["penguins", "pittsburgh"],
  caps: ["capitals", "washington"],
  habs: ["canadiens", "montreal"],
  bolts: ["lightning", "tampa"],
  hawks: ["blackhawks", "chicago"],
  nucks: ["canucks", "vancouver"],
  sens: ["senators", "ottawa"],
  wings: ["red", "wings", "detroit"],
  isles: ["islanders", "new", "york"],
  canes: ["hurricanes", "carolina"],
  preds: ["predators", "nashville"],
  jackets: ["blue", "jackets", "columbus"],
  leafs: ["maple", "leafs", "toronto"],
  bruins: ["bruins", "boston"],
  rangers: ["rangers", "new", "york"],
  oilers: ["oilers", "edmonton"],
  flames: ["flames", "calgary"],
  sabres: ["sabres", "buffalo"],
  stars: ["stars", "dallas"],
  wild: ["wild", "minnesota"],
  jets: ["jets", "winnipeg"],
  kraken: ["kraken", "seattle"],
  knights: ["golden", "knights", "vegas"],
  // NBA
  lakers: ["lakers", "los", "angeles"],
  celtics: ["celtics", "boston"],
  sixers: ["76ers", "philadelphia"],
  knicks: ["knicks", "new", "york"],
  dubs: ["warriors", "golden", "state"],
  mavs: ["mavericks", "dallas"],
  nugs: ["nuggets", "denver"],
  blazers: ["trail", "blazers", "portland"],
  clips: ["clippers", "los", "angeles"],
  grizz: ["grizzlies", "memphis"],
  // NFL
  niners: ["49ers", "san", "francisco"],
  pats: ["patriots", "new", "england"],
  pack: ["packers", "green", "bay"],
  // MLB
  redsox: ["red", "sox", "boston"],
  whitesox: ["white", "sox", "chicago"],
  yanks: ["yankees", "new", "york"],
  cards: ["cardinals", "st", "louis"],
  // Soccer
  barca: ["barcelona"],
  utd: ["united", "manchester"],
  spurs: ["spurs", "tottenham"],
  gunners: ["arsenal"],
  reds: ["liverpool"],
  blues: ["chelsea"],
  city: ["city", "manchester"],
  psg: ["paris", "saint", "germain"],
  bayern: ["bayern", "munich"],
  juve: ["juventus"],
  real: ["real", "madrid"],
  atleti: ["atletico", "madrid"],
  // MMA / Boxing
  ufc: ["ufc"],
  // Shorthand sport names
  nhl: ["nhl"],
  nba: ["nba"],
  nfl: ["nfl"],
  mlb: ["mlb"],
  ucl: ["uefa", "champions", "league"],
  epl: ["premier", "league"],
};

/**
 * Expand query tokens using the alias map. If a query token matches
 * an alias key, the alias expansions are added alongside the original.
 */
function expandAliases(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const t of tokens) {
    expanded.push(t);
    const aliases = TEAM_ALIASES[t];
    if (aliases) {
      for (const a of aliases) {
        if (!expanded.includes(a)) expanded.push(a);
      }
    }
  }
  return expanded;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((t) => t.length > 0);
}

/**
 * Score a query against an event. Higher = better match.
 */
function scoreEvent(event: SportsurgeEvent, queryTokens: string[]): number {
  const targetTokens = tokenize(`${event.title} ${event.sport}`);
  let score = 0;

  for (const qt of queryTokens) {
    for (const tt of targetTokens) {
      if (tt === qt) {
        score += 3;
      } else if (qt.length >= 3 && tt.length >= 3) {
        if (tt.includes(qt) || qt.includes(tt)) {
          score += 1;
        }
      }
    }
  }

  return score;
}

/**
 * Return all events matching the query, sorted by score descending.
 * Used for the picker when multiple matches exist.
 */
export function matchAllEvents(
  events: SportsurgeEvent[],
  query: string
): SportsurgeEvent[] {
  const rawTokens = tokenize(query);
  if (rawTokens.length === 0) return [];
  const queryTokens = expandAliases(rawTokens);

  return events
    .map((event) => ({ event, score: scoreEvent(event, queryTokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.event);
}

