# Full-Time — AI Football Prediction Platform (V3)

A premium, self-improving football prediction platform. Four independent
prediction voices — **Cohere, Gemini, Exa**, and a deterministic
**Poisson + Dixon-Coles** statistical model — are combined by a transparent,
mathematical Consensus Engine with **market-specific weight learning**: it
learns which models to trust more for *which markets*, based on your own
graded results.

**Want this running on the internet instead of just your own machine?**
See `DEPLOYMENT.md` for a full free-hosting walkthrough (MongoDB Atlas +
Render).

---

## Quick Start

**Before either of the below**: this app now stores everything in
MongoDB rather than local files — see `DEPLOYMENT.md` Step 1 (or the
comments in `.env.example`) for a 5-minute free MongoDB Atlas setup. You
need a `MONGODB_URI` before the server will start at all, even for local
use — this isn't just for the hosted-online case.

### Windows (no terminal typing needed)
1. Unzip this folder anywhere.
2. **Double-click `start.bat`.**
3. First run only: it installs dependencies, then opens Notepad with your
   `.env` file — set `MONGODB_URI` and fill in your API keys, save
   (Ctrl+S), close Notepad, press any key.
4. The server starts. Open **http://localhost:3000** in your browser.

Every run after that, just double-click `start.bat` again. To edit your
`.env` anytime, double-click `edit-env.bat`.

### macOS / Linux / PowerShell
```powershell
npm install
copy .env.example .env      # PowerShell: Copy-Item .env.example .env
# set MONGODB_URI and fill in your API keys in .env
npm start
```
Then open **http://localhost:3000**.

---

## API keys

Copy `.env.example` to `.env` and fill in:

| Key | Required | Notes |
|---|---|---|
| `EXA_API_KEY` | Yes | Retrieval provider. Paid API, free trial credits on signup. |
| `GEMINI_API_KEY` | Yes | No-credit-card free tier. Performs the retrieval-extraction step (structuring raw search text) AND runs as a prediction voice — the extraction step depends on it, so it's required. `GEMINI_MODEL` defaults to `gemini-2.0-flash` (Google retires versions on a rolling basis — check ai.google.dev/gemini-api/docs/models if this ever 404s). |
| `COHERE_API_KEY` | Optional* | Free trial key. |

\* The app runs fine with or without the one optional AI provider
configured — every missing/failed model is simply excluded from that
analysis, and Poisson always participates as a zero-cost extra voice as long
as retrieval succeeds. `EXA_API_KEY` and `GEMINI_API_KEY` are the only two
strictly required, since Gemini performs the retrieval extraction step that
everything downstream depends on.

Check the **System Health** page for a live, pingable view of every
provider's configuration and (on request) real latency.

### Troubleshooting: a provider shows "failed" during analysis

The Live Progress ticker on Match Analysis shows the actual error message
under any step that fails (not just a red icon), and the same detail is
stored in every prediction's `retrievalMeta.modelFailures`. The single most
common cause is a **provider-side model rename or deprecation** — free AI
APIs change their available model IDs without warning, independent of
anything in this app. If the error mentions `404`, `model not found`, `no
longer available`, or `unavailable for free`:
1. Check the error text shown in the ticker or in History for the exact
   message.
2. Look up the provider's current model list (Gemini:
   ai.google.dev/gemini-api/docs/models; Cohere: docs.cohere.com).
3. Update `GEMINI_MODEL` / `COHERE_MODEL` / etc. in your
   `.env` to a currently-available model ID and restart the server.

The app degrades gracefully either way — a failed provider is excluded from
that run rather than the whole analysis failing, as long as at least one
model (or Poisson) succeeds.

---

## Latest changes

### Four voices now, including a genuinely internet-grounded one
**Exa** — already the app's retrieval engine — also doubles as one of the
four prediction voices (`lib/providers/exaVoiceProvider.js`). It's deliberately
different in kind from the other two AI voices: Cohere
and Gemini both reason from the exact same structured dataset with no web
access of their own (which is what makes comparing their accuracy fair).
Exa instead does its OWN live web search for the specific fixture and forms
an opinion from whatever it finds right now — real-time news, injury
updates, expert previews — without giving the other two inconsistent,
uncontrolled internet access that would break that fairness. No new API key
needed; it reuses `EXA_API_KEY`.

