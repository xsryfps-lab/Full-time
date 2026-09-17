const { exaAnswer } = require("./exaClient");
const gemini = require("../providers/geminiProvider");
const { withRetry } = require("../utils");
const { validateRetrieval } = require("./validate");
const { sanityCheckAndRepair, avgSourceReliability } = require("./dataQuality");
const logger = require("../logger");
const metrics = require("../metrics");
const { detectMatchType } = require("./matchType");
const { loadSettings } = require("../settings");

// One schema covers both club and international football — every field is
// nullable, and the instructions tell the model explicitly which fields
// don't apply to international matches (no league table) so it returns null
// there instead of straining to invent a league position that doesn't exist.
//
// Anti-hallucination is layered: this prompt is the first line of defense,
// but nothing here is trusted blindly — every field also passes through
// deterministic range/consistency checks in dataQuality.js afterward
// (defense in depth, since a prompt instruction alone cannot guarantee
// compliance).
const EXTRACTION_SYSTEM = `You extract structured football data from search-grounded answer text. You do NOT predict outcomes and you do NOT guess — only report what the source text actually, explicitly states.

STRICT RULES:
- For ANY field not explicitly and unambiguously supported by the source text, use JSON null. Never infer, estimate, average, or "reasonably assume" a plausible number. A missing field is far better than a wrong one.
- If the source text gives conflicting values for the same fact (e.g. two different point totals), use null rather than picking one arbitrarily.
- Realistic ranges as a sanity guide (do not force a value into range — if the source says something outside these, still report it faithfully, but double-check you read it correctly): goals per game 0-6, clean-sheet/BTTS percentages 0-100, league position 1-24 for most top-flight leagues, FIFA ranking 1-210, corners per game 2-9, cards (yellow+red combined) per game 0-6, shots on target per game 1-10.
- Use plain text in string values — no double or curly quotes for emphasis, that breaks JSON parsing.
- Output ONE JSON object only, no prose outside it, no markdown fences.

IMPORTANT: if this is an INTERNATIONAL match (World Cup, Euros, Nations League, qualifiers, friendlies, continental cups — a national team fixture, not a club league match), the following concepts genuinely do not exist and MUST be null: league_position, points, games_played (in the domestic-league sense), home_avg_goals_scored, home_avg_goals_conceded, away_avg_goals_scored, away_avg_goals_conceded (no home/away league splits for national teams). Instead, populate fifa_ranking for both teams, and populate avg_goals_scored / avg_goals_conceded / last_5_results / last_10_results from the team's recent overall matches (tournament + qualifiers + friendlies combined), not a league record. Corners, cards, and shots-on-target data is often not published for international teams at all — use null rather than guessing.

{
 "match_metadata": {"competition":"string or null","date":"string or null","venue":"string or null","match_type":"club"|"international"},
 "home_team": {
   "name":"string",
   "fifa_ranking": number|null,
   "league_position": number|null, "points": number|null, "games_played": number|null,
   "wins": number|null, "draws": number|null, "losses": number|null,
   "avg_goals_scored": number|null, "avg_goals_conceded": number|null,
   "home_avg_goals_scored": number|null, "home_avg_goals_conceded": number|null,
   "last_5_results": ["W"|"D"|"L", ...] or null,
   "last_10_results": ["W"|"D"|"L", ...] or null,
   "clean_sheets_pct": number|null, "btts_pct": number|null,
   "over_0_5_pct": number|null, "over_1_5_pct": number|null, "over_2_5_pct": number|null, "over_3_5_pct": number|null,
   "avg_corners_for": number|null, "avg_corners_against": number|null,
   "avg_cards": number|null,
   "avg_shots_on_target": number|null,
   "first_half_goals_pct": number|null
 },
 "away_team": { "same shape as home_team but with away_avg_goals_scored / away_avg_goals_conceded instead of home_ variants": true },
 "head_to_head": {"summary":"string or null","last_5_summary":"string or null","avg_goals": number|null,"btts_pct": number|null,"home_record":"string or null","away_record":"string or null"},
 "injuries_home": ["short strings"] or null,
 "injuries_away": ["short strings"] or null,
 "expected_lineups_note": "string or null",
 "motivation_context": "string or null (e.g. title race, relegation battle for club; must-win group game, knockout stakes for international)",
 "days_rest_home": number|null,
 "days_rest_away": number|null,
 "home_top_scorer": {"name": "string or null", "goals": number|null},
 "away_top_scorer": {"name": "string or null", "goals": number|null},
 "source_quality": "high"|"medium"|"low"
}`;

