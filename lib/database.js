const { newId, fixtureKey, clamp, round, now } = require("./utils");
const { loadSettings } = require("./settings");
const grading = require("./grading");
const logger = require("./logger");
const mongo = require("./db/mongo");
const { MODEL_NAMES, modelKeyFor } = require("./providers/registry");

const MAX_WEIGHT_HISTORY = 300;

// Minimum graded instances a model needs for a SPECIFIC market before its
// market-specific learned weight is trusted over its general overall
// weight — below this, a market-specific weight would just be noise.
const MIN_MARKET_SAMPLES = 5;

// ---------------------------------------------------------------------------
// In-memory cache, loaded once from MongoDB at startup via init(). Every
// read function below (findPrediction, listPredictions, computeModelStats,
// getDashboardStats, loadWeights, getEffectiveWeight, etc.) stays fully
// synchronous, reading straight from these — exactly as they read from an
// in-memory JS array/object before this rewrite, just now durable. Only
// genuine mutations (addPrediction, deletePrediction, submitFeedback,
// recomputeAllWeights, ...) touch MongoDB, and only those are async.
// ---------------------------------------------------------------------------

let _predictions = null;
let _weights = null;
let _weightHistory = null;
let _cacheStats = null;

function defaultWeights() {
  const models = {};
  MODEL_NAMES.forEach((n) => (models[n] = { overall: round(1 / MODEL_NAMES.length, 4), byMarket: {} }));
  return { version: 2, models };
}

/** One-time-per-load migration: fixes stale fixtureKeys and fills in any missing feedback shell. Idempotent. Returns the records that actually changed, for persisting. */
function migrateRecords(records) {
  const changedRecords = [];
  for (const r of records) {
    if (!r.fixture) continue;
    let changed = false;
    const correctKey = fixtureKey(r.fixture);
    if (r.fixtureKey !== correctKey) {
      r.fixtureKey = correctKey;
      changed = true;
    }
    if (!r.feedback) {
      r.feedback = { status: "pending", actualResult: null, gradedAt: null };
      changed = true;
    }
    if (changed) changedRecords.push(r);
  }
  return changedRecords;
}

function fromMongoDoc(doc) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

async function init() {
  const predictionDocs = await mongo.collection("predictions").find({}).toArray();
  _predictions = predictionDocs.map(fromMongoDoc);
  const changed = migrateRecords(_predictions);
  if (changed.length) {
    await Promise.all(changed.map((r) => mongo.collection("predictions").updateOne({ _id: r.id }, { $set: { fixtureKey: r.fixtureKey, feedback: r.feedback } })));
  }

  const weightsDoc = await mongo.collection("meta").findOne({ _id: "modelWeights" });
  _weights = weightsDoc ? weightsDoc.value : defaultWeights();
  if (!_weights.models) _weights = defaultWeights();
  // Fill in any model present in the registry but missing from storage (e.g. after adding a new provider).
  for (const name of MODEL_NAMES) {
    if (!_weights.models[name]) _weights.models[name] = { overall: 1 / MODEL_NAMES.length, byMarket: {} };
  }
  if (!weightsDoc) await mongo.collection("meta").updateOne({ _id: "modelWeights" }, { $set: { value: _weights } }, { upsert: true });

  const cacheStatsDoc = await mongo.collection("meta").findOne({ _id: "cacheStats" });
  _cacheStats = cacheStatsDoc ? cacheStatsDoc.value : { hits: 0, misses: 0 };
  if (!cacheStatsDoc) await mongo.collection("meta").updateOne({ _id: "cacheStats" }, { $set: { value: _cacheStats } }, { upsert: true });

  const historyDocs = await mongo.collection("weightHistory").find({}).sort({ ts: 1 }).toArray();
  _weightHistory = historyDocs.map((d) => ({ ts: d.ts, weights: d.weights }));
}

function requireInit() {
  if (!_predictions) throw new Error("database.init() must be awaited at startup before database functions are used.");
}

function persistWeights() {
  return mongo
    .collection("meta")
    .updateOne({ _id: "modelWeights" }, { $set: { value: _weights } }, { upsert: true })
    .catch((err) => console.error("Failed to persist model weights to MongoDB:", err.message));
}