### Cohere fixed — now on the v2 Chat API
`command-a-plus-05-2026` (or any `command-a` family model) requires
Cohere's v2 endpoint, not the legacy v1 `preamble`/`message` shape this app
used before. `lib/providers/cohereProvider.js` now calls `v2/chat` with a
proper `messages` array and forced `response_format: {type:"json_object"}`
— more reliable JSON than prompt-only instructions, same as Gemini already
had. Default model bumped to `command-a-03-2025`; set `COHERE_MODEL` to
whatever release your account has access to.

### Retrieval now collects corners, cards, shots on target, half splits, and top scorers
The extraction schema Gemini fills in (`EXTRACTION_SYSTEM` in
`lib/retrieval/exaRetriever.js`) grew nine new fields per team: average
corners for/against, average cards, average shots on target, first-half
goal share, and a top-scorer name+tally — plus a third concurrent search
pass (club matches only) specifically asking for this data, since the
original two passes never did. See the "What Gemini collects" and "What
the prediction models see" sections below for the complete field list.

### Seven new markets — computed with real math, not asked of the AI models
Corners, cards, shots on target, half-time result, win-both-halves,
win-either-half, winning margin, and handicap are ALL new
(`lib/auxiliaryMarkets.js`). Deliberate design choice: these are NOT part of
the JSON schema the four/five AI voices fill in. A language model has real
football-narrative grounding to reason about goals (attack vs. defence,
form, motivation) but essentially none for guessing a corner or card count
— so instead, every one of these is computed the same rigorous,
deterministic Poisson-style way the core goal model already works, directly
from the stats Gemini collects. Corners/Cards/Shots-on-Target get a
dynamically chosen bookmaker-style line (e.g. "Corners Over/Under 9.5", not
a fixed generic number) via `roundToHalfLine()` in `lib/utils.js`. Winning
Margin and Handicap are fully auto-graded from a final scoreline alone;
Corners/Cards/Shots/Half-Time/Halves are displayed but not auto-graded (see
the honesty note in "What's not included" below).

### Best Pick now draws from ALL of these markets — always a real line
The Best Pick/Safe Picks eligibility filter (`NORMAL_BETTING_MARKETS` /
`ELIGIBLE_AUX_FAMILIES` in `lib/consensusEngine.js`) was expanded to include
every new market family. If corners genuinely is the standout, highest-
agreement pick for a fixture, it can now BE the Best Pick — always shown
with its actual computed line, never a placeholder number.

### What's not included, and why
- **Individual goalscorer/assist markets** were requested but aren't
  implemented as a probability market: there's no reliable way to grade
  "will Saka score" against just a final scoreline (you'd need to separately
  record who actually scored), and player-level form data (minutes, goals
  per 90, etc.) isn't part of what this app's retrieval collects. Each
  side's current top scorer IS now collected and shown on the results page,
  clearly labeled "informational only."
- **Corners, cards, shots on target, half-time result, and the two halves
  markets are not auto-graded** for the same reason — grading them
  accurately needs the actual corner count / card count / half-time score,
  not just the final result. They're fully predicted and displayed; History
  just won't show a ✓/✗ for them.

## What Gemini collects (retrieval extraction)

For every fixture, per team: league position, points, games played,
win/draw/loss record, goals scored/conceded (overall and home/away splits),
last-5 and last-10 results, clean-sheet %, BTTS %, Over 0.5/1.5/2.5/3.5 %,
average corners for/against, average cards, average shots on target,
percentage of goals scored in the first half, and top scorer (name +
goals). Plus, for the fixture as a whole: head-to-head summary and average
goals/BTTS%, injuries for each side, expected lineup notes, motivation
context (title race, relegation battle, etc.), days of rest for each side,
and match/competition metadata. Every field is nullable — Gemini is
instructed to use `null` rather than guess when the source text doesn't
explicitly support a value, and everything is range/consistency-checked
afterward regardless (`lib/retrieval/dataQuality.js`).

## What the prediction models see (and why it's identical)

Cohere and Gemini (as a prediction voice, separate from
its extraction call) both receive the exact same `analysisInput` string:
the fixture line, the full raw retrieval JSON above, and every engineered
feature (`lib/featureEngineering.js` — recency-weighted form, form trend,
attack/defence ratings, home advantage index, momentum, goal volatility,
injury/rest differentials, expected corners/cards/shots, first-half goal
share, and the Poisson expected-goals baseline). Identical input is
deliberate: it's what makes comparing these two models' accuracy (plus
Poisson, which derives its own prediction from the same underlying data),
and learning a separate weight per model per market, a fair comparison
rather than one model just having better data than another. Exa is the one
exception — it gets the raw fixture only and does its own live search,
by design (see above).

