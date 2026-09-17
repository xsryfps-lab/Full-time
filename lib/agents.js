const { withRetry } = require("./utils");
const { engineerFeatures } = require("./featureEngineering");
const { runConsensus } = require("./consensusEngine");
const { loadSettings } = require("./settings");
const { getAIProviders, getProviderByName } = require("./providers/registry");
const retriever = require("./retrieval"); // abstraction — currently Exa, see lib/retrieval/index.js
const { buildFeatureNotes } = require("./diagnostics");
const { computeAuxiliaryMarkets } = require("./auxiliaryMarkets");
const { deriveLambdas, buildScorelineGrid, MAX_GOALS } = require("./poissonModel");
const logger = require("./logger");
const metrics = require("./metrics");
const db = require("./database");

// ---------------------------------------------------------------------------
// Every AI provider (Cohere, Gemini) analyzes ONLY the
// structured dataset given to it — raw retrieved stats + engineered
// features. None of them may browse or invent data beyond what's given.
// They're explicitly pointed at the Poisson expected-goals figures as a
// statistical anchor to weigh against and deviate from only when there's a
// concrete reason, and instructed to remain calibrated rather than
// confidently overreach on thin data.
// ---------------------------------------------------------------------------
const ANALYSIS_SYSTEM = `You are a football analyst. You ONLY analyse the structured dataset given to you (raw retrieved stats + engineered features) — you do not browse, search, or invent data beyond it, and you never fill a gap with a plausible-sounding guess.

Use EVERY relevant engineered feature you're given, not just goal averages — recent form, form trend, attack/defence ratings, home advantage index, momentum, goal volatility, injury/rest differentials, and the Poisson expected-goals baseline are all provided so you don't have to estimate them yourself.

Fixed reasoning order, every time: (1) start from poisson_expected_goals_home/away as your statistical baseline — a rigorous Poisson goal-expectation model, not a guess, (2) weigh recent form, form trend, and momentum, (3) weigh attack/defence ratings, (4) factor in head-to-head trend, (5) factor in context (injuries, rest days, motivation) and adjust away from the pure statistical baseline ONLY where you can point to a specific, named reason — never "on vibes." (6) note the impact of any missing data on your certainty.

CALIBRATION IS THE PRIORITY, NOT DECISIVENESS: your confidence value should honestly reflect how much the evidence actually supports one outcome over another. A genuinely close match (similar Poisson lambdas, high goal volatility, thin data) should get moderate confidence and probabilities closer to an even split — do not manufacture false decisiveness. Reserve high confidence (75+) for cases where multiple independent signals (form, ratings, H2H, Poisson) actually agree.

CRITICAL: even on an obscure fixture (amateur, regional, lower-tier) with little general knowledge of the teams, you MUST still return the full JSON structure below using only the provided data — never respond with prose explaining you lack information instead of the JSON. Reflect genuine uncertainty through a LOWER confidence value and probabilities closer to 33/33/33, not by refusing to answer or breaking format.

Use plain text in string values — no double or curly quotes for emphasis, that breaks JSON parsing. Output ONE JSON object only, no prose outside it, no markdown fences:
{
 "home_win_prob": number, "draw_prob": number, "away_win_prob": number,
 "double_chance": {"home_or_draw": number, "draw_or_away": number, "home_or_away": number},
 "btts_prob": number,
 "over_under": {
   "o05": {"over_pct": number}, "o15": {"over_pct": number}, "o25": {"over_pct": number}, "o35": {"over_pct": number}
 },
 "expected_first_half_goals": number, "expected_second_half_goals": number,
 "likely_scorelines": ["2-1","1-1"],
 "confidence": number,
 "key_stats_used": ["short phrase", "short phrase"],
 "weaknesses": ["short phrase"],
 "missing_data_impact": "short phrase describing how much missing data affected this, or none"
}
home_win_prob + draw_prob + away_win_prob must sum to approximately 100.`;