function persistCacheStats() {
  return mongo
    .collection("meta")
    .updateOne({ _id: "cacheStats" }, { $set: { value: _cacheStats } }, { upsert: true })
    .catch((err) => console.error("Failed to persist cache stats to MongoDB:", err.message));
}

async function appendWeightHistory(modelsOut) {
  const snapshot = { ts: now(), weights: Object.fromEntries(MODEL_NAMES.map((n) => [n, round(modelsOut[n]?.overall ?? 0, 4)])) };
  _weightHistory.push(snapshot);
  await mongo.collection("weightHistory").insertOne({ ...snapshot });
  if (_weightHistory.length > MAX_WEIGHT_HISTORY) {
    const overflow = _weightHistory.length - MAX_WEIGHT_HISTORY;
    const toDrop = _weightHistory.slice(0, overflow);
    _weightHistory.splice(0, overflow);
    // Best-effort trim on the stored side too — not critical if this occasionally lags, since it only affects how far back the weight-evolution chart can look.
    await mongo.collection("weightHistory").deleteMany({ ts: { $in: toDrop.map((s) => s.ts) } }).catch(() => {});
  }
}

function getWeightHistory() {
  requireInit();
  return _weightHistory;
}

/** The overall (market-agnostic) learned weight for a model — the headline number shown on the Dashboard. */
function getOverallWeight(name) {
  requireInit();
  return _weights.models[name]?.overall ?? 1 / MODEL_NAMES.length;
}

/**
 * The weight to actually use for a specific market: its market-specific
 * learned weight if there's enough graded history for that model+market
 * combination to be meaningful, otherwise falls back to the model's
 * overall weight (avoids a market-specific weight of "1.0" being trusted
 * off of 1 lucky graded pick).
 */
function getEffectiveWeight(name, market) {
  requireInit();
  const model = _weights.models[name];
  if (!model) return 1 / MODEL_NAMES.length;
  const entry = model.byMarket?.[market];
  if (entry && entry.count >= MIN_MARKET_SAMPLES) return entry.weight;
  return model.overall;
}

function loadWeights() {
  requireInit();
  return _weights;
}

function loadCacheStats() {
  requireInit();
  return _cacheStats;
}

function recordCacheEvent(hit) {
  requireInit();
  if (hit) _cacheStats.hits += 1;
  else _cacheStats.misses += 1;
  persistCacheStats();
  return _cacheStats;
}

// ---------------------------------------------------------------------------
// Prediction CRUD
// ---------------------------------------------------------------------------

function findPrediction(fixture) {
  requireInit();
  const key = fixtureKey(fixture);
  return _predictions.find((p) => p.fixtureKey === key) || null;
}

async function addPrediction(payload) {
  requireInit();
  const record = {
    id: newId(),
    createdAt: now(),
    fixtureKey: fixtureKey(payload.fixture),
    ...payload,
    feedback: { status: "pending", actualResult: null, gradedAt: null },
  };
  const { id, ...rest } = record;
  await mongo.collection("predictions").insertOne({ _id: id, ...rest });
  _predictions.push(record);
  return record;
}

function getPredictionById(id) {
  requireInit();
  return _predictions.find((p) => p.id === id) || null;
}

async function deletePrediction(id) {
  requireInit();
  const idx = _predictions.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error("Prediction not found");
  await mongo.collection("predictions").deleteOne({ _id: id });
  _predictions.splice(idx, 1);
  await recomputeAllWeights();
  return { ok: true };
}

async function clearAllPredictions() {
  requireInit();
  await mongo.collection("predictions").deleteMany({});
  _predictions = [];
  await recomputeAllWeights();
  return { ok: true };
}

