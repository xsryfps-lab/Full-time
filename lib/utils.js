const crypto = require("crypto");

/** Pull the first {...} JSON object out of a model response, stripping code fences and stray prose. */
function extractJSON(text) {
  let t = (text || "").trim();
  t = t.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in model output: " + t.slice(0, 200));
  }
  let candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    // Common free-tier slip: trailing commas before a closing bracket/brace.
    const cleaned = candidate.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(cleaned);
    } catch (err2) {
      throw new Error("Could not parse JSON from model output: " + err.message);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  return /\b429\b|rate.?limit|too many requests/i.test(err?.message || "");
}

/**
 * Retry a call a few times with exponential backoff + jitter. Mainly for
 * free/open models that occasionally return near-valid JSON with a small
 * formatting slip, or transient network/rate-limit errors.
 *
 * Rate-limit (429) errors get a much longer backoff than everything else:
 * a per-second or per-minute cap simply hasn't cleared yet after only
 * 400-800ms, so retrying that fast just burns retries for nothing — it's
 * effectively the same as not retrying at all. A few seconds gives an RPS-
 * style limit a real chance to reset before the next attempt.
 */
async function withRetry(fn, { retries = 2, label = "call", baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`${label} failed (attempt ${attempt}/${retries + 1}): ${err.message}`);
      if (attempt <= retries) {
        const delay = isRateLimitError(err)
          ? 3000 * attempt + Math.random() * 500
          : baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 150;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

/** Race a promise against a timeout, throwing a labeled error if the timeout wins. */
function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function newId() {
  return crypto.randomUUID();
}

function fixtureKey({ home, away, league, date }) {
  const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  // League is included so two different competitions between the same two
  // teams on the same date can never collide in the cache.
  return `${norm(home)}|${norm(away)}|${norm(date)}|${norm(league)}`;
}

/** Safe average of an array of numbers, ignoring null/undefined/NaN. Returns null if nothing valid. */
function safeAvg(nums) {
  const valid = (nums || []).filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function stddev(nums) {
  const valid = (nums || []).filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (valid.length < 2) return null;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  return Math.sqrt(variance);
}

/** Clamp a number between min and max. */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** Round to N decimal places, passing through null. */
function round(n, decimals = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/** Linear-interpolate t (0-1) between a and b. */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Snap a predicted average (e.g. expected corners, cards, shots on target)
 * to the nearest realistic bookmaker-style ".5" line — sportsbooks always
 * use half-increments so a market never pushes/voids. E.g. 9.8 -> 9.5,
 * 10.1 -> 10.5.
 */
function roundToHalfLine(value) {
  return Math.round(value - 0.5) + 0.5;
}

/** ISO timestamp helper, centralized so tests / future storage engines can mock it. */
function now() {
  return new Date().toISOString();
}

module.exports = {
  extractJSON,
  withRetry,
  withTimeout,
  isRateLimitError,
  sleep,
  newId,
  fixtureKey,
  safeAvg,
  stddev,
  clamp,
  round,
  lerp,
  roundToHalfLine,
  now,
};
