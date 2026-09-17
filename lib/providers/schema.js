const { clamp, round } = require("../utils");

// The one prediction schema every model (AI or statistical) must conform to.
// Keeping this in one place means the Consensus Engine, grading, and UI
// never need to know which provider produced a given prediction.
const ARRAY_FIELDS = ["key_stats_used", "weaknesses", "likely_scorelines"];
const PROB_FIELDS = ["home_win_prob", "draw_prob", "away_win_prob", "btts_prob", "confidence"];
const OU_KEYS = ["o05", "o15", "o25", "o35"];

/**
 * Deterministically validate + repair a raw model prediction object.
 * Never trusts the model's own claims about ranges — clamps, coerces, and
 * flags anything implausible rather than letting a hallucinated value (e.g.
 * a probability of 340, or a string instead of a number) propagate into the
 * Consensus Engine's math. Returns { valid, errors, sanitized }.
 *
 * "valid: false" is reserved for responses missing structurally required
 * pieces (no usable winner-probability triplet at all); everything else is
 * repaired in place and reported as a warning in `errors` so the caller can
 * log it, but the sanitized object is still usable.
 */
function validatePredictionSchema(json) {
  const errors = [];
  if (!json || typeof json !== "object") {
    return { valid: false, errors: ["Response was not a JSON object."], sanitized: null };
  }

  const sanitized = { ...json };

  // Coerce numeric fields that came back as strings ("55" instead of 55),
  // and clamp anything out of the valid 0-100 probability range.
  for (const field of PROB_FIELDS) {
    let v = sanitized[field];
    if (v != null && typeof v !== "number") {
      const parsed = parseFloat(v);
      v = Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof v === "number" && (v < 0 || v > 100)) {
      errors.push(`${field} was out of range (${v}) — clamped to 0-100.`);
      v = clamp(v, 0, 100);
    }
    sanitized[field] = v === undefined ? null : v;
  }

  const winnerFields = ["home_win_prob", "draw_prob", "away_win_prob"];
  const haveAllWinnerFields = winnerFields.every((f) => typeof sanitized[f] === "number");
  if (!haveAllWinnerFields) {
    return { valid: false, errors: [...errors, "Missing one or more of home_win_prob/draw_prob/away_win_prob."], sanitized };
  }
  const winnerSum = winnerFields.reduce((s, f) => s + sanitized[f], 0);
  if (winnerSum < 40 || winnerSum > 160) {
    errors.push(`Match-winner probabilities summed to an implausible ${round(winnerSum, 1)} — response likely unreliable.`);
  }

  // over_under block: coerce each threshold's over_pct, tolerate a missing block entirely (null it out cleanly).
  if (sanitized.over_under && typeof sanitized.over_under === "object") {
    const ou = { ...sanitized.over_under };
    for (const key of OU_KEYS) {
      const pct = ou[key]?.over_pct;
      if (pct != null && typeof pct !== "number") {
        const parsed = parseFloat(pct);
        ou[key] = { over_pct: Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null };
      } else if (typeof pct === "number" && (pct < 0 || pct > 100)) {
        errors.push(`over_under.${key}.over_pct out of range (${pct}) — clamped.`);
        ou[key] = { over_pct: clamp(pct, 0, 100) };
      }
    }
    sanitized.over_under = ou;
  } else {
    errors.push("Missing over_under block.");
    sanitized.over_under = { o05: { over_pct: null }, o15: { over_pct: null }, o25: { over_pct: null }, o35: { over_pct: null } };
  }

  for (const field of ARRAY_FIELDS) {
    const v = sanitized[field];
    if (v != null && !Array.isArray(v)) sanitized[field] = [String(v)];
  }

  // Likely scorelines should look like "N-N" — drop anything that doesn't, rather than passing junk to the UI.
  if (Array.isArray(sanitized.likely_scorelines)) {
    const before = sanitized.likely_scorelines.length;
    sanitized.likely_scorelines = sanitized.likely_scorelines.filter((s) => /^\d{1,2}-\d{1,2}$/.test(String(s).trim()));
    if (sanitized.likely_scorelines.length < before) errors.push("Some likely_scorelines entries weren't valid 'N-N' scorelines and were dropped.");
  }

  return { valid: true, errors, sanitized };
}

module.exports = { validatePredictionSchema, PROB_FIELDS, ARRAY_FIELDS, OU_KEYS };
