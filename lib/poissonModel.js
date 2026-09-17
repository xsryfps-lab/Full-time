const { round, clamp } = require("./utils");

// Standard football analytics technique: model each team's goals as a
// Poisson-distributed random variable, with the expected value (lambda)
// derived from their scoring/conceding rates. This is the same core idea
// behind most bookmaker and analytics-site baseline models — pure
// statistics, not AI, zero cost, zero latency, fully deterministic.
//
// IMPROVEMENT over a naive independent-Poisson model: real match data shows
// low-scoring results (0-0, 1-0, 0-1, 1-1) are slightly more/less common
// than independence predicts, because a team leading late tends to play
// more conservatively. This is the well-known Dixon-Coles (1997) low-score
// correlation adjustment, applied here with a fixed, conservative rho.

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
// Small memoization table — factorial(0..8) is all we ever need, computed once.
const FACT = Array.from({ length: 9 }, (_, i) => factorial(i));

function poissonPmf(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / FACT[k];
}

// Dixon-Coles tau correction factor for low scores (0-0, 1-0, 0-1, 1-1 only;
// all other scorelines are untouched, tau=1). rho is a small negative
// constant reflecting the empirically observed tendency for low-scoring
// draws to be slightly more frequent than pure independence predicts.
const DIXON_COLES_BASE_RHO = -0.06;
function dixonColesTau(h, a, lambdaHome, lambdaAway, rho) {
  if (h === 0 && a === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (h === 0 && a === 1) return 1 + lambdaHome * rho;
  if (h === 1 && a === 0) return 1 + lambdaAway * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

// The Dixon-Coles low-score correlation effect is empirically stronger in
// genuinely low-scoring matches and weaker in high-scoring ones — scale the
// base rho by how low the combined expected-goals level is for this
// specific fixture, rather than applying one fixed correction to every
// match regardless of how open or closed it's expected to be.
function adaptiveRho(lambdaHome, lambdaAway) {
  const combined = lambdaHome + lambdaAway;
  const scale = clamp(2.2 - combined * 0.35, 0.4, 1.6);
  return DIXON_COLES_BASE_RHO * scale;
}

const MAX_GOALS = 8; // truncate the distribution here — probability beyond this is negligible

/** Build the Dixon-Coles-corrected, renormalized scoreline grid for a pair of lambdas. Reused by both the Poisson prediction itself and the auxiliary markets module (winning margin, handicap). */
function buildScorelineGrid(lambdaHome, lambdaAway) {
  const rho = adaptiveRho(lambdaHome, lambdaAway);
  const grid = [];
  let gridSum = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    grid[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      const base = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
      const tau = dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      const p = Math.max(0, base * tau);
      grid[h][a] = p;
      gridSum += p;
    }
  }
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      grid[h][a] = grid[h][a] / gridSum;
    }
  }
  return grid;
}

/**
 * Derive expected goals (lambda) for each side from whatever scoring/
 * conceding data was retrieved. Prefers home/away splits when available,
 * falls back to overall averages (needed for international matches, which
 * don't have home/away splits). Also applies two further refinements when
 * applicable: a home-advantage correction when a real home/away split
 * wasn't available, and a blend toward the fixture's own head-to-head
 * scoring history. Returns null if there isn't enough data to build a
 * meaningful model at all.
 */
function deriveLambdas(retrievalData) {
  const home = retrievalData.home_team || {};
  const away = retrievalData.away_team || {};
  const h2h = retrievalData.head_to_head || {};

  const homeScored = home.home_avg_goals_scored ?? home.avg_goals_scored;
  const awayConceded = away.away_avg_goals_conceded ?? away.avg_goals_conceded;
  const awayScored = away.away_avg_goals_scored ?? away.avg_goals_scored;
  const homeConceded = home.home_avg_goals_conceded ?? home.avg_goals_conceded;

  if ([homeScored, awayConceded, awayScored, homeConceded].some((v) => typeof v !== "number")) {
    return null; // not enough data to build a meaningful model
  }

  // Blend each side's attack rate with the opponent's defensive weakness —
  // the standard simplified attack/defense Poisson approach.
  let lambdaHome = clamp((homeScored + awayConceded) / 2, 0.15, 5);
  let lambdaAway = clamp((awayScored + homeConceded) / 2, 0.15, 5);

  // Home-advantage correction: when either side is missing a real
  // home/away split (always true for international matches, sometimes for
  // club matches with thin data), the fallback to overall averages loses
  // the implicit home-field advantage a real split would have encoded —
  // restore a modest version of it directly.
  const homeHasSplit = typeof home.home_avg_goals_scored === "number" && typeof home.home_avg_goals_conceded === "number";
  const awayHasSplit = typeof away.away_avg_goals_scored === "number" && typeof away.away_avg_goals_conceded === "number";
  const usedFallback = !homeHasSplit || !awayHasSplit;
  if (usedFallback) {
    lambdaHome *= 1.08;
    lambdaAway *= 0.94;
  }

  // Head-to-head blending: nudge the TOTAL expected-goals level toward this
  // fixture's own head-to-head scoring history, preserving the home/away
  // ratio already established. Weighted lightly — a handful of past
  // meetings is a much smaller, noisier sample than a full season of form.
  const usedH2hBlend = typeof h2h.avg_goals === "number" && h2h.avg_goals > 0;
  if (usedH2hBlend) {
    const currentTotal = lambdaHome + lambdaAway;
    const H2H_WEIGHT = 0.15;
    const blendedTotal = currentTotal * (1 - H2H_WEIGHT) + h2h.avg_goals * H2H_WEIGHT;
    const scaleFactor = currentTotal > 0 ? blendedTotal / currentTotal : 1;
    lambdaHome *= scaleFactor;
    lambdaAway *= scaleFactor;
  }

  return { lambdaHome, lambdaAway, usedFallback, usedH2hBlend };
}

