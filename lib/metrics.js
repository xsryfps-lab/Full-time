const { round } = require("./utils");
const mongo = require("./db/mongo");

function defaultMetrics() {
  return {
    providers: {}, // { name: { calls, successes, failures, jsonParseFailures, totalLatencyMs, lastError, lastErrorAt } }
    retrieval: { attempts: 0, successes: 0, retries: 0, rejections: 0 },
    consensus: { runs: 0, allModelsFailed: 0 },
    pipeline: { totalRuns: 0, totalDurationMs: 0, failures: 0 },
  };
}

// In-memory cache, loaded once at startup via init(). Every recordX()
// function below is called synchronously throughout the app (provider
// files, retrieval, agents.js) with no `await` at the call site — that
// stays true here too: the cache updates immediately and synchronously,
// and the MongoDB write happens in the background (fire-and-forget, with
// a logged warning if it ever fails) rather than being awaited, so none of
// those existing call sites need to change.
let _cache = null;

async function init() {
  const doc = await mongo.collection("meta").findOne({ _id: "metrics" });
  _cache = doc ? { ...defaultMetrics(), ...doc.value } : defaultMetrics();
  if (!doc) await persist();
}

function load() {
  if (!_cache) throw new Error("metrics.init() must be awaited at startup before metrics functions are used.");
  return _cache;
}

function persist() {
  return mongo
    .collection("meta")
    .updateOne({ _id: "metrics" }, { $set: { value: _cache } }, { upsert: true })
    .catch((err) => console.error("Failed to persist metrics to MongoDB:", err.message));
}

function recordProviderCall(name, { success, latencyMs = 0, jsonParseFailed = false, error = null }) {
  const m = load();
  if (!m.providers[name]) m.providers[name] = { calls: 0, successes: 0, failures: 0, jsonParseFailures: 0, totalLatencyMs: 0, lastError: null, lastErrorAt: null };
  const p = m.providers[name];
  p.calls += 1;
  if (success) p.successes += 1;
  else {
    p.failures += 1;
    p.lastError = error;
    p.lastErrorAt = new Date().toISOString();
  }
  if (jsonParseFailed) p.jsonParseFailures += 1;
  p.totalLatencyMs += latencyMs;
  persist();
}

function recordRetrieval({ outcome }) {
  // outcome: "success" | "retry" | "rejection"
  const m = load();
  m.retrieval.attempts += 1;
  if (outcome === "success") m.retrieval.successes += 1;
  else if (outcome === "retry") m.retrieval.retries += 1;
  else if (outcome === "rejection") m.retrieval.rejections += 1;
  persist();
}

function recordConsensus({ allFailed }) {
  const m = load();
  m.consensus.runs += 1;
  if (allFailed) m.consensus.allModelsFailed += 1;
  persist();
}

function recordPipelineRun({ durationMs, failed = false }) {
  const m = load();
  m.pipeline.totalRuns += 1;
  m.pipeline.totalDurationMs += durationMs;
  if (failed) m.pipeline.failures += 1;
  persist();
}

/** Derived, display-ready view of the raw counters. */
function getMetricsSummary() {
  const m = load();
  const providers = Object.fromEntries(
    Object.entries(m.providers).map(([name, p]) => [
      name,
      {
        ...p,
        successRate: p.calls ? round((100 * p.successes) / p.calls, 1) : null,
        avgLatencyMs: p.calls ? round(p.totalLatencyMs / p.calls, 0) : null,
      },
    ])
  );
  return {
    providers,
    retrieval: {
      ...m.retrieval,
      successRate: m.retrieval.attempts ? round((100 * m.retrieval.successes) / m.retrieval.attempts, 1) : null,
    },
    consensus: m.consensus,
    pipeline: {
      ...m.pipeline,
      avgDurationMs: m.pipeline.totalRuns ? round(m.pipeline.totalDurationMs / m.pipeline.totalRuns, 0) : null,
      failureRate: m.pipeline.totalRuns ? round((100 * m.pipeline.failures) / m.pipeline.totalRuns, 1) : null,
    },
  };
}

function resetMetrics() {
  _cache = defaultMetrics();
  persist();
  return _cache;
}

module.exports = { init, recordProviderCall, recordRetrieval, recordConsensus, recordPipelineRun, getMetricsSummary, resetMetrics };
