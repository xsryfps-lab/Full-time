/**
 * Lightweight structured logger. Prints to the console (visible in the
 * terminal running `npm start`) AND returns each entry so callers can attach
 * it to a prediction record for later inspection on the History page.
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 1;

function logEvent(category, message, meta = {}, level = "info") {
  const entry = { ts: new Date().toISOString(), level, category, message, ...meta };
  if ((LEVELS[level] ?? 1) >= MIN_LEVEL) {
    const line = `[${entry.ts}] [${level.toUpperCase()}] [${category}] ${message}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(line, Object.keys(meta).length ? meta : "");
  }
  return entry;
}

module.exports = {
  logEvent,
  debug: (category, message, meta) => logEvent(category, message, meta, "debug"),
  info: (category, message, meta) => logEvent(category, message, meta, "info"),
  warn: (category, message, meta) => logEvent(category, message, meta, "warn"),
  error: (category, message, meta) => logEvent(category, message, meta, "error"),
};
