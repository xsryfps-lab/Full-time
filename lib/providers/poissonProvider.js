const BaseProvider = require("./BaseProvider");
const { computePoissonPrediction } = require("../poissonModel");

// The statistical model participates in the exact same interface as the AI
// providers — it's just always "configured" (no API key needed) and its
// predict() takes retrieval data instead of a system/user prompt. This lets
// the pipeline, consensus engine, dashboard, and health checks treat it as
// just another voice rather than a special case.
class PoissonProvider extends BaseProvider {
  constructor() {
    super("Poisson", "statistical");
  }

  isConfigured() {
    return true; // no external dependency
  }

  async complete() {
    throw new Error("Poisson is a statistical model, not an LLM — it has no generic complete() call. Use predict({retrievalData, engineeredFeatures}).");
  }

  /** @param {{retrievalData: object, engineeredFeatures: object}} context */
  async predict({ retrievalData, engineeredFeatures }) {
    return computePoissonPrediction(retrievalData, engineeredFeatures); // null if not enough data — a legitimate outcome, not a failure
  }

  validateResponse(json) {
    // Deterministic math never hallucinates a schema violation, but we still
    // run it through the same shape check for consistency and defense in
    // depth (e.g. a future refactor of poissonModel.js that breaks a field).
    const { validatePredictionSchema } = require("./schema");
    return json ? validatePredictionSchema(json) : { valid: true, errors: [], sanitized: null };
  }

  async healthCheck() {
    return { ok: true, configured: true, latencyMs: 0, error: null };
  }

  getModelInformation() {
    return {
      name: this.name,
      kind: this.kind,
      isAI: false,
      apiProvider: "None (local computation)",
      model: "Poisson + Dixon-Coles",
      role: "Statistical baseline / independent prediction voice",
      description: "Deterministic goal-expectation model with the Dixon-Coles low-score correlation correction. Zero API cost, zero latency, not an AI — provides the statistical anchor every AI model is instructed to reason from.",
    };
  }
}

module.exports = new PoissonProvider();