function buildQueries(fixture, attemptNumber, matchType) {
  const { home, away, league, date } = fixture;
  const broaden = attemptNumber > 1;

  if (matchType === "international") {
    const pass1 = broaden
      ? `${home} national football team and ${away} national football team: FIFA world ranking, recent match results, goals scored and conceded, squad form. Competition: ${league}.`
      : `What is the current FIFA world ranking for ${home} and ${away}? What are their recent match results (last 5 and last 10 matches across tournaments, qualifiers, and friendlies), average goals scored and conceded, clean sheet rate, and both-teams-to-score rate, ahead of their ${league} match on ${date}?`;
    const pass2 = broaden
      ? `${home} vs ${away} head to head history, squad injuries, expected lineups, manager tactics, and tournament context for ${league}.`
      : `What is the head-to-head record between ${home} and ${away} national teams (recent meetings, average goals, both-teams-to-score rate)? Also report any current injuries or suspensions affecting either squad, expected lineups, and the tournament context (e.g. must-win group match, knockout stage, dead rubber) for their ${league} match on ${date}.`;
    return [pass1, pass2];
  }

  const pass1 = broaden
    ? `${home} and ${away} football club statistics: league table position, points, games played, record, goals scored and conceded per game, home and away splits, recent match results, clean sheets, both teams to score rate, over/under goals trends. Competition: ${league}.`
    : `What is the current league position, points, games played, wins/draws/losses, average goals scored and conceded (including home/away splits), recent form (last 5 and last 10 results), clean sheet percentage, and both-teams-to-score percentage for ${home} and ${away} in ${league}, ahead of their match on ${date}?`;
  const pass2 = broaden
    ? `${home} vs ${away} head to head history, injuries, suspensions, lineups, rest days, and match context for ${league}.`
    : `What is the head-to-head record between ${home} and ${away} (recent meetings, average goals, both-teams-to-score rate)? Also report any current injuries, suspensions, expected lineups, days of rest, and motivational context (e.g. title race, relegation battle, dead rubber) for their ${league} match on ${date}?`;
  const pass3 = broaden
    ? `${home} and ${away} average corners per game, cards per game (yellow and red), shots on target per game, percentage of goals scored in the first half, and current top goalscorer for each club this season.`
    : `What is the average number of corners, cards (yellow and red combined), and shots on target per game for ${home} and ${away} this season? What percentage of each team's goals have come in the first half? Who is each club's current top goalscorer and how many goals do they have?`;
  return [pass1, pass2, pass3];
}

/**
 * Multi-pass retrieval + extraction + multi-stage validation, with retries
 * on low completeness. Automatically adapts what it asks for and what
 * counts as "complete" based on whether this is a club or international
 * fixture. Returns { data, completeness, attempts, log, matchType, repairs,
 * sourceReliability } or throws if completeness never clears the reject
 * threshold.
 */
async function retrieve(fixture) {
  const MAX_ATTEMPTS = loadSettings().maxRetrievalAttempts;
  const matchType = detectMatchType(fixture.league);
  const log = [logger.info("retrieval", `Detected match type: ${matchType}`, { league: fixture.league })];
  let lastData = null;
  let lastCompleteness = 0;
  let lastRepairs = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const queries = buildQueries(fixture, attempt, matchType);

    log.push(logger.info("retrieval", `Exa queries — attempt ${attempt}/${MAX_ATTEMPTS} (${queries.length} passes, concurrent)`, {}));
    const passResults = await Promise.all(
      queries.map((q, i) => withRetry(() => exaAnswer(q), { label: `Exa attempt ${attempt} pass ${i + 1}` }))
    );

    const combinedText = passResults.map((r, i) => `--- Source pass ${i + 1} ---\n${r.answer}`).join("\n\n");
    const allCitations = passResults.flatMap((r) => r.citations);

    const extractionInput = `Fixture: ${fixture.home} vs ${fixture.away} — ${fixture.league}, ${fixture.date}. This is a${
      matchType === "international" ? "n INTERNATIONAL" : " CLUB"
    } match.\n\nSearch-grounded source text:\n${combinedText}`;

    const rawExtracted = await withRetry(() => gemini.complete(EXTRACTION_SYSTEM, extractionInput, 1800), {
      label: `Extraction (attempt ${attempt})`,
    });
    rawExtracted._citations = allCitations;

    // Multi-stage validation: deterministic range/consistency repair runs
    // BEFORE completeness scoring, so completeness reflects the data that
    // will actually be used (a repaired-away hallucinated value should
    // count as missing, not present).
    const { data, repairs } = sanityCheckAndRepair(rawExtracted);
    if (repairs.length) {
      log.push(logger.warn("validation", `${repairs.length} field(s) repaired on attempt ${attempt}`, { repairs }));
    }
    lastRepairs = repairs;

    const { completeness, shouldRetry, shouldReject, rejectFloor } = validateRetrieval(data, attempt, MAX_ATTEMPTS, matchType);
    log.push(
      logger.info("validation", `Completeness ${completeness}% on attempt ${attempt}/${MAX_ATTEMPTS} (${matchType})`, {
        completeness,
        shouldRetry,
        shouldReject,
        sourceReliability: avgSourceReliability(data._citations),
      })
    );

    lastData = data;
    lastCompleteness = completeness;

    if (!shouldRetry) {
      if (shouldReject) {
        log.push(logger.warn("validation", `REJECTED — completeness ${completeness}% below ${rejectFloor}% floor after ${attempt} attempt(s)`, {}));
        metrics.recordRetrieval({ outcome: "rejection" });
        const err = new Error(
          `Insufficient verified data for this fixture (completeness ${completeness}% after ${attempt} attempt(s) — need at least ${rejectFloor}%). Try again later, double-check team name spelling, or try a more prominent fixture.`
        );
        err.log = log;
        err.completeness = completeness;
        err.code = "RETRIEVAL_REJECTED";
        throw err;
      }
      metrics.recordRetrieval({ outcome: "success" });
      return { data, completeness, attempts: attempt, log, matchType, repairs, sourceReliability: avgSourceReliability(data._citations) };
    }
    metrics.recordRetrieval({ outcome: "retry" });
  }

  return {
    data: lastData,
    completeness: lastCompleteness,
    attempts: MAX_ATTEMPTS,
    log,
    matchType,
    repairs: lastRepairs,
    sourceReliability: avgSourceReliability(lastData?._citations),
  };
}

module.exports = { retrieve, EXTRACTION_SYSTEM };
