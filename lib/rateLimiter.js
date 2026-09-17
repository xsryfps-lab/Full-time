const mongo = require("./db/mongo");

// Per-user daily analysis quotas, keyed by UTC date then by username, e.g.
// { "2026-08-10": { "friend1": 2, "friend2": 5 } }. Pruned to the last 14
// days on every write, since older entries have no further use once a day
// has passed. Kept as a single in-memory object (loaded once from MongoDB
// at startup) for the same reason as metrics.js: recordUsage() is called
// synchronously from server.js with no `await`, and this preserves that —
// the cache updates immediately, the MongoDB write happens in the
// background.

const RETENTION_DAYS = 14;
let _cache = null;

async function init() {
  const doc = await mongo.collection("meta").findOne({ _id: "usage" });
  _cache = doc ? doc.value : {};
  if (!doc) await persist();
}

function load() {
  if (!_cache) throw new Error("rateLimiter.init() must be awaited at startup before rate-limiter functions are used.");
  return _cache;
}

function persist() {
  return mongo
    .collection("meta")
    .updateOne({ _id: "usage" }, { $set: { value: _cache } }, { upsert: true })
    .catch((err) => console.error("Failed to persist usage data to MongoDB:", err.message));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** Drop any date keys older than RETENTION_DAYS, in place. */
function pruneOldDates(usage) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (RETENTION_DAYS - 1));
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(usage)) {
    if (key < cutoffKey) delete usage[key];
  }
}

function getUsedToday(username) {
  const usage = load();
  const today = todayKey();
  return usage[today]?.[username] || 0;
}

/** Increment today's usage count for a username. Only call this for a genuine cache MISS — a cache hit must always be free. */
function recordUsage(username) {
  const usage = load();
  const today = todayKey();
  if (!usage[today]) usage[today] = {};
  usage[today][username] = (usage[today][username] || 0) + 1;
  pruneOldDates(usage);
  persist();
  return usage[today][username];
}

/** dailyLimit of null/undefined means unlimited. */
function getUsageInfo(username, dailyLimit) {
  const used = getUsedToday(username);
  if (dailyLimit === null || dailyLimit === undefined) {
    return { used, limit: null, remaining: null };
  }
  return { used, limit: dailyLimit, remaining: Math.max(0, dailyLimit - used) };
}

function hasQuotaRemaining(username, dailyLimit) {
  if (dailyLimit === null || dailyLimit === undefined) return true;
  return getUsedToday(username) < dailyLimit;
}

module.exports = { init, getUsedToday, recordUsage, getUsageInfo, hasQuotaRemaining };
