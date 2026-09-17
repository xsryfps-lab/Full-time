const { round } = require("../utils");
const { loadSettings } = require("../settings");

// The fields we consider "core" for a usable prediction — different for club
// vs international football, since league position/points/home-away splits
// simply don't exist for national teams. Completeness is calculated
// deterministically (fraction of these present, not null) rather than
// trusting a model's self-reported quality claim. Each field also carries a
// weight — fields that most directly feed the Poisson baseline and the
// consensus (scoring/conceding rates, form) count for more than peripheral
// context fields, so completeness better reflects "usable for a real
// prediction" rather than just "how many boxes got filled in."
function coreFields(matchType) {
  const base = [
    { path: "head_to_head.summary", weight: 1 },
    { path: "head_to_head.avg_goals", weight: 1 },
  ];
  if (matchType === "international") {
    return [
      { path: "home_team.fifa_ranking", weight: 1 },
      { path: "home_team.avg_goals_scored", weight: 2 },
      { path: "home_team.avg_goals_conceded", weight: 2 },
      { path: "home_team.last_5_results", weight: 1.5 },
      { path: "home_team.clean_sheets_pct", weight: 1 },
      { path: "home_team.btts_pct", weight: 1 },
      { path: "away_team.fifa_ranking", weight: 1 },
      { path: "away_team.avg_goals_scored", weight: 2 },
      { path: "away_team.avg_goals_conceded", weight: 2 },
      { path: "away_team.last_5_results", weight: 1.5 },
      { path: "away_team.clean_sheets_pct", weight: 1 },
      { path: "away_team.btts_pct", weight: 1 },
      ...base,
    ];
  }
  return [
    { path: "home_team.league_position", weight: 1 },
    { path: "home_team.points", weight: 1 },
    { path: "home_team.avg_goals_scored", weight: 2 },
    { path: "home_team.avg_goals_conceded", weight: 2 },
    { path: "home_team.last_5_results", weight: 1.5 },
    { path: "home_team.clean_sheets_pct", weight: 1 },
    { path: "home_team.btts_pct", weight: 1 },
    { path: "away_team.league_position", weight: 1 },
    { path: "away_team.points", weight: 1 },
    { path: "away_team.avg_goals_scored", weight: 2 },
    { path: "away_team.avg_goals_conceded", weight: 2 },
    { path: "away_team.last_5_results", weight: 1.5 },
    { path: "away_team.clean_sheets_pct", weight: 1 },
    { path: "away_team.btts_pct", weight: 1 },
    ...base,
  ];
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/** Weighted completeness score (0-100): fraction of core-field WEIGHT (for this match type) that is non-null. */
function computeCompleteness(retrievalData, matchType = "club") {
  const fields = coreFields(matchType);
  const totalWeight = fields.reduce((s, f) => s + f.weight, 0);
  const presentWeight = fields.reduce((s, f) => {
    const v = getPath(retrievalData, f.path);
    return v !== null && v !== undefined ? s + f.weight : s;
  }, 0);
  return round((presentWeight / totalWeight) * 100, 0);
}

/**
 * Decide what to do with a retrieval attempt's result. Thresholds are
 * user-configurable (Settings page) — see lib/settings.js. Returns
 * { completeness, shouldRetry, shouldReject }.
 */
function validateRetrieval(retrievalData, attemptNumber, maxAttempts, matchType = "club") {
  const settings = loadSettings();
  const completeness = computeCompleteness(retrievalData, matchType);
  const attemptsRemaining = attemptNumber < maxAttempts;
  return {
    completeness,
    shouldRetry: completeness < settings.retryThreshold && attemptsRemaining,
    shouldReject: completeness < settings.rejectThreshold && !attemptsRemaining,
    rejectFloor: settings.rejectThreshold,
  };
}

module.exports = { computeCompleteness, validateRetrieval, coreFields };
