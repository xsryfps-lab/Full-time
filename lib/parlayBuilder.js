const { round } = require("./utils");
const db = require("./database");
const grading = require("./grading");
const { isBettable } = require("./consensusEngine");

// Different matches are genuinely independent events, so a parlay's
// combined probability is a real multiplication across legs — not an
// approximation the way some single-match markets can be.
function combineLegs(legs) {
  const combinedProbability = legs.reduce((p, leg) => p * (leg.probability_pct / 100), 1);
  const combinedPercent = round(combinedProbability * 100, 2);
  const decimalOdds = combinedProbability > 0 ? round(1 / combinedProbability, 2) : null;
  const avgAgreement = round(legs.reduce((s, l) => s + (typeof l.agreement === "number" ? l.agreement : 70), 0) / legs.length, 0);
  return { legs, legCount: legs.length, combinedProbabilityPct: combinedPercent, decimalOdds, avgAgreement };
}

function legFromPick(prediction, pick) {
  return {
    predictionId: prediction.id,
    fixture: prediction.fixture,
    market: pick.market,
    selection: pick.selection,
    probability_pct: pick.probability_pct,
    agreement: pick.agreement,
  };
}

/**
 * One leg per prediction (never two markets from the same match — they're
 * not independent of each other). Prefers each prediction's Best Pick when
 * it clears the probability threshold; otherwise falls back to its best
 * individual bettable pick above the same threshold.
 */
function eligibleLegsFrom(predictions, { minProbability = 55 } = {}) {
  const legs = [];
  for (const p of predictions) {
    const bp = p.consensus?.bestPick;
    if (bp?.available && bp.probability_pct >= minProbability) {
      legs.push(legFromPick(p, bp));
      continue;
    }

    const candidates = grading.getAllPicks(p).filter(isBettable).filter((pk) => pk.probability_pct >= minProbability);
    if (!candidates.length) continue;
    const top = candidates.reduce((a, b) => (b.probability_pct > a.probability_pct ? b : a));
    legs.push(legFromPick(p, top));
  }
  return legs;
}

// Same weighting the Consensus Engine uses elsewhere for tiering picks by
// overall quality rather than raw probability alone.
const QUALITY_WEIGHT_PROB = 0.65;
const QUALITY_WEIGHT_AGREEMENT = 0.35;
function qualityScore(leg) {
  const agreement = typeof leg.agreement === "number" ? leg.agreement : 70;
  return leg.probability_pct * QUALITY_WEIGHT_PROB + agreement * QUALITY_WEIGHT_AGREEMENT;
}

function sameLegSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((leg, i) => leg.predictionId === b[i].predictionId);
}

/**
 * Builds up to three named tiers from every currently-pending prediction's
 * best eligible pick: safest (up to 3 legs clearing a genuinely high
 * probability bar — falls back to the single best pick if nothing clears
 * that bar, so it still works with just one eligible game), safe (every
 * leg clearing a lower-but-still-solid bar, uncapped, so it grows on its
 * own as more safe games become available), and longshot (a wider net for
 * a bigger payout at more risk, dropped if it would just duplicate an
 * earlier tier).
 */
function autoBuildParlays({ minProbability = 55, maxLegs = 6 } = {}) {
  const predictions = db.listPredictions({ status: "pending" });
  const pool = eligibleLegsFrom(predictions, { minProbability });

  if (pool.length < 1) {
    return {
      available: false,
      message: "No eligible pending predictions yet — need at least one with a bettable pick above the probability threshold.",
      tiers: {},
      poolSize: pool.length,
    };
  }

  const sorted = [...pool].sort((a, b) => qualityScore(b) - qualityScore(a));
  const tiers = {};

  // Safest: up to 3 legs clearing a genuinely high (80%+) probability bar
  // — a real "safest combination", not just a single pick. Falls back to
  // the single best-quality leg only when nothing clears that bar, so it
  // still means something with a thin or mediocre slate.
  const SAFEST_THRESHOLD = 80;
  const SAFEST_MAX_LEGS = 3;
  const safestCandidates = sorted.filter((l) => l.probability_pct >= SAFEST_THRESHOLD).slice(0, SAFEST_MAX_LEGS);
  tiers.safest = combineLegs(safestCandidates.length ? safestCandidates : [sorted[0]]);

  // Safe: every eligible leg clearing a solid (70%+) probability bar,
  // deliberately uncapped so it grows on its own as more safe games become
  // available, rather than being artificially capped at a fixed leg count.
  // Dropped if it would just duplicate safest (a small, uniformly great
  // pool can genuinely have only one sensible "safe" combination).
  const safeCandidates = sorted.filter((l) => l.probability_pct >= 70);
  if (safeCandidates.length >= 2 && !sameLegSet(safeCandidates, tiers.safest.legs)) {
    tiers.safe = combineLegs(safeCandidates);
  }

  // Longshot: casts the widest net (up to maxLegs, including lower-
  // probability picks) for a bigger payout at higher risk.
  const longshotCandidates = sorted.slice(0, maxLegs);
  const compareAgainst = tiers.safe?.legs || tiers.safest.legs;
  if (longshotCandidates.length >= 3 && !sameLegSet(longshotCandidates, compareAgainst)) {
    tiers.longshot = combineLegs(longshotCandidates);
  }

  return { available: true, tiers, poolSize: pool.length };
}

/**
 * Build a parlay from explicit leg requests: [{predictionId, market?, selection?}].
 * market+selection picks that exact pick; omitting both defaults to that
 * prediction's Best Pick. Throws clear, user-facing errors on any problem.
 */
function manualBuildParlay(legRequests) {
  if (!Array.isArray(legRequests) || legRequests.length < 2) {
    throw new Error("A parlay needs at least 2 legs.");
  }

  const seenPredictionIds = new Set();
  const legs = legRequests.map((req) => {
    const p = db.getPredictionById(req.predictionId);
    if (!p) throw new Error(`Prediction ${req.predictionId} not found.`);
    if (seenPredictionIds.has(p.id)) throw new Error(`${p.fixture.home} vs ${p.fixture.away} was selected more than once — a parlay can only include one leg per match.`);
    seenPredictionIds.add(p.id);

    if (req.market && req.selection) {
      const match = grading.getAllPicks(p).find((pk) => pk.market === req.market && pk.selection === req.selection);
      if (!match) throw new Error(`Pick "${req.selection}" (${req.market}) not found for ${p.fixture.home} vs ${p.fixture.away}.`);
      return legFromPick(p, match);
    }

    const bp = p.consensus?.bestPick;
    if (!bp?.available) throw new Error(`No Best Pick available for ${p.fixture.home} vs ${p.fixture.away} — specify a market/selection manually.`);
    return legFromPick(p, bp);
  });

  return combineLegs(legs);
}

module.exports = { combineLegs, eligibleLegsFrom, autoBuildParlays, manualBuildParlay };