function listPredictions({ competition, team, date, status, sort = "newest" } = {}) {
  requireInit();
  let list = _predictions;

  if (competition) {
    const q = competition.toLowerCase();
    list = list.filter((p) => (p.fixture?.league || "").toLowerCase().includes(q));
  }
  if (team) {
    const q = team.toLowerCase();
    list = list.filter((p) => (p.fixture?.home || "").toLowerCase().includes(q) || (p.fixture?.away || "").toLowerCase().includes(q));
  }
  if (date) {
    list = list.filter((p) => (p.fixture?.date || "").toLowerCase().includes(date.toLowerCase()));
  }
  if (status) {
    list = list.filter((p) => p.feedback?.status === status);
  }

  const sorted = [...list];
  switch (sort) {
    case "oldest":
      sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      break;
    case "confidence":
      sorted.sort((a, b) => (b.consensus?.overallConfidence ?? -1) - (a.consensus?.overallConfidence ?? -1));
      break;
    default:
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return sorted;
}

function getKnownTeamNames() {
  requireInit();
  const names = new Set();
  _predictions.forEach((p) => {
    if (p.fixture?.home) names.add(p.fixture.home);
    if (p.fixture?.away) names.add(p.fixture.away);
  });
  return [...names];
}

// ---------------------------------------------------------------------------
// Feedback / grading
// ---------------------------------------------------------------------------

async function submitFeedback(id, { status, actualResult }) {
  requireInit();
  const record = _predictions.find((p) => p.id === id);
  if (!record) throw new Error("Prediction not found");

  const parsed = grading.parseActualResult(actualResult);
  const picks = grading.getAllPicks(record);
  const pickGrades = picks.map((p) => ({
    market: p.market,
    selection: p.selection,
    correct: parsed ? grading.pickWasCorrect(p, parsed) : null,
  }));

  const feedback = { status, actualResult: actualResult || null, pickGrades, gradedAt: now() };
  await mongo.collection("predictions").updateOne({ _id: id }, { $set: { feedback } });
  record.feedback = feedback;

  const weights = await recomputeAllWeights();
  return { ...record, _weightsAfterUpdate: weights };
}

async function backfillPickGrades() {
  requireInit();
  const toUpdate = [];
  for (const record of _predictions) {
    const fb = record.feedback;
    if (!fb || fb.status === "pending" || fb.pickGrades) continue;
    const parsed = grading.parseActualResult(fb.actualResult);
    if (!parsed) continue;
    const picks = grading.getAllPicks(record);
    fb.pickGrades = picks.map((p) => ({ market: p.market, selection: p.selection, correct: grading.pickWasCorrect(p, parsed) }));
    toUpdate.push(record);
  }
  if (toUpdate.length) {
    await Promise.all(toUpdate.map((r) => mongo.collection("predictions").updateOne({ _id: r.id }, { $set: { feedback: r.feedback } })));
  }
  return toUpdate.length > 0;
}

// ---------------------------------------------------------------------------
// Weight learning — full replay from history every time, which is what
// makes editing a past graded result safe. Learns BOTH an overall weight
// per model AND a market-specific weight per model+market pair (e.g. a
// model might be great at BTTS but mediocre at Over/Under 3.5 — the
// consensus engine can now reflect that instead of one blended number).
// Recent grades are weighted more heavily than old ones via exponential
// recency decay (Settings: recencyHalfLifeDays; 0 disables decay).
// ---------------------------------------------------------------------------

async function recomputeAllWeights() {
  requireInit();
  const settings = loadSettings();
  const predictions = _predictions;
  const names = MODEL_NAMES;

  const overall = {};
  names.forEach((n) => (overall[n] = 1 / names.length));
  const byMarket = {}; // byMarket[market][name] = weight
  const marketCounts = {}; // marketCounts[market][name] = graded instance count

  const graded = predictions
    .filter((p) => p.feedback && (p.feedback.status === "correct" || p.feedback.status === "incorrect"))
    .sort((a, b) => new Date(a.feedback.gradedAt || a.createdAt) - new Date(b.feedback.gradedAt || b.createdAt));

  const nowMs = Date.now();
  const halfLife = settings.recencyHalfLifeDays;
  const WARMUP_TARGET = 20;

  graded.forEach((record, index) => {
    const parsed = grading.parseActualResult(record.feedback.actualResult);
    if (!parsed) return;

    const gradedAtMs = new Date(record.feedback.gradedAt || record.createdAt).getTime();
    const ageDays = Math.max(0, (nowMs - gradedAtMs) / 86400000);
    const decay = halfLife > 0 ? Math.pow(0.5, ageDays / halfLife) : 1;
    const warmup = clamp((index + 1) / WARMUP_TARGET, 0.35, 1);
    const step = settings.weightStep * decay * warmup;
    if (step < 0.0002) return;

    const markets = grading.marketsForRecord(record);
    for (const market of markets) {
      if (!byMarket[market]) {
        byMarket[market] = {};
        marketCounts[market] = {};
        names.forEach((n) => {
          byMarket[market][n] = 1 / names.length;
          marketCounts[market][n] = 0;
        });
      }

      const results = {};
      for (const name of names) {
        const modelOutput = record[modelKeyFor(name)];
        if (!modelOutput) continue;
        const r = grading.modelPickedMarketCorrectly(modelOutput, market, parsed);
        if (r !== null) {
          results[name] = r;
          marketCounts[market][name] += 1;
        }
      }
      const gradedNames = Object.keys(results);
      if (gradedNames.length < 2) continue;

      const correctNames = gradedNames.filter((n) => results[n] === true);
      const incorrectNames = gradedNames.filter((n) => results[n] === false);
      if (!correctNames.length || !incorrectNames.length) continue;

      const gain = step / correctNames.length;
      const loss = step / incorrectNames.length;
      correctNames.forEach((n) => {
        overall[n] = clamp(overall[n] + gain, settings.minModelWeight, settings.maxModelWeight);
        byMarket[market][n] = clamp(byMarket[market][n] + gain, settings.minModelWeight, settings.maxModelWeight);
      });
      incorrectNames.forEach((n) => {
        overall[n] = clamp(overall[n] - loss, settings.minModelWeight, settings.maxModelWeight);
        byMarket[market][n] = clamp(byMarket[market][n] - loss, settings.minModelWeight, settings.maxModelWeight);
      });
    }
  });

  const modelsOut = {};
  names.forEach((n) => (modelsOut[n] = { overall: overall[n], byMarket: {} }));
  Object.entries(byMarket).forEach(([market, weights]) => {
    Object.entries(weights).forEach(([name, w]) => {
      modelsOut[name].byMarket[market] = { weight: round(w, 4), count: marketCounts[market][name] };
    });
  });

  _weights = { version: 2, models: modelsOut };
  await persistWeights();
  await appendWeightHistory(modelsOut);
  return modelsOut;
}

// ---------------------------------------------------------------------------
// Per-model statistics
// ---------------------------------------------------------------------------

function computeModelStats(modelKey) {
  requireInit();
  const graded = [];

  for (const p of _predictions) {
    if (!p.feedback || (p.feedback.status !== "correct" && p.feedback.status !== "incorrect")) continue;
    const parsed = grading.parseActualResult(p.feedback.actualResult);
    if (!parsed) continue;
    const modelOutput = p[modelKey];
    const markets = grading.marketsForRecord(p);
    for (const market of markets) {
      const correct = grading.modelPickedMarketCorrectly(modelOutput, market, parsed);
      if (correct === null) continue;
      graded.push({ correct, market, confidence: modelOutput?.confidence, createdAt: p.createdAt, competition: p.fixture?.league });
    }
  }

  graded.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const accuracyOf = (arr) => (arr.length ? round((100 * arr.filter((e) => e.correct).length) / arr.length, 1) : null);

  const overallAccuracy = accuracyOf(graded);
  const last10 = accuracyOf(graded.slice(-10));
  const last25 = accuracyOf(graded.slice(-25));
  const last50 = accuracyOf(graded.slice(-50));
  const last100 = accuracyOf(graded.slice(-100));

  const prevWindow = graded.slice(-20, -10);
  const prev10 = accuracyOf(prevWindow);
  let trend = "insufficient_data";
  if (last10 !== null && prev10 !== null) {
    const delta = last10 - prev10;
    trend = delta > 5 ? "improving" : delta < -5 ? "declining" : "stable";
  }

  let currentStreak = 0;
  for (let i = graded.length - 1; i >= 0; i--) {
    if (graded[i].correct) currentStreak++;
    else break;
  }

  const confidences = graded.map((e) => e.confidence).filter((c) => typeof c === "number");
  const avgConfidence = confidences.length ? round(confidences.reduce((a, b) => a + b, 0) / confidences.length, 1) : null;

  const highConfEntries = graded.filter((e) => typeof e.confidence === "number" && e.confidence >= 70);
  const highConfidenceAccuracy = accuracyOf(highConfEntries);

  const brier = grading.brierScore(graded);
  const calibrationScore = grading.calibrationScoreFromBrier(brier);

  const byMarket = {};
  for (const entry of graded) {
    if (!byMarket[entry.market]) byMarket[entry.market] = [];
    byMarket[entry.market].push(entry);
  }
  const marketBreakdown = Object.fromEntries(
    Object.entries(byMarket).map(([market, entries]) => [market, { count: entries.length, accuracy: accuracyOf(entries) }])
  );

  const marketsWithVolume = Object.entries(marketBreakdown).filter(([, v]) => v.count >= 3);
  const weakestMarket = marketsWithVolume.length ? marketsWithVolume.reduce((a, b) => (b[1].accuracy < a[1].accuracy ? b : a)) : null;
  const strongestMarket = marketsWithVolume.length ? marketsWithVolume.reduce((a, b) => (b[1].accuracy > a[1].accuracy ? b : a)) : null;

  return {
    modelKey,
    gradedCount: graded.length,
    overallAccuracy,
    last10,
    last25,
    last50,
    last100,
    trend,
    currentStreak,
    avgConfidence,
    highConfidenceAccuracy,
    brierScore: brier,
    calibrationScore,
    byMarket: marketBreakdown,
    weakestMarket: weakestMarket ? { market: weakestMarket[0], ...weakestMarket[1] } : null,
    strongestMarket: strongestMarket ? { market: strongestMarket[0], ...strongestMarket[1] } : null,
  };
}

// ---------------------------------------------------------------------------
// Dashboard aggregates
// ---------------------------------------------------------------------------

function getDashboardStats() {
  requireInit();
  const predictions = _predictions;
  const graded = predictions.filter((p) => p.feedback?.status === "correct" || p.feedback?.status === "incorrect");
  const pending = predictions.filter((p) => !p.feedback || p.feedback.status === "pending");

  const overallAccuracy = graded.length
    ? round((100 * graded.filter((p) => p.feedback.status === "correct").length) / graded.length, 1)
    : null;
  const recentGraded = [...graded].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-10);
  const recentAccuracy = recentGraded.length
    ? round((100 * recentGraded.filter((p) => p.feedback.status === "correct").length) / recentGraded.length, 1)
    : null;

  const modelRankings = MODEL_NAMES.map((name) => ({ name, stats: computeModelStats(modelKeyFor(name)) }))
    .filter((m) => m.stats.overallAccuracy !== null)
    .sort((a, b) => b.stats.overallAccuracy - a.stats.overallAccuracy);

  const bestModel = modelRankings[0] || null;
  const worstModel = modelRankings.length ? modelRankings[modelRankings.length - 1] : null;

  const sortedGraded = [...graded].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const accuracyTimeline = sortedGraded.map((p, i) => {
    const upToHere = sortedGraded.slice(0, i + 1);
    const correctCount = upToHere.filter((r) => r.feedback.status === "correct").length;
    return { date: p.createdAt, accuracy: round((100 * correctCount) / upToHere.length, 1) };
  });

  const sortedAll = [...predictions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const confidenceTimeline = sortedAll.map((p) => ({ date: p.createdAt, value: p.consensus?.overallConfidence ?? null })).filter((d) => d.value !== null);
  const agreementTimeline = sortedAll.map((p) => ({ date: p.createdAt, value: p.consensus?.agreementScore ?? null })).filter((d) => d.value !== null);
  const dataQualityTimeline = sortedAll.map((p) => ({ date: p.createdAt, value: p.retrievalMeta?.completeness ?? null })).filter((d) => d.value !== null);

  const buckets = [
    { label: "0-49%", min: 0, max: 49 },
    { label: "50-69%", min: 50, max: 69 },
    { label: "70-84%", min: 70, max: 84 },
    { label: "85-100%", min: 85, max: 100 },
  ];
  const calibrationBuckets = buckets.map((b) => {
    const inBucket = graded.filter((p) => {
      const c = p.consensus?.overallConfidence;
      return typeof c === "number" && c >= b.min && c <= b.max;
    });
    const acc = inBucket.length ? round((100 * inBucket.filter((p) => p.feedback.status === "correct").length) / inBucket.length, 1) : null;
    return { ...b, count: inBucket.length, accuracy: acc };
  });

  const byCompetition = {};
  for (const p of graded) {
    const league = p.fixture?.league || "Unspecified";
    if (!byCompetition[league]) byCompetition[league] = [];
    byCompetition[league].push(p);
  }
  const accuracyByCompetition = Object.entries(byCompetition)
    .filter(([, list]) => list.length >= 2)
    .map(([league, list]) => ({
      league,
      count: list.length,
      accuracy: round((100 * list.filter((p) => p.feedback.status === "correct").length) / list.length, 1),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    totals: { total: predictions.length, graded: graded.length, pending: pending.length },
    overallAccuracy,
    recentAccuracy,
    modelRankings,
    bestModel,
    worstModel,
    accuracyTimeline,
    confidenceTimeline,
    agreementTimeline,
    dataQualityTimeline,
    calibrationBuckets,
    accuracyByCompetition,
    cacheStats: loadCacheStats(),
    weightingExplained: require("./consensusEngine").explainCurrentWeighting(),
    weightHistory: getWeightHistory(),
  };
}

// ---------------------------------------------------------------------------
// Database management
// ---------------------------------------------------------------------------

async function getDatabaseInfo() {
  requireInit();
  const predictions = _predictions;
  const graded = predictions.filter((p) => p.feedback?.status === "correct" || p.feedback?.status === "incorrect");
  const byLeague = {};
  for (const p of predictions) {
    const league = p.fixture?.league || "Unspecified";
    byLeague[league] = (byLeague[league] || 0) + 1;
  }

  // There's no local "file" to report on anymore — this now reflects the
  // actual MongoDB collections backing each concept.
  let collections = [];
  try {
    const stats = await Promise.all(
      ["predictions", "meta", "weightHistory", "users"].map(async (name) => {
        const col = mongo.collection(name);
        const count = await col.estimatedDocumentCount();
        return { name, count };
      })
    );
    collections = stats;
  } catch (err) {
    logger.warn("database", "Failed to fetch MongoDB collection stats", { error: err.message });
  }

  return {
    collections,
    recordCount: predictions.length,
    gradedCount: graded.length,
    pendingCount: predictions.length - graded.length,
    competitionCount: Object.keys(byLeague).length,
    topCompetitions: Object.entries(byLeague).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([league, count]) => ({ league, count })),
  };
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

function exportAllData() {
  requireInit();
  return {
    exportedAt: now(),
    version: 3,
    predictions: _predictions,
    weights: _weights,
    cacheStats: _cacheStats,
    weightHistory: _weightHistory,
    settings: loadSettings(),
  };
}

async function importAllData(backup) {
  requireInit();
  if (!backup || !Array.isArray(backup.predictions)) {
    throw new Error("Invalid backup file: missing a 'predictions' array.");
  }

  const nextPredictions = backup.predictions;
  migrateRecords(nextPredictions);

  await mongo.collection("predictions").deleteMany({});
  if (nextPredictions.length) {
    await mongo.collection("predictions").insertMany(
      nextPredictions.map((p) => {
        const { id, ...rest } = p;
        return { _id: id, ...rest };
      })
    );
  }
  _predictions = nextPredictions;

  if (backup.weights?.models) {
    _weights = backup.weights;
    await persistWeights();
  }
  if (backup.cacheStats && typeof backup.cacheStats === "object") {
    _cacheStats = backup.cacheStats;
    await persistCacheStats();
  }
  if (Array.isArray(backup.weightHistory)) {
    await mongo.collection("weightHistory").deleteMany({});
    if (backup.weightHistory.length) await mongo.collection("weightHistory").insertMany(backup.weightHistory.map((s) => ({ ...s })));
    _weightHistory = backup.weightHistory;
  }

  await recomputeAllWeights();
  return { predictions: _predictions };
}

module.exports = {
  init,
  MODEL_NAMES,
  modelKeyFor,
  findPrediction,
  addPrediction,
  getPredictionById,
  deletePrediction,
  clearAllPredictions,
  listPredictions,
  getKnownTeamNames,
  submitFeedback,
  backfillPickGrades,
  recomputeAllWeights,
  loadWeights,
  getOverallWeight,
  getEffectiveWeight,
  getWeightHistory,
  computeModelStats,
  getDashboardStats,
  getDatabaseInfo,
  recordCacheEvent,
  loadCacheStats,
  exportAllData,
  importAllData,
  MIN_MARKET_SAMPLES,
};
