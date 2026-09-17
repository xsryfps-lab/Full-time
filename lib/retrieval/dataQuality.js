const { round, clamp } = require("../utils");

// -----------------------------------------------------------------------
// Source reliability — a coarse, heuristic domain allowlist. Not
// exhaustive, but scoring known football-statistics and news sources
// higher than an unrecognized domain gives the system at least a rough
// signal for how much to trust the retrieval, surfaced in the UI rather
// than hidden.
// -----------------------------------------------------------------------
const HIGH_RELIABILITY_DOMAINS = [
  "bbc.co", "espn.com", "skysports.com", "theguardian.com", "reuters.com",
  "flashscore.com", "sofascore.com", "whoscored.com", "transfermarkt.com", "transfermarkt.co",
  "fifa.com", "uefa.com", "premierleague.com", "laliga.com", "bundesliga.com",
  "legaseriea.it", "ligue1.com", "espnfc.com", "goal.com", "fotmob.com", "espncricinfo.com",
];
const LOW_RELIABILITY_HINTS = ["forum", "reddit.com", "twitter.com", "x.com", "facebook.com", "quora.com", "pinterest.com"];

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function scoreSource(url) {
  const domain = domainOf(url);
  if (!domain) return 50;
  if (LOW_RELIABILITY_HINTS.some((h) => domain.includes(h))) return 20;
  if (HIGH_RELIABILITY_DOMAINS.some((h) => domain.includes(h))) return 90;
  return 60; // unrecognized but not flagged — neutral
}

/** Dedupe citations by URL and attach a per-source reliability score. */
function scoreAndDedupeCitations(citations) {
  const seen = new Set();
  const out = [];
  for (const c of citations || []) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ ...c, reliability: scoreSource(c.url) });
  }
  return out;
}

function avgSourceReliability(citations) {
  if (!citations?.length) return null;
  return round(citations.reduce((s, c) => s + (c.reliability ?? 50), 0) / citations.length, 0);
}

// -----------------------------------------------------------------------
// Sanity/range repair — deterministic, defense-in-depth against a value
// slipping past the extraction prompt's instructions (whether hallucinated
// or just a unit/scale mistake, e.g. "45" meant as a percentage already
// being 0-1). Anything implausible is nulled out (never guessed at a
// "corrected" value) and logged as a repair for transparency.
// -----------------------------------------------------------------------
const RANGE_RULES = [
  { path: "home_team.avg_goals_scored", min: 0, max: 6 },
  { path: "home_team.avg_goals_conceded", min: 0, max: 6 },
  { path: "away_team.avg_goals_scored", min: 0, max: 6 },
  { path: "away_team.avg_goals_conceded", min: 0, max: 6 },
  { path: "home_team.home_avg_goals_scored", min: 0, max: 7 },
  { path: "home_team.home_avg_goals_conceded", min: 0, max: 7 },
  { path: "away_team.away_avg_goals_scored", min: 0, max: 7 },
  { path: "away_team.away_avg_goals_conceded", min: 0, max: 7 },
  { path: "home_team.clean_sheets_pct", min: 0, max: 100 },
  { path: "away_team.clean_sheets_pct", min: 0, max: 100 },
  { path: "home_team.btts_pct", min: 0, max: 100 },
  { path: "away_team.btts_pct", min: 0, max: 100 },
  { path: "home_team.league_position", min: 1, max: 128 },
  { path: "away_team.league_position", min: 1, max: 128 },
  { path: "home_team.fifa_ranking", min: 1, max: 250 },
  { path: "away_team.fifa_ranking", min: 1, max: 250 },
  { path: "head_to_head.avg_goals", min: 0, max: 10 },
  { path: "head_to_head.btts_pct", min: 0, max: 100 },
  { path: "days_rest_home", min: 0, max: 60 },
  { path: "days_rest_away", min: 0, max: 60 },
  { path: "home_team.avg_corners_for", min: 0, max: 14 },
  { path: "home_team.avg_corners_against", min: 0, max: 14 },
  { path: "away_team.avg_corners_for", min: 0, max: 14 },
  { path: "away_team.avg_corners_against", min: 0, max: 14 },
  { path: "home_team.avg_cards", min: 0, max: 8 },
  { path: "away_team.avg_cards", min: 0, max: 8 },
  { path: "home_team.avg_shots_on_target", min: 0, max: 16 },
  { path: "away_team.avg_shots_on_target", min: 0, max: 16 },
  { path: "home_team.first_half_goals_pct", min: 0, max: 100 },
  { path: "away_team.first_half_goals_pct", min: 0, max: 100 },
  { path: "home_top_scorer.goals", min: 0, max: 60 },
  { path: "away_top_scorer.goals", min: 0, max: 60 },
];

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") return;
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const RESULT_CHARS = new Set(["W", "D", "L"]);
function isValidResultsArray(arr) {
  return Array.isArray(arr) && arr.every((r) => RESULT_CHARS.has(r));
}

/**
 * Run every deterministic check against a freshly extracted retrieval
 * object: range validation (repair by nulling, never by guessing a
 * "corrected" number), results-array shape checks, and one internal
 * consistency check (does points roughly match win/draw/loss counts, when
 * both are present). Returns { data, repairs } — `data` is safe to use
 * downstream, `repairs` is a human-readable audit trail stored in
 * retrievalMeta for transparency.
 */
function sanityCheckAndRepair(retrievalData) {
  const data = JSON.parse(JSON.stringify(retrievalData)); // deep clone — never mutate the caller's object
  const repairs = [];

  for (const rule of RANGE_RULES) {
    const v = getPath(data, rule.path);
    if (typeof v === "number" && (v < rule.min || v > rule.max || Number.isNaN(v))) {
      repairs.push(`${rule.path} = ${v} is outside a plausible range [${rule.min}, ${rule.max}] — nulled rather than guessed.`);
      setPath(data, rule.path, null);
    }
  }

  for (const side of ["home_team", "away_team"]) {
    for (const field of ["last_5_results", "last_10_results"]) {
      const v = data[side]?.[field];
      if (v != null && !isValidResultsArray(v)) {
        repairs.push(`${side}.${field} contained values other than W/D/L — nulled.`);
        setPath(data, `${side}.${field}`, null);
      }
    }
  }

  // Internal consistency check: if a team reports points, wins, draws, and
  // losses all at once, points should equal wins*3 + draws (standard
  // 3-points-for-a-win scoring). A large mismatch suggests the extraction
  // pulled numbers from two different points in the season, or hallucinated
  // one of the fields — flag it and null the least-corroborated field
  // (points itself, since wins/draws/losses are more directly checkable
  // against last_5_results).
  for (const side of ["home_team", "away_team"]) {
    const team = data[side];
    if (!team) continue;
    const { points, wins, draws, losses } = team;
    if ([points, wins, draws, losses].every((v) => typeof v === "number")) {
      const expected = wins * 3 + draws;
      if (Math.abs(expected - points) > 3) {
        repairs.push(`${side}: reported points (${points}) don't match wins/draws (expected ~${expected}) — points nulled as unreliable.`);
        setPath(data, `${side}.points`, null);
      }
    }
  }

  data._citations = scoreAndDedupeCitations(data._citations);

  return { data, repairs };
}

module.exports = { sanityCheckAndRepair, scoreAndDedupeCitations, avgSourceReliability, scoreSource };
