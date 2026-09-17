const { extractJSON, withTimeout } = require("./utils");
const { loadSettings } = require("./settings");

/**
 * Shared caller for OpenAI-compatible Chat Completions APIs. Not currently
 * used by any active provider (Mistral, the last one that spoke this
 * dialect, was removed) — kept as ready-to-use shared infrastructure for
 * the next OpenAI-compatible provider this project adds, given how often
 * that's happened before (see the provider-history section in README.md).
 * Cohere and Gemini speak a slightly different shape and keep their own
 * client, but still use extractJSON here.
 */
async function callOpenAICompatible({ apiUrl, apiKey, model, system, userText, maxTokens, providerName, extraHeaders = {}, extraBody = {} }) {
  if (!apiKey) {
    throw new Error(`${providerName}_API_KEY is not set. Add it to your .env file.`);
  }
  if (!model) {
    throw new Error(`${providerName}_MODEL is not set. Add it to your .env file.`);
  }

  const { modelTimeoutMs } = loadSettings();

  const doFetch = fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      ...extraBody,
    }),
  });

  const resp = await withTimeout(doFetch, modelTimeoutMs, `${providerName} request`);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`${providerName} API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error(`${providerName} returned an empty response.`);
  return text;
}

function makeJSONCaller(rawCaller) {
  return async function callJSON(system, userText, maxTokens) {
    const text = await rawCaller(system, userText, maxTokens);
    return extractJSON(text);
  };
}

module.exports = { callOpenAICompatible, makeJSONCaller };
