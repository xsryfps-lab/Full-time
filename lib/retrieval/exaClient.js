const { withTimeout } = require("../utils");
const { loadSettings } = require("../settings");

// Raw Exa API wrapper. Exa is a paid API (free trial credits on signup, not
// a perpetual free tier like the other providers in this project) — see
// https://exa.ai/pricing for current terms before relying on it long-term.
const API_URL = "https://api.exa.ai/answer";

/**
 * Ask Exa's /answer endpoint a question. Returns a synthesized, search-grounded
 * text answer plus its source citations — NOT structured JSON (that's handled
 * by a separate extraction step, see exaRetriever.js).
 */
async function exaAnswer(query) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new Error("EXA_API_KEY is not set. Get a key (with free trial credits) at https://dashboard.exa.ai/api-keys and add it to .env.");
  }
  const { modelTimeoutMs } = loadSettings();

  const doFetch = fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, text: true }),
  });

  const resp = await withTimeout(doFetch, modelTimeoutMs, "Exa request");

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Exa API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  return {
    answer: data.answer || "",
    citations: (data.citations || []).map((c) => ({ title: c.title, url: c.url })),
  };
}

module.exports = { exaAnswer, isConfigured: () => Boolean(process.env.EXA_API_KEY) };
