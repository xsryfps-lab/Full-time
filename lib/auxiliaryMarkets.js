const { round, roundToHalfLine, clamp } = require("./utils");
const { poissonPmfGeneral, poissonCdf } = require("./poissonModel");

/**
 * These markets are deliberately NOT asked of the four AI providers. LLMs
 * have no real grounding for guessing a corner or card count the way they
 * can reason about goals from a team's attacking/defensive narrative — so
 * for every genuinely countable stat we already collect (corners, cards,
 * shots on target) and for anything mechanically derivable from the same
 * Poisson goal model (half-time result, winning margin, handicap), this
 * module computes it the same rigorous, deterministic way the core Poisson
 * model computes goals. This is a single, transparent voice for these
 * specific markets — there's no "agreement" between models to report since
 * there's only one source, same as the existing Correct Score market.
 */

const MAX_TOTAL = 30; // corners/cards/shots run higher than goals — truncate further out

function totalOverUnder(combinedLambda) {
  if (typeof combinedLambda !== "number" || combinedLambda <= 0) return null;
  const line = roundToHalfLine(combinedLambda);
  const overProb = round((1 - poissonCdf(Math.floor(line), combinedLambda)) * 100, 1);
  return { line, overProb };
}

/** Corners: Over/Under at a dynamically chosen bookmaker-style line. */
function computeCornersMarket(engineeredFeatures) {
  const { expected_corners_home: h, expected_corners_away: a } = engineeredFeatures || {};
  if (typeof h !== "number" || typeof a !== "number") return null;
  const result = totalOverUnder(h + a);
  if (!result) return null;
  return { market: `Corners Over/Under ${result.line}`, marketFamily: "Corners", selection: result.overProb >= 50 ? "Over" : "Under", probability_pct: result.overProb >= 50 ? result.overProb : round(100 - result.overProb, 1), line: result.line };
}

/** Cards (yellow + red combined): Over/Under at a dynamically chosen line. */
function computeCardsMarket(engineeredFeatures) {
  const total = engineeredFeatures?.expected_cards_total;
  if (typeof total !== "number") return null;
  const result = totalOverUnder(total);
  if (!result) return null;
  return { market: `Cards Over/Under ${result.line}`, marketFamily: "Cards", selection: result.overProb >= 50 ? "Over" : "Under", probability_pct: result.overProb >= 50 ? result.overProb : round(100 - result.overProb, 1), line: result.line };
}

/** Total shots on target (both teams combined): Over/Under at a dynamically chosen line. */
function computeShotsOnTargetMarket(engineeredFeatures) {
  const { expected_shots_on_target_home: h, expected_shots_on_target_away: a } = engineeredFeatures || {};
  if (typeof h !== "number" || typeof a !== "number") return null;
  const result = totalOverUnder(h + a);
  if (!result) return null;
  return { market: `Shots on Target Over/Under ${result.line}`, marketFamily: "Shots on Target", selection: result.overProb >= 50 ? "Over" : "Under", probability_pct: result.overProb >= 50 ? result.overProb : round(100 - result.overProb, 1), line: result.line };
}

/** Build a small (0..6 goal) 1X2 grid for a single half from that half's two lambdas. */
function halfResultProbs(lambdaHome, lambdaAway) {
  let home = 0, draw = 0, away = 0;
  const MAX_HALF_GOALS = 6;
  for (let h = 0; h <= MAX_HALF_GOALS; h++) {
    for (let a = 0; a <= MAX_HALF_GOALS; a++) {
      const p = poissonPmfGeneral(h, lambdaHome) * poissonPmfGeneral(a, lambdaAway);
      if (h > a) home += p;
      else if (h < a) away += p;
      else draw += p;
    }
  }
  return { home, draw, away };
}

/**
 * Half-time result, Win Both Halves, and Win Either Half — all derived from
 * splitting the full-match Poisson lambdas into first/second-half lambdas
 * using each team's real first-half goal share when known (else a 45%
 * default), then treating the two halves as independent sub-matches (a
 * standard simplifying assumption).
 */
function computeHalfMarkets(lambdaHome, lambdaAway, engineeredFeatures) {
  if (typeof lambdaHome !== "number" || typeof lambdaAway !== "number") return null;
  const shareHome = engineeredFeatures?.first_half_goal_share_home ?? 0.45;
  const shareAway = engineeredFeatures?.first_half_goal_share_away ?? 0.45;

  const h1 = halfResultProbs(lambdaHome * shareHome, lambdaAway * shareAway);
  const h2 = halfResultProbs(lambdaHome * (1 - shareHome), lambdaAway * (1 - shareAway));

  const halfTimeResult = (() => {
    const entries = [
      { selection: "Home", prob: h1.home },
      { selection: "Draw", prob: h1.draw },
      { selection: "Away", prob: h1.away },
    ];
    const top = entries.reduce((a, b) => (b.prob > a.prob ? b : a));
    return { market: "Half-Time Result", marketFamily: "Half-Time Result", selection: top.selection, probability_pct: round(top.prob * 100, 1) };
  })();

  const pHomeBoth = h1.home * h2.home;
  const pAwayBoth = h1.away * h2.away;
  const pNeitherBoth = round((1 - pHomeBoth - pAwayBoth) * 100, 1);
  const winBothHalves = (() => {
    const entries = [
      { selection: "Home", prob: pHomeBoth },
      { selection: "Away", prob: pAwayBoth },
      { selection: "Neither", prob: 1 - pHomeBoth - pAwayBoth },
    ];
    const top = entries.reduce((a, b) => (b.prob > a.prob ? b : a));
    return { market: "Team to Win Both Halves", marketFamily: "Win Both Halves", selection: top.selection, probability_pct: round(top.prob * 100, 1) };
  })();

  const pHomeEither = 1 - (1 - h1.home) * (1 - h2.home);
  const pAwayEither = 1 - (1 - h1.away) * (1 - h2.away);
  const pNeitherAny = h1.draw * h2.draw; // approximate: both halves drawn means nobody won either half
  const winEitherHalf = (() => {
    const entries = [
      { selection: "Home", prob: pHomeEither },
      { selection: "Away", prob: pAwayEither },
      { selection: "Neither", prob: pNeitherAny },
    ];
    const top = entries.reduce((a, b) => (b.prob > a.prob ? b : a));
    return { market: "Team to Win Either Half", marketFamily: "Win Either Half", selection: top.selection, probability_pct: round(top.prob * 100, 1) };
  })();

  return { halfTimeResult, winBothHalves, winEitherHalf };
}

