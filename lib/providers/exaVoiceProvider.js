const BaseProvider = require("./BaseProvider");
const { exaAnswer } = require("../retrieval/exaClient");
const { extractJSON } = require("../utils");
const { validatePredictionSchema } = require("./schema");
const metrics = require("../metrics");

// Exa is already the app's retrieval engine — this provider gives it a
// SECOND, distinct job: an actual prediction voice. Deliberately different
// in kind from the other two AI providers: Cohere/Gemini
// all reason from the exact same structured dataset (retrieved stats +
// engineered features) with no web access of their own, which is what
// makes comparing their accuracy and learning per-model weights fair. Exa,
// instead, does its OWN live web search for the fixture and forms an
// opinion from whatever it finds right now (recent news, injury updates,
// expert previews) — a genuinely internet-grounded perspective the other
// two structurally can't offer, without giving each of THEM inconsistent,
// uncontrolled web access (which would break the apples-to-apples
// comparison the whole weighting/calibration system depends on).
//
// Trade-off, stated plainly: Exa's /answer endpoint is a search-and-answer
// tool, not a JSON-native chat model like the others, so its compliance
// with the strict output schema may be less reliable. Like any other
// model, if it fails to comply it's simply excluded from that analysis —
// nothing else breaks.
class ExaVoiceProvider extends BaseProvider {
  constructor() {
    super("Exa", "ai");
  }

  isConfigured() {
    return Boolean(process.env.EXA_API_KEY);
  }

  async complete(system, userText) {
    const start = Date.now();
    let text;
    try {
      const result = await exaAnswer(`${system}\n\n${userText}`);
      text = result.answer;
      if (!text) throw new Error("Exa returned an empty answer.");
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

  /** @param {{fixture: {home:string, away:string, league:string, date:string}}} context */
  async predict({ fixture }) {
    const query = buildExaPredictionQuery(fixture);
    const raw = await this.complete("", query);
    const { valid, errors, sanitized } = this.validateResponse(raw);
    if (!valid) throw new Error(`${this.name} response failed schema validation: ${errors.join(" ")}`);
    return sanitized;
  }

  validateResponse(json) {
    return validatePredictionSchema(json);
  }

  // Exa is a paid API — even a "live" health check never fires a real
  // search, to avoid spending credits on a routine check. Configuration
  // status is the only thing checked; a real analysis is the true test.
  async healthCheck() {
    const configured = this.isConfigured();
    return { ok: configured, configured, latencyMs: null, error: configured ? null : "EXA_API_KEY is not set." };
  }

  getModelInformation() {
    return {
      name: this.name,
      kind: this.kind,
      isAI: true,
      apiProvider: "Exa",
      model: "exa-answer (live web search)",
      role: "Independent, internet-grounded prediction voice",
      description: "Does its own live web search for this specific fixture rather than reasoning from the shared structured dataset — the only voice with real-time internet access.",
    };
  }
}

function buildExaPredictionQuery(fixture) {
  const { home, away, league, date } = fixture;
  return `Based on the most current news, team form, injuries, and expert analysis available online right now, predict the outcome of this football match: ${home} vs ${away} in ${league} on ${date}.

Respond with ONLY a single JSON object and no other text, matching exactly this schema:
{"home_win_prob": number, "draw_prob": number, "away_win_prob": number, "double_chance": {"home_or_draw": number, "draw_or_away": number, "home_or_away": number}, "btts_prob": number, "over_under": {"o05": {"over_pct": number}, "o15": {"over_pct": number}, "o25": {"over_pct": number}, "o35": {"over_pct": number}}, "expected_first_half_goals": number, "expected_second_half_goals": number, "likely_scorelines": ["2-1","1-1"], "confidence": number, "key_stats_used": ["short phrase"], "weaknesses": ["short phrase"], "missing_data_impact": "short phrase"}
home_win_prob + draw_prob + away_win_prob must sum to approximately 100. Use plain text only, no markdown fences, no prose outside the JSON object.`;
}

module.exports = new ExaVoiceProvider();