- **Gemini handles retrieval extraction** (turning raw Exa search text
  into structured data) instead of Mistral — a change made back when
  Mistral was still a prediction voice (see the provider-history section
  below for its eventual removal) — while still also running as one
  of the four prediction voices. This is why `GEMINI_API_KEY` is the second
  required key alongside `EXA_API_KEY`.
- **Best Pick and Safe Picks now only draw from real bookmaker lines** —
  Match Winner, Double Chance, Both Teams To Score, and Over/Under 1.5+.
  Over/Under 0.5 Goals is still computed and shown (most matches produce at
  least one goal, so it's a near-certain, low-value market few sportsbooks
  even list) but can never become the headline recommendation.
- **Double Chance is now a real, market-weighted consensus pick** (1X / X2
  / 12), not just an informational read-out from one model — it's graded,
  learns its own weight per model like every other market, and can appear
  in Safe Picks or as the Best Pick.
- **A Best Pick now requires genuine cross-model agreement**, not just a
  high raw probability — a pick where the models spread widely is skipped
  in favor of the next-best qualifying candidate, or reported as
  unavailable rather than recommending something the models don't actually
  agree on.
- **Confidence now also reflects retrieval source reliability**, not just
  data completeness and model agreement — complete-but-low-reliability-
  source data no longer inspires the same confidence as complete data from
  known football-stats sources.
- The pick-tiering formula now weights cross-model agreement slightly more
  (35%, was 30%) relative to raw probability.

## What's new in V3

This is a deep architectural pass on top of the V2 rebuild.

### Provider architecture — models are now fully modular
Every prediction model (AI or statistical) implements the exact same
interface (`lib/providers/BaseProvider.js`): `predict()`, `healthCheck()`,
`validateResponse()`, `getModelInformation()`, plus `isConfigured()` and
`complete()`. Nothing in the pipeline (`lib/agents.js`), consensus engine,
database, or dashboard ever hardcodes "if this is Cohere" — they all
iterate `lib/providers/registry.js`'s provider list generically. Adding a
future model is one new file plus one line in the registry. Poisson is
wrapped in the same interface as the AI providers
(`lib/providers/poissonProvider.js`), unifying the whole model list rather
than special-casing the statistical model.

### Provider history: Cerebras → Groq → OpenRouter → Nvidia NIM → removed
This slot has been through several iterations as free-tier providers
changed underneath it, ending in a deliberate consolidation rather than
another forced swap — documented here because it's a useful case study in
why the provider architecture matters: Cerebras → Groq (blocked in the
deployment environment) → OpenRouter (its specific free model got delisted
mid-use, a 404 caught and surfaced by the error-detail reporting below) →
Nvidia NIM (free, no-credit-card access to 100+ hosted open models,
sharing `lib/chatClientBase.js` with the app's other OpenAI-compatible
provider at the time) → **removed entirely**, by
choice, to consolidate the AI voices on Cohere, Gemini, and Exa.
Every swap along the way — and the final removal — was a one-file change
plus a registry-line edit, with zero changes needed anywhere else in the
app.

### Mistral removed — free-tier quota exhausted
Mistral was a separate provider slot from the one above (it was never part
of the Cerebras/Groq/OpenRouter/Nvidia chain) and had its own, unrelated
ending: its free "Experiment" tier ran out of request/token quota, with
`metrics.json` showing a majority of its calls failing on
`429: Rate limit exceeded` well before removal. Rather than chase an
increasingly-exhausted free allowance, it was removed entirely, the same
one-file-plus-registry-line way every other provider change in this project
has gone (`lib/providers/mistralProvider.js` deleted, `registry.js`
updated). Gemini had already taken over the retrieval-extraction step from
Mistral some time before this (see below), so removing it entirely only
affected its role as a prediction voice.
- **Gemini** (`lib/providers/geminiProvider.js`) replaces DeepSeek — uses
  Gemini's native `responseMimeType: "application/json"` structured-output
  mode rather than prompt-only formatting instructions. Defaults to
  `gemini-2.0-flash` rather than the newer `gemini-2.5-flash`, since Google
  has already restricted 2.5 to existing users ahead of an October 2026
  shutdown — see the troubleshooting note above.

