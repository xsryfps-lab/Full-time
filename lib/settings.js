const { clamp } = require("./utils");
const mongo = require("./db/mongo");

// Honest framing: these control HOW HARD the system tries and HOW STRICT it
// is before accepting or rejecting data, how fast it reacts to new feedback,
// and how it balances recent vs. historical performance. None of them can
// make the underlying retrieved data more complete than it actually is.
const DEFAULTS = {
  // Retrieval
  retryThreshold: 70, // below this completeness %, retry retrieval (if attempts remain)
  rejectThreshold: 60, // below this completeness % after all attempts, refuse to predict
  maxRetrievalAttempts: 3, // how many times to retry a low-completeness retrieval

  // Weight learning
  weightStep: 0.02, // how much a single graded market nudges model weights
  minModelWeight: 0.08, // no model's weight can go below this
  maxModelWeight: 0.85, // no model's weight can go above this
  recencyHalfLifeDays: 45, // graded predictions older than this count for progressively less in weight learning (0 = disabled)

  // Confidence calibration
  calibrationStrength: 1.0, // multiplier on the calibration adjustment (0 = disabled, 1 = default, >1 = more aggressive)

  // Reliability
  modelTimeoutMs: 45000, // per-model API call timeout
  maxModelRetries: 2, // retries per model/API call before giving up

  // Cache
  cacheEnabled: true,
};

// In-memory cache, loaded once from MongoDB at startup via init(). Every
// existing synchronous consumer of loadSettings() throughout the app
// (there are many — provider files, retrieval, consensus engine) keeps
// working completely unchanged, since reads never touch the database.
let cache = null;

/** Load settings from MongoDB into the in-memory cache. Must be awaited once at server startup, before anything calls loadSettings(). */
async function init() {
  const doc = await mongo.collection("meta").findOne({ _id: "settings" });
  cache = doc ? { ...DEFAULTS, ...doc.value } : { ...DEFAULTS };
  if (!doc) {
    await mongo.collection("meta").updateOne({ _id: "settings" }, { $set: { value: cache } }, { upsert: true });
  }
}

function loadSettings() {
  if (!cache) throw new Error("settings.init() must be awaited at startup before loadSettings() is called.");
  return { ...cache };
}

/** Save settings, with sane clamping so a bad value can't break the pipeline. */
async function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };

  next.retryThreshold = clamp(Number(next.retryThreshold), 0, 100);
  next.rejectThreshold = clamp(Number(next.rejectThreshold), 0, next.retryThreshold);
  next.maxRetrievalAttempts = clamp(Math.round(Number(next.maxRetrievalAttempts)), 1, 5);
  next.weightStep = clamp(Number(next.weightStep), 0.005, 0.1);
  next.minModelWeight = clamp(Number(next.minModelWeight), 0.03, 0.45);
  next.maxModelWeight = clamp(Number(next.maxModelWeight), 0.55, 0.97);
  next.recencyHalfLifeDays = clamp(Math.round(Number(next.recencyHalfLifeDays)), 0, 365);
  next.calibrationStrength = clamp(Number(next.calibrationStrength), 0, 3);
  next.modelTimeoutMs = clamp(Math.round(Number(next.modelTimeoutMs)), 5000, 120000);
  next.maxModelRetries = clamp(Math.round(Number(next.maxModelRetries)), 0, 4);
  next.cacheEnabled = Boolean(next.cacheEnabled);

  cache = next;
  await mongo.collection("meta").updateOne({ _id: "settings" }, { $set: { value: next } }, { upsert: true });
  return next;
}

async function resetSettings() {
  cache = { ...DEFAULTS };
  await mongo.collection("meta").updateOne({ _id: "settings" }, { $set: { value: cache } }, { upsert: true });
  return { ...cache };
}

module.exports = { init, loadSettings, saveSettings, resetSettings, DEFAULTS };