/**
 * Compute a full prediction in the SAME schema shape the AI analysis models
 * use, so it plugs directly into the existing Consensus Engine, weighting,
 * grading, and UI with no special-casing needed anywhere else.
 */
function computePoissonPrediction(retrievalData, engineeredFeatures) {
  const lambdas = deriveLambdas(retrievalData);
  if (!lambdas) return null;
  const { lambdaHome, lambdaAway, usedFallback, usedH2hBlend } = lambdas;

  // Build the joint scoreline probability grid, with the Dixon-Coles
  // low-score correction applied and the grid renormalized to sum to 1
  // afterward (the tau correction slightly perturbs the total mass).
  const grid = buildScorelineGrid(lambdaHome, lambdaAway);

  let homeWin = 0,
    draw = 0,
    awayWin = 0,
    btts = 0;
  const totalGoalsProb = {}; // totalGoalsProb[n] = P(total goals == n)
  const scorelines = [];

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = grid[h][a];
      if (h > a) homeWin += p;
      else if (h < a) awayWin += p;
      else draw += p;
      if (h >= 1 && a >= 1) btts += p;
      const total = h + a;
      totalGoalsProb[total] = (totalGoalsProb[total] || 0) + p;
      scorelines.push({ score: `${h}-${a}`, prob: p });
    }
  }

  const overProb = (threshold) => {
    let p = 0;
    for (let n = 0; n <= MAX_GOALS * 2; n++) {
      if (n > threshold) p += totalGoalsProb[n] || 0;
    }
    return p;
  };

  // Top 5 most likely scorelines, for a human-readable output and for the
  // Correct Score market in the UI.
  scorelines.sort((x, y) => y.prob - x.prob);
  const topScorelines = scorelines.slice(0, 5);

  // Confidence: how differentiated the two lambdas are (a close match is
  // genuinely less predictable), tempered by data quality.
  const lambdaSpread = Math.abs(lambdaHome - lambdaAway);
  const dataQuality = engineeredFeatures?.data_quality_score ?? 70;
  let confidence = clamp(50 + lambdaSpread * 12 + (dataQuality - 70) * 0.15, 35, 85);
  // A fallback (non-split) lambda estimate is less precise even after the
  // home-advantage correction above — reflect that with a small confidence
  // haircut rather than presenting it as equally certain.
  if (usedFallback) confidence -= 4;
  confidence = round(clamp(confidence, 35, 85), 0);

  const statsUsed = [`Expected goals: ${round(lambdaHome, 2)} home / ${round(lambdaAway, 2)} away (Poisson + adaptive Dixon-Coles model)`];
  if (usedFallback) statsUsed.push("Home-advantage correction applied (no home/away split available)");
  if (usedH2hBlend) statsUsed.push("Head-to-head history blended into the expected-goals estimate");

  return {
    home_win_prob: round(homeWin * 100, 1),
    draw_prob: round(draw * 100, 1),
    away_win_prob: round(awayWin * 100, 1),
    double_chance: {
      home_or_draw: round((homeWin + draw) * 100, 1),
      draw_or_away: round((draw + awayWin) * 100, 1),
      home_or_away: round((homeWin + awayWin) * 100, 1),
    },
    btts_prob: round(btts * 100, 1),
    over_under: {
      o05: { over_pct: round(overProb(0.5) * 100, 1) },
      o15: { over_pct: round(overProb(1.5) * 100, 1) },
      o25: { over_pct: round(overProb(2.5) * 100, 1) },
      o35: { over_pct: round(overProb(3.5) * 100, 1) },
    },
    expected_first_half_goals: round((lambdaHome + lambdaAway) * 0.45, 2),
    expected_second_half_goals: round((lambdaHome + lambdaAway) * 0.55, 2),
    likely_scorelines: topScorelines.map((s) => s.score),
    correct_score_probabilities: topScorelines.map((s) => ({ score: s.score, probability_pct: round(s.prob * 100, 1) })),
    confidence,
    key_stats_used: statsUsed,
    weaknesses: ["Purely statistical — does not account for injuries, motivation, tactics, or news beyond what's already reflected in scoring rates"],
    missing_data_impact: "none beyond what already affects the lambda inputs",
  };
}

// General-purpose versions (uncapped k) for auxiliary markets that run
// higher than goals typically do (corners, cards) — kept separate from the
// FACT-array-capped poissonPmf above so the goal model's hot path stays
// exactly as fast/simple as before.
function factorialGeneral(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
function poissonPmfGeneral(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorialGeneral(k);
}
/** P(X <= maxK) for a Poisson(lambda) variable, summed directly (no closed form). */
function poissonCdf(maxK, lambda) {
  let sum = 0;
  for (let k = 0; k <= maxK; k++) sum += poissonPmfGeneral(k, lambda);
  return sum;
}

module.exports = {
  computePoissonPrediction,
  deriveLambdas,
  dixonColesTau,
  DIXON_COLES_BASE_RHO,
  adaptiveRho,
  poissonPmfGeneral,
  poissonCdf,
  buildScorelineGrid,
  MAX_GOALS,
};