### Retrieval: multi-stage validation, source scoring, anti-hallucination
- **`lib/retrieval/dataQuality.js`** — every extracted field passes
  deterministic range/plausibility checks and is **nulled — never guessed at
  a "corrected" value** — if implausible. A cross-field consistency check
  catches e.g. reported points that don't match wins/draws.
- **Source reliability scoring** per citation domain, plus deduplication.
- **Weighted completeness scoring** — fields that most directly feed the
  Poisson baseline and consensus math count more than peripheral context.
- **Stronger extraction prompt** with explicit anti-hallucination rules and
  conflicting-value handling, layered with the deterministic checks above.
- **Schema validation on every AI response** (`lib/providers/schema.js`) —
  clamps, coerces, drops malformed scorelines, rejects structurally unusable
  responses outright.

### Prediction prompts rewritten for calibration over decisiveness
`ANALYSIS_SYSTEM` now explicitly instructs every model to use *every*
engineered feature it's given, and adds a dedicated calibration directive:
confidence should honestly track how much the evidence supports one outcome,
reserving high confidence for cases where multiple signals agree, rather
than manufacturing false decisiveness on a genuinely close match.

### Consensus: market-specific weight learning
The single biggest ensemble change. Previously every model had ONE learned
weight applied to every market. Now each model has an **overall** weight AND
a **per-market** weight (Match Winner, BTTS, each Over/Under threshold) — a
model great at BTTS but mediocre at Over/Under 3.5 is weighted accordingly,
market by market. A market-specific weight is only trusted once a model has
at least 5 graded instances for that market; below that it falls back to the
model's overall weight.

### Self-learning improvements
- **Weight history** — every recomputation appends a timestamped snapshot,
  rendered as a "Weight Evolution Over Time" chart on the Dashboard.
- **Trend detection** per model (improving/declining/stable).
- **Weakest/strongest market** surfaced per model (Model Performance page).
- **Accuracy by competition** on the Statistics page.
- Calibration measured via **Brier score**, not a single confidence-bucket
  accuracy figure.

### Diagnostics — "why" this prediction, not just what
After every analysis, `lib/diagnostics.js` builds a deterministic
feature-driven explanation, and the Consensus Engine reports which model
diverged most from the group. This is explicitly **not** true ML
feature-importance (this is an LLM + statistical ensemble, not a
differentiable model) — a transparent, honestly-labeled approximation shown
as "Why This Prediction" on the results page.

### Performance monitoring
`lib/metrics.js` tracks per-provider call/success/failure counts, average
latency, and JSON-parse failures, plus retrieval and pipeline health.
Surfaced on **System Health** alongside a live health-check button that
actually pings every provider (on request only — never automatically, so it
never silently burns API quota).

### Smart input handling
- **`lib/teamDirectory.js`** — a local seed directory of well-known clubs,
  national teams, aliases ("Man Utd" → "Manchester United"), and
  competitions, with typo-tolerant fuzzy search, backing new
  `/api/teams/search` and `/api/competitions/search` autocomplete endpoints.
  Not a live, exhaustive football database — a practical subset plus this
  user's own history.
- Every fixture input is centrally normalized server-side (trimmed,
  capitalized, alias-resolved) regardless of entry point.
- Date auto-fills to today, with manual overrides remembered via
  `sessionStorage`.

### Fixed bugs from the V2 review
- Over/Under 0.5 Goals is now a full consensus pick (was silently dropped).
- Fixture cache key now includes competition (prevents collisions).
- Poisson gained the Dixon-Coles low-score correction plus a full Correct
  Score market.

### Reliability & performance
- All AI provider calls run **concurrently**, not sequentially.
- Per-call **timeouts**, not just retries.
- **Exponential backoff with jitter** on retries.
- `extractJSON` recovers from trailing-comma formatting slips.
- In-memory database cache instead of re-reading the file every request.

---

## Full architecture

