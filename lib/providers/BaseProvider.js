/**
 * Every prediction model in this app — LLM or statistical — implements this
 * same interface. The pipeline (lib/agents.js) never checks "if this is
 * Cohere" or "if this is Poisson" anywhere; it only ever calls these four
 * methods. Adding a new model is: create one new file in lib/providers/
 * that implements this class, register it in lib/providers/registry.js, and
 * everything else (consensus, weighting, dashboard, history, health checks)
 * picks it up automatically.
 */
class BaseProvider {
  /**
   * @param {string} name - Display name, e.g. "Cohere". Also used as the
   *   storage key (lowercased) throughout the app.
   * @param {"ai"|"statistical"} kind
   */
  constructor(name, kind) {
    if (new.target === BaseProvider) throw new Error("BaseProvider is abstract — extend it.");
    this.name = name;
    this.kind = kind; // "ai" | "statistical"
  }

  /** Is this provider usable right now (API key present, etc.)? Synchronous, no network call. */
  isConfigured() {
    throw new Error(`${this.name}.isConfigured() not implemented`);
  }

  /**
   * Run a raw completion and return parsed JSON. Used both for the
   * prediction call and (for LLM providers) for the retrieval extraction
   * step, since both are "give me structured JSON back" calls that differ
   * only in the prompt. Statistical providers that don't wrap an LLM (e.g.
   * Poisson) should throw — they don't have a generic completion method,
   * only predict().
   * @returns {Promise<object>} parsed JSON
   */
  async complete(_system, _userText, _maxTokens) {
    throw new Error(`${this.name}.complete() not implemented`);
  }

  /**
   * Produce a full prediction in the app's standard schema (see
   * lib/providers/schema.js). For AI providers, `context` is
   * {system, userText, maxTokens}. For statistical providers, `context` is
   * {retrievalData, engineeredFeatures}.
   * @returns {Promise<object|null>} standard prediction object, or null if
   *   there isn't enough data to produce one at all (not the same as a
   *   failure — e.g. Poisson returns null when goal-rate data is missing).
   */
  async predict(_context) {
    throw new Error(`${this.name}.predict() not implemented`);
  }

  /**
   * Deterministic, local validation of a prediction object against the
   * shared schema — range checks, required fields, type coercion. Does NOT
   * make a network call. Returns { valid, errors, sanitized }.
   */
  validateResponse(_json) {
    throw new Error(`${this.name}.validateResponse() not implemented`);
  }

  /**
   * Cheap liveness/configuration check. By default (live:false) this is a
   * synchronous config check only — no network call, safe to run on every
   * dashboard/health page load. Pass {live:true} to actually ping the
   * provider with a minimal request and measure real latency.
   * @returns {Promise<{ok:boolean, configured:boolean, latencyMs:?number, error:?string}>}
   */
  async healthCheck({ live = false } = {}) {
    const configured = this.isConfigured();
    if (!configured) return { ok: false, configured: false, latencyMs: null, error: `${this.name} is not configured (missing API key).` };
    if (!live) return { ok: true, configured: true, latencyMs: null, error: null };
    const start = Date.now();
    try {
      await this.complete("Reply with exactly this JSON and nothing else: {\"ok\":true}", "ping", 20);
      return { ok: true, configured: true, latencyMs: Date.now() - start, error: null };
    } catch (err) {
      return { ok: false, configured: true, latencyMs: Date.now() - start, error: err.message };
    }
  }

  /** Static metadata for display purposes (About, Health, Model Performance pages). */
  getModelInformation() {
    throw new Error(`${this.name}.getModelInformation() not implemented`);
  }
}

module.exports = BaseProvider;
