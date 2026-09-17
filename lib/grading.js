const { round } = require("./utils");

/**
 * Turn a user-entered final scoreline ("2-1") into every fact needed to
 * grade any market the app can predict. Returns null for anything that
 * doesn't match strict "<int>-<int>" (whitespace around the dash tolerated).
 */
function parseActualResult(actualResult) {
  if (typeof actualResult !== "string") return null;
  const m = actualResult.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const home = parseInt(m[1], 10);
  const away = parseInt(m[2], 10);
  const totalGoals = home + away;
  return {
    home,
    away,
    scoreline: `${home}-${away}`,
    winner: home > away ? "home" : home < away ? "away" : "draw",
    totalGoals,
    btts: home > 0 && away > 0,
    over05: totalGoals > 0.5,
    over15: totalGoals > 1.5,
    over25: totalGoals > 2.5,
    over35: totalGoals > 3.5,
  };
}

const OU_KEY_BY_THRESHOLD = { "0.5": "o05", "1.5": "o15", "2.5": "o25", "3.5": "o35" };
const OU_MARKET_RE = /^Over\/Under (\d+\.\d) Goals$/;

/** Given a displayed pick ({market, selection}) and a parsed actual result, was it correct? Returns boolean or null (ungradeable). */
function pickWasCorrect(pick, parsed) {
  if (!parsed || !pick) return null;

  if (pick.market === "Match Winner (1X2)") {
    const map = { "Home Win": "home", Draw: "draw", "Away Win": "away" };
    if (!(pick.selection in map)) return null;
    return map[pick.selection] === parsed.winner;
  }

  if (pick.market === "Both Teams To Score") {
    return (pick.selection === "Yes") === parsed.btts;
  }

  if (pick.market === "Double Chance") {
    const map = {
      "Home or Draw": (w) => w === "home" || w === "draw",
      "Draw or Away": (w) => w === "draw" || w === "away",
      "Home or Away": (w) => w === "home" || w === "away",
    };
    const fn = map[pick.selection];
    return fn ? fn(parsed.winner) : null;
  }

  const ouMatch = pick.market.match(OU_MARKET_RE);
  if (ouMatch) {
    const key = "over" + ouMatch[1].replace(".", "");
    if (!(key in parsed)) return null;
    return (pick.selection === "Over") === parsed[key];
  }

  if (pick.market === "Winning Margin 1-2 Goals") {
    const margin = Math.abs(parsed.home - parsed.away);
    const isYes = margin === 1 || margin === 2;
    return (pick.selection === "Yes") === isYes;
  }

  if (pick.marketFamily === "Handicap") {
    if (typeof pick.handicapLine !== "number" || !pick.favoredSide) return null;
    const favoredLabel = pick.favoredSide === "home" ? "Home" : "Away";
    const underdogLabel = pick.favoredSide === "home" ? "Away" : "Home";
    const adjusted =
      pick.favoredSide === "home" ? parsed.home - pick.handicapLine - parsed.away : parsed.away - pick.handicapLine - parsed.home;
    const actualSelection = adjusted > 0 ? `${favoredLabel} -${pick.handicapLine}` : adjusted === 0 ? "Push" : `${underdogLabel} +${pick.handicapLine}`;
    return pick.selection === actualSelection;
  }

  // Corners, Cards, Shots on Target, Half-Time Result, Win Both/Either Half
  // are NOT auto-gradable from a final full-time scoreline alone — grading
  // them accurately would need the actual corner/card count or half-time
  // score, which isn't part of the simple "final result" input this app
  // collects. They're still predicted and shown; they just aren't scored
  // for accuracy tracking, same as Correct Score.
  return null;
}

/** What selection would this model's raw output have picked for a given market? Returns a selection string or null. */
function modelSelectionForMarket(modelOutput, market) {
  if (!modelOutput) return null;

  if (market === "Match Winner (1X2)") {
    const probs = { "Home Win": modelOutput.home_win_prob, Draw: modelOutput.draw_prob, "Away Win": modelOutput.away_win_prob };
    if (Object.values(probs).some((v) => typeof v !== "number")) return null;
    return Object.entries(probs).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  }

  if (market === "Both Teams To Score") {
    if (typeof modelOutput.btts_prob !== "number") return null;
    return modelOutput.btts_prob >= 50 ? "Yes" : "No";
  }

  if (market === "Double Chance") {
    const dc = modelOutput.double_chance;
    if (!dc) return null;
    const probs = { "Home or Draw": dc.home_or_draw, "Draw or Away": dc.draw_or_away, "Home or Away": dc.home_or_away };
    if (Object.values(probs).some((v) => typeof v !== "number")) return null;
    return Object.entries(probs).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  }

  const ouMatch = market.match(OU_MARKET_RE);
  if (ouMatch) {
    const key = OU_KEY_BY_THRESHOLD[ouMatch[1]];
    const v = modelOutput.over_under?.[key]?.over_pct;
    if (typeof v !== "number") return null;
    return v >= 50 ? "Over" : "Under";
  }

  return null;
}

/** Did this specific model's own output get this market right, per the actual result? Returns boolean or null. */
function modelPickedMarketCorrectly(modelOutput, market, parsed) {
  const selection = modelSelectionForMarket(modelOutput, market);
  if (selection === null) return null;
  return pickWasCorrect({ market, selection }, parsed);
}

/** Flatten every pick shown across all three consensus tiers into one array. */
function getAllPicks(record) {
  const c = record?.consensus;
  if (!c) return [];
  return [...(c.highest_confidence || []), ...(c.medium_confidence || []), ...(c.higher_risk || [])];
}

/** Distinct market names a record had a pick for, with a sane fallback. */
function marketsForRecord(record) {
  const names = [...new Set(getAllPicks(record).map((p) => p.market))];
  return names.length ? names : ["Match Winner (1X2)"];
}

/** Brier score (lower is better; 0=perfect, 0.25=random-guess baseline at 50%). */
function brierScore(entries) {
  const usable = entries.filter((e) => typeof e.confidence === "number");
  if (!usable.length) return null;
  const sum = usable.reduce((s, e) => s + (e.confidence / 100 - (e.correct ? 1 : 0)) ** 2, 0);
  return round(sum / usable.length, 4);
}

/** Convert a Brier score into an intuitive 0-100 "calibration score" (100 = perfectly calibrated, 0 = worse than random). */
function calibrationScoreFromBrier(brier) {
  if (brier === null || brier === undefined) return null;
  return round(Math.max(0, Math.min(100, 100 * (1 - brier / 0.25))), 1);
}

module.exports = {
  parseActualResult,
  pickWasCorrect,
  modelSelectionForMarket,
  modelPickedMarketCorrectly,
  getAllPicks,
  marketsForRecord,
  brierScore,
  calibrationScoreFromBrier,
};
