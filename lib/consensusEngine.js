const { clamp, round } = require("./utils");
const { loadSettings } = require("./settings");

const MARKET_FOR_FIELD = {
  home_win_prob: "Match Winner (1X2)",
  draw_prob: "Match Winner (1X2)",
  away_win_prob: "Match Winner (1X2)",
  btts_prob: "Both Teams To Score",
  "over_under.o05.over_pct": "Over/Under 0.5 Goals",
  "over_under.o15.over_pct": "Over/Under 1.5 Goals",
  "over_under.o25.over_pct": "Over/Under 2.5 Goals",
  "over_under.o35.over_pct": "Over/Under 3.5 Goals",
  "double_chance.home_or_draw": "Double Chance",
  "double_chance.draw_or_away": "Double Chance",
  "double_chance.home_or_away": "Double Chance",
};

// The markets a real sportsbook actually lists as a standalone betting
// line. Over/Under 0.5 Goals is deliberately excluded — it's trivially true
// in the vast majority of matches (both teams combining for 1+ goal), most
// bookmakers don't even offer it as a market, and highlighting it as a
// "Best Pick" or "Safe Pick" isn't useful even though it's technically the
// highest-probability thing the models agree on. It's still computed and
// shown in the full market breakdown for completeness — it just can't be
// selected as the headline recommendation.
const NORMAL_BETTING_MARKETS = new Set([
  "Match Winner (1X2)",
  "Double Chance",
  "Both Teams To Score",
  "Over/Under 1.5 Goals",
  "Over/Under 2.5 Goals",
  "Over/Under 3.5 Goals",
]);

// Auxiliary markets (corners, cards, shots on target, halves, margin,
// handicap) have dynamic market names that bake in the actual line (e.g.
// "Corners Over/Under 9.5"), so they're identified by category
// (marketFamily) rather than an exact string match like the markets above.
const ELIGIBLE_AUX_FAMILIES = new Set([
  "Corners",
  "Cards",
  "Shots on Target",
  "Half-Time Result",
  "Win Both Halves",
  "Win Either Half",
  "Winning Margin",
  "Handicap",
]);

function isBettable(pick) {
  return NORMAL_BETTING_MARKETS.has(pick.market) || ELIGIBLE_AUX_FAMILIES.has(pick.marketFamily);
}

// A Best Pick needs a minimum amount of genuine cross-model agreement to
// qualify, not just a high raw probability — a pick where the models
// spread widely (one model driving the number, others disagreeing) is
// exactly the kind of overconfident-but-contested recommendation that
// makes for a worse bet, even if its raw probability looks good.
const MIN_AGREEMENT_FOR_BEST_PICK = 45;

function recentAdj(stats) {
  if (stats.last10 === null) return 0;
  return (stats.last10 - 50) / 500; // +/- up to 0.1 at the extremes
}

function calibrationAdj(stats, strength) {
  if (stats.calibrationScore === null) return 0;
  return ((stats.calibrationScore - 70) / 1000) * strength;
}

/**
 * Compute the current effective OVERALL weights for every model, with the
 * full breakdown of how each was derived — used by the Dashboard's
 * weighting panel. Market-specific weights (used during an actual
 * prediction, see computeMarketWeights below) aren't shown here since
 * they'd need a market selected; see Model Performance for those.
 */
function explainCurrentWeighting() {
  const { loadWeights, computeModelStats, MODEL_NAMES, modelKeyFor } = require("./database");
  const settings = loadSettings();
  const weights = loadWeights();
  const breakdowns = {};

  for (const name of MODEL_NAMES) {
    const stats = computeModelStats(modelKeyFor(name));
    const rAdj = recentAdj(stats);
    const cAdj = calibrationAdj(stats, settings.calibrationStrength);
    const base = weights.models[name]?.overall ?? 1 / MODEL_NAMES.length;
    const preNormalize = clamp(base + rAdj + cAdj, settings.minModelWeight, settings.maxModelWeight);
    breakdowns[name] = {
      name,
      baseWeight: round(base, 3),
      recentAccuracyAdj: round(rAdj, 3),
      calibrationAdj: round(cAdj, 3),
      preNormalizeWeight: round(preNormalize, 3),
      last10Accuracy: stats.last10,
      calibrationScore: stats.calibrationScore,
      overallAccuracy: stats.overallAccuracy,
      gradedCount: stats.gradedCount,
    };
  }

  const total = Object.values(breakdowns).reduce((sum, b) => sum + b.preNormalizeWeight, 0) || 1;
  for (const name of MODEL_NAMES) {
    breakdowns[name].finalWeight = round(breakdowns[name].preNormalizeWeight / total, 3);
  }
  return breakdowns;
}

