const BaseProvider = require("./BaseProvider");
const { extractJSON, withTimeout } = require("../utils");
const { validatePredictionSchema } = require("./schema");
const { loadSettings } = require("../settings");
const metrics = require("../metrics");

// Google Gemini: chosen to replace DeepSeek — a generous no-credit-card
// free tier and native structured-output support (responseMimeType:
// "application/json"), which is a more reliable way to get clean JSON than
// prompt-only instructions. Uses Gemini's own REST shape (generateContent),
// not the OpenAI-compatible dialect.
//
// IMPORTANT: Google retires Gemini model versions on a rolling basis —
// gemini-2.5-flash is already restricted to existing users only and is
// scheduled for full shutdown in October 2026, which is why the default
// here is gemini-3.1-flash-lite instead. If this provider starts failing with a
// 404 "model not found" error, check
// https://ai.google.dev/gemini-api/docs/models for the current lineup and
// set GEMINI_MODEL accordingly — that's a provider-side change outside the
// app's control, not a bug.
// https://aistudio.google.com/apikey
class GeminiProvider extends BaseProvider {
  constructor() {
    super("Gemini", "ai");
  }

  get model() {
    return process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  }

  isConfigured() {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  async complete(system, userText, maxTokens = 1800) {
    const start = Date.now();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const err = new Error("GEMINI_API_KEY is not set.");
      metrics.recordProviderCall(this.name, { success: false, latencyMs: 0, error: err.message });
      throw err;
    }
    const { modelTimeoutMs } = loadSettings();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;

    let text;
    try {
      const doFetch = fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
          },
        }),
      });
      const resp = await withTimeout(doFetch, modelTimeoutMs, "Gemini request");
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
      }
      const data = await resp.json();
      text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      if (!text) {
        const blockReason = data.promptFeedback?.blockReason;
        throw new Error(blockReason ? `Gemini blocked the response (${blockReason}).` : "Gemini returned an empty response.");
      }
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
      apiProvider: "Google Gemini",
      model: this.model,
      role: "Extraction model (retrieval) + independent prediction voice",
      description: "Ggemini-3.1-flash-lite by default. Handles the retrieval-extraction step (turning raw search text into structured data) using native JSON-mode output, and also runs as one of the four independent prediction voices. Google retires model versions on a rolling basis — see GEMINI_MODEL in .env.example if this ever needs updating.",
    };
  }
}

module.exports = new GeminiProvider();
