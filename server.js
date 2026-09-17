require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const os = require("os");
const { runPipeline } = require("./lib/agents");
const db = require("./lib/database");
const settings = require("./lib/settings");
const logger = require("./lib/logger");
const metrics = require("./lib/metrics");
const { getProviders, getAIProviders } = require("./lib/providers/registry");
const { normalizeTeamName, normalizeCompetitionName, searchTeams, searchCompetitions } = require("./lib/teamDirectory");
const auth = require("./lib/auth");
const rateLimiter = require("./lib/rateLimiter");
const parlayBuilder = require("./lib/parlayBuilder");
const mongo = require("./lib/db/mongo");

const app = express();
const PORT = process.env.PORT || 3000;
const startedAt = Date.now();

app.use(cors());
app.use(express.json({ limit: "25mb" })); // predictions history can grow large; restore needs room
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate"),
  })
);

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Cleans, normalizes, and defaults every fixture input field centrally, so it's consistent regardless of which entry point (SSE/POST) is used. */
function validateFixture(q) {
  const home = normalizeTeamName(q.home || "");
  const away = normalizeTeamName(q.away || "");
  if (!home || !away) return null;
  return {
    home,
    away,
    league: normalizeCompetitionName(q.league || "") || "Unspecified competition",
    date: (q.date || "").trim() || todayISO(),
  };
}

// Express 4.x does not automatically catch a rejected promise thrown inside
// an async route handler — unlike a synchronous throw, it would otherwise
// just hang the request instead of returning a clean error. Used below for
// async handlers that don't already have their own try/catch.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      logger.error("api", "Unhandled error in route handler", { path: req.path, error: err.message });
      if (!res.headersSent) res.status(500).json({ error: err.message || "Internal server error" });
    });
  };
}