/**
 * Compute normalized weights for one specific market, across whichever
 * model names are present. Base weight is the model's LEARNED
 * MARKET-SPECIFIC weight (falling back to its overall weight when there
 * isn't enough graded history for that market yet — see
 * database.getEffectiveWeight), then nudged by overall recent-accuracy and
 * calibration adjustments, clamped, and renormalized.
 */
function computeMarketWeights(modelNames, market, settings) {
  const { getEffectiveWeight, computeModelStats, modelKeyFor } = require("./database");
  const adjusted = {};
  for (const name of modelNames) {
    const stats = computeModelStats(modelKeyFor(name));
    const base = getEffectiveWeight(name, market);
    adjusted[name] = clamp(
      base + recentAdj(stats) + calibrationAdj(stats, settings.calibrationStrength),
      settings.minModelWeight,
      settings.maxModelWeight
    );
  }
  const total = Object.values(adjusted).reduce((a, b) => a + b, 0) || 1;
  const final = {};
  for (const name of modelNames) final[name] = adjusted[name] / total;
  return final;
}

function normalizeWinnerProbs(modelOutput) {
  if (!modelOutput) return modelOutput;
  const { home_win_prob, draw_prob, away_win_prob } = modelOutput;
  if ([home_win_prob, draw_prob, away_win_prob].some((v) => typeof v !== "number")) return modelOutput;
  const sum = home_win_prob + draw_prob + away_win_prob;
  if (sum <= 0 || (sum > 98 && sum < 102)) return modelOutput;
  return {
    ...modelOutput,
    home_win_prob: round((home_win_prob / sum) * 100, 1),
    draw_prob: round((draw_prob / sum) * 100, 1),
    away_win_prob: round((away_win_prob / sum) * 100, 1),
  };
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/**
 * The Consensus Engine — the final decision. Pure deterministic math, not
 * an AI call, and works across ANY number of independent models. Weighting
 * is MARKET-SPECIFIC: a model's influence on the Match Winner market can
 * differ from its influence on Over/Under 2.5, based on where it's
 * actually been more accurate historically.
 *
 * @param {{models: Object.<string,object>, engineeredFeatures: object, sourceReliability?: number, auxiliaryMarkets?: Array}} args
 */
function runConsensus({ models: rawModels, engineeredFeatures, sourceReliability = null, auxiliaryMarkets = [] }) {
  const settings = loadSettings();
  const modelNames = Object.keys(rawModels).filter((n) => rawModels[n]);
  const models = {};
  for (const name of modelNames) models[name] = normalizeWinnerProbs(rawModels[name]);

  const marketWeightCache = {};
  const weightsFor = (market) => {
    if (!marketWeightCache[market]) marketWeightCache[market] = computeMarketWeights(modelNames, market, settings);
    return marketWeightCache[market];
  };

  const weightedProb = (fieldPath) => {
    const market = MARKET_FOR_FIELD[fieldPath];
    const weights = weightsFor(market);
    let sum = 0;
    let weightSum = 0;
    for (const name of modelNames) {
      const v = getPath(models[name], fieldPath);
      if (typeof v === "number") {
        sum += v * weights[name];
        weightSum += weights[name];
      }
    }
    if (weightSum === 0) return null;
    return round(sum / weightSum, 1);
  };

  const agreementFor = (fieldPath) => {
    const vals = modelNames.map((name) => getPath(models[name], fieldPath)).filter((v) => typeof v === "number");
    if (vals.length < 2) return null;
    const spread = Math.max(...vals) - Math.min(...vals);
    return round(clamp(100 - spread, 0, 100), 0);
  };

  const finalProbs = {
    home_win_prob: weightedProb("home_win_prob"),
    draw_prob: weightedProb("draw_prob"),
    away_win_prob: weightedProb("away_win_prob"),
    btts_prob: weightedProb("btts_prob"),
    over_0_5_prob: weightedProb("over_under.o05.over_pct"),
    over_1_5_prob: weightedProb("over_under.o15.over_pct"),
    over_2_5_prob: weightedProb("over_under.o25.over_pct"),
    over_3_5_prob: weightedProb("over_under.o35.over_pct"),
    double_chance_home_or_draw: weightedProb("double_chance.home_or_draw"),
    double_chance_draw_or_away: weightedProb("double_chance.draw_or_away"),
    double_chance_home_or_away: weightedProb("double_chance.home_or_away"),
  };

  const keyAgreements = {
    match_winner: agreementFor("home_win_prob"),
    btts: agreementFor("btts_prob"),
    over_1_5: agreementFor("over_under.o15.over_pct"),
    over_2_5: agreementFor("over_under.o25.over_pct"),
    over_3_5: agreementFor("over_under.o35.over_pct"),
    double_chance_hd: agreementFor("double_chance.home_or_draw"),
    double_chance_da: agreementFor("double_chance.draw_or_away"),
    double_chance_ha: agreementFor("double_chance.home_or_away"),
  };
  const agreementValues = Object.values(keyAgreements).filter((v) => typeof v === "number");
  const overallAgreement = agreementValues.length
    ? round(agreementValues.reduce((a, b) => a + b, 0) / agreementValues.length, 0)
    : null;

  const dataQuality = engineeredFeatures?.data_quality_score ?? null;

  const headlineWeights = weightsFor("Match Winner (1X2)");
  let confSum = 0;
  let confWeightSum = 0;
  for (const name of modelNames) {
    const c = models[name]?.confidence;
    if (typeof c === "number") {
      confSum += c * headlineWeights[name];
      confWeightSum += headlineWeights[name];
    }
  }
  let overallConfidence = confWeightSum > 0 ? confSum / confWeightSum : 50;
  if (overallAgreement !== null) overallConfidence += (overallAgreement - 70) * 0.3;
  if (dataQuality !== null) overallConfidence += (dataQuality - 70) * 0.2;
  // Retrieval source reliability is a second, independent honesty check on
  // top of raw completeness — data that's "complete" but drawn from
  // low-reliability sources shouldn't inspire the same confidence as
  // complete data from known football-stats sources.
  if (typeof sourceReliability === "number") overallConfidence += (sourceReliability - 70) * 0.1;
  const { MODEL_NAMES } = require("./database");
  const fullHouse = MODEL_NAMES.length;
  if (modelNames.length < fullHouse) overallConfidence -= (fullHouse - modelNames.length) * 2.5;
  overallConfidence = round(clamp(overallConfidence, 0, 100), 0);

  const correctScoreProbabilities = mergeCorrectScores(models);

  const picks = [...buildPickList({ finalProbs, keyAgreements }), ...(auxiliaryMarkets || [])];
  const tiered = tierPicks(picks); // full breakdown across every market, including Over/Under 0.5 — for display only
  const bettablePicks = picks.filter(isBettable);
  const bettableTiered = tierPicks(bettablePicks);
  const bestPick = pickBest(bettableTiered.highest_confidence);
  const safePicks = buildSafePicks(bettablePicks);

  const weightsUsed = {};
  for (const name of modelNames) weightsUsed[name] = round(headlineWeights[name], 3);
  const marketWeights = {};
  for (const market of new Set(Object.values(MARKET_FOR_FIELD))) {
    const w = weightsFor(market);
    marketWeights[market] = Object.fromEntries(modelNames.map((n) => [n, round(w[n], 3)]));
  }

  const divergence = {};
  for (const name of modelNames) {
    const m = models[name];
    if (typeof m?.home_win_prob === "number" && typeof finalProbs.home_win_prob === "number") {
      divergence[name] = round(Math.abs(m.home_win_prob - finalProbs.home_win_prob), 1);
    }
  }
  const mostDivergentModel = Object.keys(divergence).length
    ? Object.entries(divergence).reduce((a, b) => (b[1] > a[1] ? b : a))[0]
    : null;

  return {
    modelCount: modelNames.length,
    weightsUsed,
    marketWeights,
    finalProbabilities: finalProbs,
    agreementScore: overallAgreement,
    keyAgreements,
    dataQualityScore: dataQuality,
    sourceReliability,
    overallConfidence,
    bestPick,
    safePicks,
    correctScoreProbabilities,
    highest_confidence: tiered.highest_confidence,
    medium_confidence: tiered.medium_confidence,
    higher_risk: tiered.higher_risk,
    diagnostics: { modelDivergenceFromConsensus: divergence, mostDivergentModel },
    overall_summary: buildSummary({ overallAgreement, overallConfidence, dataQuality, bestPick, modelCount: modelNames.length }),
  };
}

function mergeCorrectScores(models) {
  const poisson = models.Poisson;
  if (poisson?.correct_score_probabilities) return poisson.correct_score_probabilities;
  const tally = {};
  for (const name of Object.keys(models)) {
    const list = models[name]?.likely_scorelines;
    if (!Array.isArray(list)) continue;
    for (const s of list) tally[s] = (tally[s] || 0) + 1;
  }
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const totalVotes = entries.reduce((s, [, c]) => s + c, 0) || 1;
  return entries.map(([score, count]) => ({ score, probability_pct: round((count / totalVotes) * 100, 1) }));
}

function buildPickList({ finalProbs, keyAgreements }) {
  const picks = [];

  const winnerEntries = [
    { selection: "Home Win", prob: finalProbs.home_win_prob },
    { selection: "Draw", prob: finalProbs.draw_prob },
    { selection: "Away Win", prob: finalProbs.away_win_prob },
  ].filter((e) => typeof e.prob === "number");
  if (winnerEntries.length) {
    const top = winnerEntries.reduce((a, b) => (b.prob > a.prob ? b : a));
    picks.push({ market: "Match Winner (1X2)", selection: top.selection, probability_pct: top.prob, agreement: keyAgreements.match_winner });
  }

  if (typeof finalProbs.btts_prob === "number") {
    const yes = finalProbs.btts_prob >= 50;
    picks.push({
      market: "Both Teams To Score",
      selection: yes ? "Yes" : "No",
      probability_pct: yes ? finalProbs.btts_prob : round(100 - finalProbs.btts_prob, 1),
      agreement: keyAgreements.btts,
    });
  }

  [
    ["over_0_5_prob", "Over/Under 0.5 Goals", null],
    ["over_1_5_prob", "Over/Under 1.5 Goals", "over_1_5"],
    ["over_2_5_prob", "Over/Under 2.5 Goals", "over_2_5"],
    ["over_3_5_prob", "Over/Under 3.5 Goals", "over_3_5"],
  ].forEach(([field, market, agreementKey]) => {
    const p = finalProbs[field];
    if (typeof p !== "number") return;
    const over = p >= 50;
    picks.push({
      market,
      selection: over ? "Over" : "Under",
      probability_pct: over ? p : round(100 - p, 1),
      agreement: agreementKey ? keyAgreements[agreementKey] : null,
    });
  });

  const dcEntries = [
    { selection: "Home or Draw", prob: finalProbs.double_chance_home_or_draw, agreement: keyAgreements.double_chance_hd },
    { selection: "Draw or Away", prob: finalProbs.double_chance_draw_or_away, agreement: keyAgreements.double_chance_da },
    { selection: "Home or Away", prob: finalProbs.double_chance_home_or_away, agreement: keyAgreements.double_chance_ha },
  ].filter((e) => typeof e.prob === "number");
  if (dcEntries.length) {
    const top = dcEntries.reduce((a, b) => (b.prob > a.prob ? b : a));
    picks.push({ market: "Double Chance", selection: top.selection, probability_pct: top.prob, agreement: top.agreement });
  }

  return picks;
}

function tierPicks(picks) {
  const scored = picks.map((p) => {
    const agreementFactor = typeof p.agreement === "number" ? p.agreement : 60;
    // Weighted slightly more toward agreement (0.65/0.35, was 0.7/0.3) —
    // genuine cross-model consensus is a stronger real-world signal than
    // one high raw probability number, especially for anything intended to
    // be surfaced as a recommendation rather than just informational.
    const score = p.probability_pct * 0.65 + agreementFactor * 0.35;
    return { ...p, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);

  const highest_confidence = scored.filter((p) => p._score >= 70).map(stripScore);
  const medium_confidence = scored.filter((p) => p._score >= 55 && p._score < 70).map(stripScore);
  const higher_risk = scored.filter((p) => p._score < 55).map(stripScore);

  return { highest_confidence, medium_confidence, higher_risk };
}

function stripScore({ _score, ...rest }) {
  return rest;
}

/**
 * Choose the single Best Pick from an already-bettable-markets-only,
 * already-sorted list. Requires a minimum amount of real cross-model
 * agreement (MIN_AGREEMENT_FOR_BEST_PICK) to qualify — a pick with unknown
 * agreement (only 1 model contributed) is allowed through since there's
 * nothing to disagree with, but a pick where models actively spread wide
 * is skipped in favor of the next-best qualifying candidate.
 */
function pickBest(highestConfidenceBettablePicks) {
  const qualifying = highestConfidenceBettablePicks.filter((p) => typeof p.agreement !== "number" || p.agreement >= MIN_AGREEMENT_FOR_BEST_PICK);
  if (!qualifying.length) {
    return highestConfidenceBettablePicks.length
      ? { available: false, message: "The top candidate pick had too much model disagreement to recommend confidently." }
      : { available: false, message: "No high-confidence pick available among standard betting markets this time." };
  }
  const top = qualifying[0];
  return { available: true, market: top.market, selection: top.selection, probability_pct: top.probability_pct, agreement: top.agreement };
}

function buildSafePicks(picks) {
  return picks
    .filter((p) => p.probability_pct >= 65 && (typeof p.agreement !== "number" || p.agreement >= 70))
    .sort((a, b) => b.probability_pct - a.probability_pct)
    .slice(0, 4);
}

function buildSummary({ overallAgreement, overallConfidence, dataQuality, bestPick, modelCount }) {
  const parts = [];
  if (bestPick.available) {
    parts.push(`Best pick: ${bestPick.selection} (${bestPick.market}) at ${bestPick.probability_pct}% probability.`);
  } else {
    parts.push(`No pick met the bar for a Best Pick this time${bestPick.message ? ` (${bestPick.message.toLowerCase()})` : ""}.`);
  }
  if (overallAgreement !== null) {
    parts.push(
      overallAgreement >= 75
        ? `All ${modelCount} model${modelCount === 1 ? "" : "s"} were closely aligned (${overallAgreement}% agreement).`
        : `The ${modelCount} models diverged somewhat (${overallAgreement}% agreement), which tempered confidence.`
    );
  }
  if (dataQuality !== null) {
    parts.push(
      dataQuality >= 75
        ? `Data quality was strong (${dataQuality}/100).`
        : `Data quality was limited (${dataQuality}/100) — treat this analysis with extra caution.`
    );
  }
  parts.push(`Overall confidence: ${overallConfidence}%.`);
  return parts.join(" ");
}

module.exports = { runConsensus, explainCurrentWeighting, normalizeWinnerProbs, MARKET_FOR_FIELD, NORMAL_BETTING_MARKETS, ELIGIBLE_AUX_FAMILIES, isBettable };