```
User Input (normalized, typo-tolerant autocomplete)
  -> Cache check (MongoDB "predictions" collection, keyed by home|away|date|league)
  -> Exa retrieval (2 concurrent passes, club/international-aware)
  -> Gemini extraction -> structured JSON (never invents data)
  -> Multi-stage validation: range/consistency repair, source-reliability
     scoring, citation dedup, weighted completeness scoring, retry/reject
  -> Feature engineering (pure math: form, form trend, ratings, momentum,
     volatility, injury/rest differentials, Poisson expected goals)
  -> Cohere + Gemini + Exa, run CONCURRENTLY, schema-validated
     + Poisson + Dixon-Coles (zero-cost 4th voice)
  -> Consensus Engine (deterministic, MARKET-SPECIFIC weighted, calibration-
     aware, no AI call)
  -> Diagnostics (feature-driven "why", model divergence)
  -> Stored permanently
  -> History (graded per-pick, per-market) -> weight learning replay
     (recency-decayed, overall + per-market) -> Dashboard / Statistics /
     Model Performance / weight-evolution history
```

## Project structure

```
server.js                    Express app, all routes
lib/
  agents.js                  Pipeline orchestrator (runPipeline)
  database.js                MongoDB-backed persistence (in-memory cache,
                              loaded once at startup — reads stay fully
                              synchronous), stats, market-specific weight
                              learning
  auth.js                    Accounts, password hashing, sessions, cookies
  rateLimiter.js              Per-user daily analysis quotas
  parlayBuilder.js            Auto/manual parlay combination
  db/mongo.js                  Shared MongoDB connection
  consensusEngine.js         Deterministic market-specific weighting & picks
  diagnostics.js              Feature-driven "why" explanation notes
  metrics.js                 Performance monitoring (calls/latency/failures)
  grading.js                 Shared scoreline parsing & market correctness
  featureEngineering.js      Pure-math feature derivation
  poissonModel.js            Poisson + Dixon-Coles statistical model
  teamDirectory.js           Seed teams/aliases/competitions + fuzzy search
  settings.js                Configurable thresholds
  chatClientBase.js          Shared OpenAI-compatible API caller (unused
                              since Mistral's removal — kept for the next
                              OpenAI-compatible provider this project adds)
  providers/
    BaseProvider.js          The interface every model implements
    registry.js               Single source of truth for every model
    schema.js                 Shared prediction-response validator
    cohereProvider.js / geminiProvider.js /
    exaVoiceProvider.js / poissonProvider.js
  logger.js, utils.js
  retrieval/
    index.js                 Swap-point (currently -> exaRetriever)
    exaRetriever.js           Multi-pass retrieval + extraction + retry loop
    dataQuality.js             Range/consistency repair, source scoring
    exaClient.js, matchType.js, validate.js
public/
  assets/style.css            Shared design system
  assets/app.js                 Shared sidebar shell + chart/dial/toast helpers
  dashboard.html, analyze.html, parlay.html, live.html, history.html,
  statistics.html, models.html, settings.html, database.html, backup.html,
  health.html, users.html, about.html, login.html (standalone, no sidebar),
  index.html (redirects to dashboard)
```

## Data storage

Everything — predictions, accounts, settings, learned model weights, weight
history, cache stats — lives in MongoDB, not on local disk. This was a
deliberate choice for hosting on a platform with an ephemeral filesystem
(e.g. Render's free tier wipes local files on every restart): as long as
`MONGODB_URI` points at a real cluster, data survives restarts, redeploys,
and host migrations. See `.env.example` for how to get a free-forever
MongoDB Atlas cluster (no credit card, 512MB, genuinely permanent — not a
time-limited trial).

Collections: `predictions`, `users`, `weightHistory`, and `meta` (a small
collection holding the singleton `settings`, `modelWeights`, `cacheStats`,
and `usage` documents). `lib/database.js`, `lib/auth.js`, `lib/metrics.js`,
`lib/rateLimiter.js`, and `lib/settings.js` each load their piece into an
in-memory cache once at startup — every read throughout the app stays
fully synchronous (reading straight from that cache), and only genuine
writes touch MongoDB. This is a single-instance design: if this were ever
scaled to multiple server instances behind a load balancer, each instance's
cache could drift out of sync with the others. For a small self-hosted app
on one instance (which is what this is built for), that's a non-issue —
the same tradeoff this app already makes for in-memory sessions.

## Cost note

A fresh (uncached) analysis makes up to **6 API calls**: 2 Exa retrieval
passes + 1 Gemini extraction call + 3 concurrent prediction-voice calls
(Cohere and Gemini again — two of the four independent
prediction voices, separate from Gemini's extraction call — plus Exa's own
live-search prediction call). The
permanent cache means this only happens once per unique fixture (keyed by
competition too).