/**
 * Run the full pipeline for a fixture. Cache-first: an identical fixture
 * (home, away, date, AND league) returns instantly with ZERO API calls
 * unless forceRefresh is set.
 *
 * Pipeline: Cache check -> Exa retrieval (parallel passes) -> Gemini
 * extraction -> multi-stage validation (range/consistency repair,
 * completeness scoring, retry/reject) -> Feature engineering -> every
 * configured AI provider run CONCURRENTLY + Poisson -> Consensus Engine
 * (market-specific weighting) -> diagnostics -> Store.
 *
 * @param {{home:string, away:string, league:string, date:string}} fixture
 * @param {(key:string, state:'active'|'done'|'failed'|'hit', detail?:string)=>void} onProgress
 * @param {{forceRefresh?: boolean}} options
 */
async function runPipeline(fixture, onProgress = () => {}, options = {}) {
  const pipelineStart = Date.now();
  const settings = loadSettings();

  try {
    if (!options.forceRefresh && settings.cacheEnabled) {
      const cached = db.findPrediction(fixture);
      if (cached) {
        db.recordCacheEvent(true);
        logger.info("cache", "Cache HIT — zero API calls", { fixture });
        onProgress("cache", "hit");
        return { ...toResultShape(cached), _cached: true, _id: cached.id };
      }
    }
    db.recordCacheEvent(false);
    logger.info("cache", "Cache MISS — running full pipeline", { fixture });

    const { home, away, league, date } = fixture;
    const fixtureLine = `${home} vs ${away} — ${league}, ${date}.`;

    onProgress("research", "active");
    let retrievalResult;
    try {
      retrievalResult = await retriever.retrieve(fixture);
    } catch (err) {
      onProgress("research", "failed", err.message);
      throw err;
    }
    const { data: retrievalData, completeness, attempts, log: retrievalLog, matchType, repairs, sourceReliability } = retrievalResult;
    onProgress("research", "done");
    onProgress("validation", "done");

    onProgress("features", "active");
    const engineeredFeatures = engineerFeatures(retrievalData, matchType);
    onProgress("features", "done");

    const poissonProvider = getProviderByName("Poisson");
    onProgress("poissonmodel", "active");
    const poisson = await poissonProvider.predict({ retrievalData, engineeredFeatures });
    onProgress("poissonmodel", "done");

    // Auxiliary markets (corners, cards, shots on target, half-time result,
    // win-both/either-half, winning margin, handicap) — computed
    // deterministically from the same collected stats and the same Poisson
    // lambdas, rather than asked of the AI models (see auxiliaryMarkets.js
    // for why: these are countable stats an LLM has no real grounding to
    // guess, so proper Poisson-style math is more reliable here than a 4th
    // opinion would be).
    const lambdas = deriveLambdas(retrievalData);
    const grid = lambdas ? buildScorelineGrid(lambdas.lambdaHome, lambdas.lambdaAway) : null;
    const auxiliaryMarkets = computeAuxiliaryMarkets({ engineeredFeatures, lambdas, grid, maxGoals: MAX_GOALS });

    const analysisInput = `Fixture: ${fixtureLine}
Raw retrieved data (JSON): ${JSON.stringify(retrievalData)}
Engineered features (JSON): ${JSON.stringify(engineeredFeatures)}`;

    // Every configured AI provider runs CONCURRENTLY — fully independent of
    // each other, so total latency is the slowest single call, not the sum.
    const modelFailures = [];
    const aiProviders = getAIProviders();
    aiProviders.forEach((p) => onProgress(providerProgressKey(p.name), "active"));

    const settled = await Promise.allSettled(
      aiProviders.map((p) => {
        // Exa is deliberately the one exception: it does its own live web
        // search per fixture rather than reasoning from the shared
        // structured dataset, so it needs the raw fixture, not the
        // analysisInput blob every other provider receives identically.
        const context =
          p.name === "Exa" ? { fixture } : { system: ANALYSIS_SYSTEM, userText: analysisInput, maxTokens: 1800 };
        return withRetry(() => p.predict(context), { retries: settings.maxModelRetries, label: p.name }).then((result) => {
          onProgress(providerProgressKey(p.name), "done");
          return result;
        });
      })
    );

    const modelOutputs = {};
    aiProviders.forEach((p, i) => {
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        modelOutputs[db.modelKeyFor(p.name)] = outcome.value;
      } else {
        logger.warn("analysis", `${p.name} failed after retries — excluding it from this analysis`, { error: outcome.reason?.message });
        modelFailures.push({ model: p.name, error: outcome.reason?.message || "Unknown error" });
        onProgress(providerProgressKey(p.name), "failed", outcome.reason?.message || "Unknown error");
        modelOutputs[db.modelKeyFor(p.name)] = null;
      }
    });

    onProgress("consensus", "active");
    const models = {};
    aiProviders.forEach((p) => {
      const key = db.modelKeyFor(p.name);
      if (modelOutputs[key]) models[p.name] = modelOutputs[key];
    });
    if (poisson) models.Poisson = poisson;

    if (!Object.keys(models).length) {
      const err = new Error(
        "Every model failed to produce a usable prediction for this fixture — it may be too obscure for any provider to analyze, or the providers are having issues right now. Try again later, or try a more prominent fixture."
      );
      err.code = "ALL_MODELS_FAILED";
      onProgress("consensus", "failed", err.message);
      metrics.recordConsensus({ allFailed: true });
      metrics.recordPipelineRun({ durationMs: Date.now() - pipelineStart, failed: true });
      throw err;
    }
    metrics.recordConsensus({ allFailed: false });

    const consensus = runConsensus({ models, engineeredFeatures, sourceReliability, auxiliaryMarkets });
    if (modelFailures.length) {
      consensus.overall_summary += ` (Note: ${modelFailures.map((f) => f.model).join(", ")} failed to respond and ${
        modelFailures.length > 1 ? "were" : "was"
      } excluded from this analysis.)`;
    }
    onProgress("consensus", "done");

    onProgress("diagnostics", "active");
    const diagnostics = {
      ...consensus.diagnostics,
      featureNotes: buildFeatureNotes(engineeredFeatures, fixture),
      repairs: repairs || [],
      sourceReliability,
    };
    onProgress("diagnostics", "done");

    onProgress("saving", "active");
    // Spread every AI provider's output dynamically (keyed by db.modelKeyFor)
    // instead of hardcoding each provider's name here — this is precisely
    // what makes swapping a provider (e.g. replacing one aggregator with
    // another) a config-only change with no risk of a stale field name.
    const modelFields = {};
    aiProviders.forEach((p) => (modelFields[db.modelKeyFor(p.name)] = modelOutputs[db.modelKeyFor(p.name)]));

    const stored = await db.addPrediction({
      fixture,
      retrievalData,
      retrievalMeta: { completeness, attempts, log: retrievalLog, matchType, modelFailures, repairs, sourceReliability },
      engineeredFeatures,
      ...modelFields,
      poisson,
      consensus,
      diagnostics,
      createdBy: options.createdBy || null,
    });
    onProgress("saving", "done");

    metrics.recordPipelineRun({ durationMs: Date.now() - pipelineStart, failed: false });
    return { ...toResultShape(stored), _cached: false, _id: stored.id };
  } catch (err) {
    if (!err.code) metrics.recordPipelineRun({ durationMs: Date.now() - pipelineStart, failed: true });
    throw err;
  }
}

// SSE/ticker step keys stay stable and lowercase-alnum regardless of the
// provider's display name, so the frontend ticker doesn't need per-provider
// special-casing either.
function providerProgressKey(name) {
  return db.modelKeyFor(name) + "model";
}

/** Shape a stored DB record the same way whether it came from cache or a fresh run — includes every current provider's field dynamically. */
function toResultShape(record) {
  const { getAIProviders: aiProvidersFn } = require("./providers/registry");
  const modelFields = {};
  aiProvidersFn().forEach((p) => (modelFields[db.modelKeyFor(p.name)] = record[db.modelKeyFor(p.name)]));
  return {
    fixture: record.fixture,
    retrievalData: record.retrievalData,
    retrievalMeta: record.retrievalMeta,
    engineeredFeatures: record.engineeredFeatures,
    ...modelFields,
    poisson: record.poisson,
    consensus: record.consensus,
    diagnostics: record.diagnostics,
    feedback: record.feedback,
    createdAt: record.createdAt,
    createdBy: record.createdBy || null,
  };
}

module.exports = { runPipeline, ANALYSIS_SYSTEM, providerProgressKey };