/**
 * Winning Margin (1-2 goals) — Yes/No, computed directly from the full
 * scoreline grid: does the match finish with a margin of exactly 1 or 2
 * goals (either direction)? Fully gradable from a final scoreline alone.
 */
function computeWinningMarginMarket(grid, maxGoals) {
  if (!grid) return null;
  let margin12 = 0;
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = grid[h][a];
      total += p;
      if (Math.abs(h - a) === 1 || Math.abs(h - a) === 2) margin12 += p;
    }
  }
  const prob = round((margin12 / total) * 100, 1);
  return { market: "Winning Margin 1-2 Goals", marketFamily: "Winning Margin", selection: prob >= 50 ? "Yes" : "No", probability_pct: prob >= 50 ? prob : round(100 - prob, 1) };
}

/**
 * European (non-Asian) Handicap — a 3-way market with NO push-avoidance
 * trick: the handicap line is a whole number chosen from the model's own
 * expected goal difference, so a push (exact tie after handicap) is a
 * real, distinct third outcome, same as a genuine bookmaker "European
 * Handicap" line. Direction favors whichever side the Poisson lambdas
 * actually favor.
 */
function computeHandicapMarket(grid, maxGoals, lambdaHome, lambdaAway) {
  if (!grid) return null;
  const diff = lambdaHome - lambdaAway;
  let handicapLine = Math.round(Math.abs(diff));
  if (handicapLine < 1) handicapLine = 1; // always a real handicap, never a flat 0 line
  const favoredSide = diff >= 0 ? "home" : "away";

  let favoredCovers = 0, push = 0, underdogCovers = 0, total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = grid[h][a];
      total += p;
      const adjusted = favoredSide === "home" ? h - handicapLine - a : a - handicapLine - h;
      if (adjusted > 0) favoredCovers += p;
      else if (adjusted === 0) push += p;
      else underdogCovers += p;
    }
  }
  favoredCovers = (favoredCovers / total) * 100;
  push = (push / total) * 100;
  underdogCovers = (underdogCovers / total) * 100;

  const favoredLabel = favoredSide === "home" ? "Home" : "Away";
  const underdogLabel = favoredSide === "home" ? "Away" : "Home";
  const entries = [
    { selection: `${favoredLabel} -${handicapLine}`, prob: favoredCovers },
    { selection: "Push", prob: push },
    { selection: `${underdogLabel} +${handicapLine}`, prob: underdogCovers },
  ];
  const top = entries.reduce((a, b) => (b.prob > a.prob ? b : a));
  return {
    market: `Handicap (${favoredLabel} -${handicapLine})`,
    marketFamily: "Handicap",
    selection: top.selection,
    probability_pct: round(top.prob, 1),
    handicapLine,
    favoredSide,
  };
}

/**
 * Compute every auxiliary market at once. `grid` and `maxGoals` come from
 * the Poisson model's own scoreline grid (passed in so this module doesn't
 * duplicate that computation) — pass null/skip gracefully if unavailable
 * (e.g. not enough data for Poisson to run at all).
 */
function computeAuxiliaryMarkets({ engineeredFeatures, lambdas, grid, maxGoals }) {
  const picks = [];
  const corners = computeCornersMarket(engineeredFeatures);
  const cards = computeCardsMarket(engineeredFeatures);
  const shots = computeShotsOnTargetMarket(engineeredFeatures);
  [corners, cards, shots].forEach((p) => p && picks.push({ ...p, agreement: null }));

  if (lambdas) {
    const halves = computeHalfMarkets(lambdas.lambdaHome, lambdas.lambdaAway, engineeredFeatures);
    if (halves) {
      picks.push({ ...halves.halfTimeResult, agreement: null });
      picks.push({ ...halves.winBothHalves, agreement: null });
      picks.push({ ...halves.winEitherHalf, agreement: null });
    }
    if (grid) {
      const margin = computeWinningMarginMarket(grid, maxGoals);
      if (margin) picks.push({ ...margin, agreement: null });
      const handicap = computeHandicapMarket(grid, maxGoals, lambdas.lambdaHome, lambdas.lambdaAway);
      if (handicap) picks.push({ ...handicap, agreement: null });
    }
  }

  return picks;
}

module.exports = { computeAuxiliaryMarkets, computeCornersMarket, computeCardsMarket, computeShotsOnTargetMarket, computeHalfMarkets, computeWinningMarginMarket, computeHandicapMarket };