// ---------------------------------------------------------------------------
// Auth — login/logout/me are unauthenticated (you need them to log in at
// all). Every other /api/* route requires a valid session, enforced by the
// gate registered right after these three.
// ---------------------------------------------------------------------------

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = auth.findUserByUsername(username);
  if (!user || !auth.verifyPassword(user, password)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  res.json({ ok: true, user: auth.publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = auth.parseCookies(req);
  auth.destroySession(cookies[auth.SESSION_COOKIE]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const cookies = auth.parseCookies(req);
  const user = auth.getSessionUser(cookies[auth.SESSION_COOKIE]);
  if (!user) return res.status(401).json({ error: "Not authenticated." });
  const usageToday = user.role === "admin" ? null : rateLimiter.getUsageInfo(user.username, user.dailyLimit);
  res.json({ user: { ...user, usageToday } });
});

// Every other /api/* route requires a valid session from here on. Skips
// only these exact three paths above by name (not a "/auth/" prefix match)
// so that a route like /api/auth/change-password below — which needs
// req.user — is authenticated by default rather than accidentally exempted.
const PUBLIC_API_PATHS = new Set(["/auth/login", "/auth/logout", "/auth/me"]);
app.use("/api", (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  return auth.requireAuth(req, res, next);
});

// Self-service password change — any logged-in user, registered after the
// gate above so it's authenticated like everything else past this point.
app.post("/api/auth/change-password", async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  try {
    await auth.changePassword(req.user.id, oldPassword, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// User management — admin only.
// ---------------------------------------------------------------------------

app.get("/api/users", auth.requireAdmin, (req, res) => {
  const users = auth.listUsers().map((u) => {
    const pub = auth.publicUser(u);
    return { ...pub, usageToday: rateLimiter.getUsageInfo(pub.username, pub.dailyLimit) };
  });
  res.json({ users });
});

app.post("/api/users", auth.requireAdmin, async (req, res) => {
  try {
    const { username, password, role, dailyLimit } = req.body || {};
    const user = await auth.createUser({ username, password, role, dailyLimit });
    res.json({ ok: true, user: auth.publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/users/:id", auth.requireAdmin, async (req, res) => {
  try {
    const { role, dailyLimit } = req.body || {};
    const patch = {};
    if (role !== undefined) patch.role = role;
    if (dailyLimit !== undefined) patch.dailyLimit = dailyLimit;
    const user = await auth.updateUser(req.params.id, patch);
    res.json({ ok: true, user: auth.publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/users/:id/reset-password", auth.requireAdmin, async (req, res) => {
  try {
    await auth.resetPassword(req.params.id, req.body?.newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/users/:id", auth.requireAdmin, async (req, res) => {
  try {
    await auth.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Analysis — cache-first. SSE for live progress, plus a plain POST endpoint.
// ---------------------------------------------------------------------------

// A cache hit costs zero API calls and must always be free, regardless of a
// friend's remaining quota — so quota is only checked for requests that
// would actually consume it. Checked before the pipeline runs; usage is
// only recorded afterward if the run turned out to be a genuine miss.
function wouldConsumeQuota(fixture, forceRefresh) {
  if (forceRefresh) return true;
  if (!settings.loadSettings().cacheEnabled) return true;
  return db.findPrediction(fixture) === null;
}

app.get("/api/analyze/stream", async (req, res) => {
  const fixture = validateFixture(req.query);
  if (!fixture) {
    res.status(400).json({ error: "home and away are required" });
    return;
  }
  const forceRefresh = req.query.force === "true";

  if (req.user.role !== "admin" && wouldConsumeQuota(fixture, forceRefresh) && !rateLimiter.hasQuotaRemaining(req.user.username, req.user.dailyLimit)) {
    res.status(429).json({ error: "Daily analysis limit reached. Try again tomorrow, or ask an admin to raise your limit." });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  try {
    const data = await runPipeline(
      fixture,
      (stepKey, state, detail) => {
        if (stepKey === "cache" && state === "hit") send("cached", {});
        else send("step", { key: stepKey, state, detail: detail || null });
      },
      { forceRefresh, createdBy: req.user.username }
    );
    if (!data._cached && req.user.role !== "admin") rateLimiter.recordUsage(req.user.username);
    send("result", data);
  } catch (err) {
    logger.error("api", "Analysis failed", { fixture, error: err.message });
    send("error", { message: err.message, code: err.code || null });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.post("/api/analyze", async (req, res) => {
  const fixture = validateFixture(req.body || {});
  if (!fixture) {
    res.status(400).json({ error: "home and away are required" });
    return;
  }
  const forceRefresh = req.body?.force === true;

  if (req.user.role !== "admin" && wouldConsumeQuota(fixture, forceRefresh) && !rateLimiter.hasQuotaRemaining(req.user.username, req.user.dailyLimit)) {
    return res.status(429).json({ error: "Daily analysis limit reached. Try again tomorrow, or ask an admin to raise your limit." });
  }

  try {
    const data = await runPipeline(fixture, () => {}, { forceRefresh, createdBy: req.user.username });
    if (!data._cached && req.user.role !== "admin") rateLimiter.recordUsage(req.user.username);
    res.json(data);
  } catch (err) {
    logger.error("api", "Analysis failed", { fixture, error: err.message });
    res.status(500).json({ error: err.message, code: err.code || null });
  }
});

// ---------------------------------------------------------------------------
// Smart search — team/competition autocomplete: seed directory + aliases +
// typo tolerance + this user's own history, ranked.
// ---------------------------------------------------------------------------

app.get("/api/teams/search", (req, res) => {
  const q = req.query.q || "";
  const extraNames = db.getKnownTeamNames();
  res.json({ results: searchTeams(q, { extraNames, limit: 8 }) });
});

app.get("/api/competitions/search", (req, res) => {
  const q = req.query.q || "";
  const extraNames = db.listPredictions({}).map((p) => p.fixture?.league).filter(Boolean);
  res.json({ results: searchCompetitions(q, { extraNames, limit: 8 }) });
});

// ---------------------------------------------------------------------------
// History — search/filter stored predictions, view one, submit feedback
// ---------------------------------------------------------------------------

app.get("/api/history", (req, res) => {
  const { competition, team, date, status, sort, createdBy } = req.query;
  let list = db.listPredictions({ competition, team, date, status, sort });
  if (createdBy) {
    const q = createdBy.toLowerCase();
    list = list.filter((p) => (p.createdBy || "").toLowerCase().includes(q));
  }
  res.json({ count: list.length, predictions: list });
});

app.get("/api/history/:id", (req, res) => {
  const record = db.getPredictionById(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  res.json(record);
});

app.delete("/api/history/:id", async (req, res) => {
  const record = db.getPredictionById(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (req.user.role !== "admin" && record.createdBy !== req.user.username) {
    return res.status(403).json({ error: "You can only delete your own predictions." });
  }
  try {
    await db.deletePrediction(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/api/history/:id/feedback", async (req, res) => {
  const { status, actualResult } = req.body || {};
  if (!["correct", "incorrect"].includes(status)) {
    return res.status(400).json({ error: "status must be 'correct' or 'incorrect'" });
  }
  try {
    const updated = await db.submitFeedback(req.params.id, { status, actualResult });
    res.json(updated);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dashboard / model stats
// ---------------------------------------------------------------------------

app.get("/api/dashboard", (req, res) => {
  res.json(db.getDashboardStats());
});

app.get("/api/model-stats/:model", (req, res) => {
  const key = req.params.model.toLowerCase();
  const validKeys = db.MODEL_NAMES.map((n) => n.toLowerCase());
  if (!validKeys.includes(key)) {
    return res.status(400).json({ error: `model must be one of: ${validKeys.join(", ")}` });
  }
  res.json(db.computeModelStats(key));
});

app.get("/api/weight-history", (req, res) => {
  res.json({ history: db.getWeightHistory() });
});

// ---------------------------------------------------------------------------
// Parlay Builder — auto-build (system picks legs) and manual combine (user
// picks legs). Available to any logged-in user, not admin-only.
// ---------------------------------------------------------------------------

app.get("/api/parlay/auto", (req, res) => {
  const minProbability = req.query.minProbability ? Number(req.query.minProbability) : undefined;
  res.json(parlayBuilder.autoBuildParlays({ minProbability }));
});

app.post("/api/parlay/combine", (req, res) => {
  try {
    res.json({ ok: true, parlay: parlayBuilder.manualBuildParlay(req.body?.legs || []) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Competitions autocomplete (legacy — kept for the existing analyze page filter)
// ---------------------------------------------------------------------------

app.get("/api/competitions", (req, res) => {
  const all = db.listPredictions({});
  const names = [...new Set(all.map((p) => p.fixture?.league).filter(Boolean))].sort();
  res.json({ competitions: names });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.get("/api/settings", auth.requireAdmin, (req, res) => res.json(settings.loadSettings()));
app.post("/api/settings", auth.requireAdmin, asyncRoute(async (req, res) => res.json(await settings.saveSettings(req.body || {}))));
app.post("/api/settings/reset", auth.requireAdmin, asyncRoute(async (req, res) => res.json(await settings.resetSettings())));

// ---------------------------------------------------------------------------
// Database management
// ---------------------------------------------------------------------------

app.get("/api/database/info", auth.requireAdmin, asyncRoute(async (req, res) => res.json(await db.getDatabaseInfo())));

app.post("/api/database/recompute-weights", auth.requireAdmin, asyncRoute(async (req, res) => {
  const weights = await db.recomputeAllWeights();
  res.json({ ok: true, weights });
}));

app.post("/api/database/clear", auth.requireAdmin, asyncRoute(async (req, res) => {
  if (req.body?.confirm !== "DELETE ALL DATA") {
    return res.status(400).json({ error: 'Confirmation phrase required: send {"confirm":"DELETE ALL DATA"}' });
  }
  await db.clearAllPredictions();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

app.get("/api/backup", auth.requireAdmin, (req, res) => {
  const backup = db.exportAllData();
  res.setHeader("Content-Disposition", `attachment; filename="full-time-backup-${Date.now()}.json"`);
  res.json(backup);
});

app.post("/api/restore", auth.requireAdmin, async (req, res) => {
  try {
    const result = await db.importAllData(req.body);
    res.json({ ok: true, restored: result.predictions.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health / system / performance
// ---------------------------------------------------------------------------

app.get("/api/health", auth.requireAdmin, (req, res) => {
  const models = {};
  getProviders().forEach((p) => {
    const info = p.getModelInformation();
    models[db.modelKeyFor(p.name)] = { model: info.model, role: info.role, isAI: info.isAI, configured: p.isConfigured() };
  });
  res.json({ ok: true, models, consensus: "deterministic, market-specific weighted engine (no AI call) — see lib/consensusEngine.js" });
});

app.get("/api/system/health", auth.requireAdmin, asyncRoute(async (req, res) => {
  const providers = {};
  for (const p of getProviders()) {
    providers[p.name] = await p.healthCheck({ live: false });
  }
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()}`,
    memory: {
      rssMb: round1(process.memoryUsage().rss / 1024 / 1024),
      freeSystemMb: round1(os.freemem() / 1024 / 1024),
      totalSystemMb: round1(os.totalmem() / 1024 / 1024),
    },
    providers,
    mongo: await mongo.healthCheck(),
    allProvidersConfigured: Object.values(providers).every((p) => p.configured),
    settings: settings.loadSettings(),
    database: await db.getDatabaseInfo(),
  });
}));

// Live health check: actually pings every configured provider with a
// minimal request and measures real latency — kept as an explicit POST
// action (not run automatically) so it doesn't silently burn API quota on
// every dashboard/health page load.
app.post("/api/system/healthcheck", auth.requireAdmin, async (req, res) => {
  const results = {};
  await Promise.all(
    getProviders().map(async (p) => {
      results[p.name] = await p.healthCheck({ live: true });
    })
  );
  res.json({ ok: true, checkedAt: new Date().toISOString(), results });
});

app.get("/api/system/metrics", auth.requireAdmin, (req, res) => {
  res.json(metrics.getMetricsSummary());
});

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function startServer() {
  await mongo.connect();
  await settings.init();
  await metrics.init();
  await db.init();
  await auth.init();
  await rateLimiter.init();

  await auth.bootstrapAdminIfNeeded();

  const didBackfill = await db.backfillPickGrades();
  if (didBackfill) console.log("Backfilled per-pick grades for previously-graded predictions.");
  await db.recomputeAllWeights();

  app.listen(PORT, () => {
    console.log(`Full-Time backend running at http://localhost:${PORT}`);
    const aiProviders = getAIProviders();
    aiProviders.forEach((p) => {
      if (!p.isConfigured()) console.warn(`\u26a0\ufe0f  ${p.name} is not configured — see .env.example for the required key(s).`);
    });
    if (!process.env.EXA_API_KEY) console.warn("\u26a0\ufe0f  EXA_API_KEY is not set — retrieval will fail without it.");
    if (!process.env.GEMINI_API_KEY) console.warn("\u26a0\ufe0f  GEMINI_API_KEY is not set — the retrieval-extraction step depends on it, so analysis will fail without it.");
  });
}

startServer().catch((err) => {
  console.error("Failed to start Full-Time:", err.message);
  process.exit(1);
});
