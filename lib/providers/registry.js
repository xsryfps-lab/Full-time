/**
 * Single source of truth for every prediction model in the app. Nothing
 * outside this file (and the provider files themselves) should hardcode a
 * model's name, storage key, or count. To add a model: write a new file
 * implementing BaseProvider, add one line below, done — the consensus
 * engine, weight learning, dashboard, history, health checks, and Model
 * Performance page all iterate this list generically.
 */
const cohere = require("./cohereProvider");
const gemini = require("./geminiProvider");
const exaVoice = require("./exaVoiceProvider");
const poisson = require("./poissonProvider");

const PROVIDERS = [cohere, gemini, exaVoice, poisson];

function getProviders() {
  return PROVIDERS;
}

function getAIProviders() {
  return PROVIDERS.filter((p) => p.kind === "ai");
}

function getStatisticalProviders() {
  return PROVIDERS.filter((p) => p.kind === "statistical");
}

function getProviderByName(name) {
  return PROVIDERS.find((p) => p.name.toLowerCase() === String(name).toLowerCase()) || null;
}

const MODEL_NAMES = PROVIDERS.map((p) => p.name);
const modelKeyFor = (name) => name.toLowerCase();

module.exports = { getProviders, getAIProviders, getStatisticalProviders, getProviderByName, MODEL_NAMES, modelKeyFor };
