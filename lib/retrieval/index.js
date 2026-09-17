// Retriever abstraction. Every retriever module must export an async
// retrieve(fixture) that resolves to { data, completeness, attempts, log, matchType }
// (or throws with a clear .message if data quality is too low to use).
//
// To swap retrievers later (e.g. a different search provider): write a new
// module with that same shape and change ONLY the require() below. Nothing
// in lib/agents.js or downstream needs to change.
const activeRetriever = require("./exaRetriever");

module.exports = activeRetriever;
