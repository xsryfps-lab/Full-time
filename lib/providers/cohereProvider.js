const BaseProvider = require("./BaseProvider");
const { extractJSON, withTimeout } = require("../utils");
const { validatePredictionSchema } = require("./schema");
const { loadSettings } = require("../settings");
const metrics = require("../metrics");

// Cohere's Chat API v2 (v1 is legacy — v1's preamble/message request shape
// no longer applies here). v2 uses a `messages` array like the OpenAI
// dialect (system/user roles) plus a `response_format` flag that forces
// valid JSON output — genuinely more reliable than prompt-only formatting
// instructions. Default model is a "command-a" family model; override
// COHERE_MODEL in .env for a specific release (e.g. command-a-plus-05-2026)
// if your account has access to it — check
// https://docs.cohere.com/docs/models for the exact current model ID.
// https://dashboard.cohere.com/api-keys
const API_URL = "https://api.cohere.com/v2/chat";

class CohereProvider extends BaseProvider {
  constructor() {
    super("Cohere", "ai");
  }

  get model() {
    return process.env.COHERE_MODEL || "command-a-03-2025";
  }

  isConfigured() {
    return Boolean(process.env.COHERE_API_KEY);
  }

  async complete(system, userText, maxTokens = 1800) {
    const start = Date.now();
    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
      const err = new Error("COHERE_API_KEY is not set.");
      metrics.recordProviderCall(this.name, { success: false, latencyMs: 0, error: err.message });
      throw err;
    }
    const { modelTimeoutMs } = loadSettings();

    let text;
    try {
      const doFetch = fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userText },
          ],
          response_format: { type: "json_object" },
          max_tokens: maxTokens,
          temperature: 0.4,
        }),
      });
      const resp = await withTimeout(doFetch, modelTimeoutMs, "Cohere request");
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`Cohere API error ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      // v2 response shape: message.content is an array of content blocks.
      text = data.message?.content?.map((c) => c.text || "").join("") || "";
      if (!text) throw new Error("Cohere returned an empty response.");
    } catch (err) {
      metrics.recordProviderCall(this.name, { success: false, latencyMs: Date.now() - start, error: err.message });
      throw err;
    }

    try {
      const json = extractJSON(text);
      metrics.recordProviderCall(this.name, { success: true, latencyMs: Date.now() - start });
      return json;
    } catch (err) {
      metrics.recordProviderCall(this.name, { success: false, latencyMs: Date.now() - start, jsonParseFailed: true, error: err.message });
      throw err;
    }
  }

  async predict({ system, userText, maxTokens = 1800 }) {
    const raw = await this.complete(system, userText, maxTokens);
    const { valid, errors, sanitized } = this.validateResponse(raw);
    if (!valid) throw new Error(`${this.name} response failed schema validation: ${errors.join(" ")}`);
    return sanitized;
  }

  validateResponse(json) {
    return validatePredictionSchema(json);
  }

  getModelInformation() {
    return {
      name: this.name,
      kind: this.kind,
      isAI: true,
      apiProvider: "Cohere (Chat API v2)",
      model: this.model,
      role: "Independent prediction voice",
      description: "Command-A class LLM via Cohere's v2 Chat API, with forced JSON-object output.",
    };
  }
}

module.exports = new CohereProvider();
