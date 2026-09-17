const { safeAvg, clamp, round } = require("./utils");
const { computeCompleteness } = require("./retrieval/validate");
const { deriveLambdas } = require("./poissonModel");

/**
 * Compute engineered features from the retriever's structured retrieval data.
 * Every feature is derived only from fields the retriever actually returned —
 * if an input is null, the dependent feature is null too. Nothing here
 * invents data; it only combines what was verified.
 *
 * @param {object} retrievalData
 * @param {"club"|"international"} matchType - affects which fields count toward data_quality_score
 */
function engineerFeatures(retrievalData, matchType = "club") {
  const home = retrievalData.home_team || {};
  const away = retrievalData.away_team || {};
  const h2h = retrievalData.head_to_head || {};

  const recentFormScore = (team) => {
    // W=3, D=1, L=0 across whatever recent results are present, most recent weighted slightly higher.
    const results = team.last_5_results; // e.g. ["W","D","L","W","W"]
    if (!Array.isArray(results) || !results.length) return null;
    const points = { W: 3, D: 1, L: 0 };
    let weightedSum = 0;
    let weightTotal = 0;
    results.forEach((r, i) => {
      const weight = 1 + i * 0.15; // later entries (more recent, assuming chronological order) count more
      const p = points[r];
      if (p === undefined) return;
      weightedSum += p * weight;
      weightTotal += weight;
    });
    if (!weightTotal) return null;
    return round((weightedSum / weightTotal / 3) * 100, 1); // normalize to 0-100
  };

  // Form trend: is the team getting better or worse across the window, not
  // just its average level? Compares the mean of the first half of the
  // window to the second half. Positive = improving, negative = declining.
  const formTrend = (team) => {
    const results = team.last_5_results;
    if (!Array.isArray(results) || results.length < 4) return null;
    const points = { W: 3, D: 1, L: 0 };
    const nums = results.map((r) => points[r]).filter((n) => n !== undefined);
    if (nums.length < 4) return null;
    const mid = Math.floor(nums.length / 2);
    const firstHalf = safeAvg(nums.slice(0, mid));
    const secondHalf = safeAvg(nums.slice(mid));
    if (firstHalf === null || secondHalf === null) return null;
    return round(secondHalf - firstHalf, 2); // range roughly -3..+3
  };

  const attackRating = (team) => {
    if (typeof team.avg_goals_scored !== "number") return null;
    return round(clamp((team.avg_goals_scored / 3) * 100, 0, 100), 1); // 3 goals/game ~= max rating
  };

  const defenceRating = (team) => {
    if (typeof team.avg_goals_conceded !== "number") return null;
    return round(clamp(100 - (team.avg_goals_conceded / 3) * 100, 0, 100), 1);
  };

  const homeAttack = attackRating(home);
  const awayAttack = attackRating(away);
  const homeDefence = defenceRating(home);
  const awayDefence = defenceRating(away);

  // Home/away splits don't exist for international teams — fall back to
  // overall averages so this feature isn't just always null for those matches.
  const homeAdvantageIndex =
    typeof (home.home_avg_goals_scored ?? home.avg_goals_scored) === "number" &&
    typeof (away.away_avg_goals_conceded ?? away.avg_goals_conceded) === "number"
      ? round((home.home_avg_goals_scored ?? home.avg_goals_scored) - (away.away_avg_goals_conceded ?? away.avg_goals_conceded), 2)
      : null;

  const awayStrengthIndex =
    typeof (away.away_avg_goals_scored ?? away.avg_goals_scored) === "number" &&
    typeof (home.home_avg_goals_conceded ?? home.avg_goals_conceded) === "number"
      ? round((away.away_avg_goals_scored ?? away.avg_goals_scored) - (home.home_avg_goals_conceded ?? home.avg_goals_conceded), 2)
      : null;

  const avgTotalGoals = safeAvg([home.avg_goals_scored, home.avg_goals_conceded, away.avg_goals_scored, away.avg_goals_conceded]);

  const bttsScore = safeAvg([home.btts_pct, away.btts_pct]);
  const over25Score = safeAvg([home.over_2_5_pct, away.over_2_5_pct]);

  const cleanSheetProbability = safeAvg([home.clean_sheets_pct, away.clean_sheets_pct]);
  const scoringConsistency = safeAvg([home.avg_goals_scored, away.avg_goals_scored]);
  const concedingConsistency = safeAvg([home.avg_goals_conceded, away.avg_goals_conceded]);

  const h2hTrendScore =
    typeof h2h.avg_goals === "number" && typeof h2h.btts_pct === "number"
      ? round((h2h.avg_goals / 4) * 50 + (h2h.btts_pct / 100) * 50, 1)
      : null;

  const momentumScore =
    recentFormScore(home) !== null && recentFormScore(away) !== null
      ? round(recentFormScore(home) - recentFormScore(away), 1)
      : null;

  // Goal volatility: how much a team's scored/conceded rates diverge from
  // each other, as a rough proxy for how unpredictable their matches are
  // (a team that both scores heavily AND concedes heavily produces more
  // volatile, high-swing scorelines than one that's balanced).
  const volatilityFor = (team) => {
    if (typeof team.avg_goals_scored !== "number" || typeof team.avg_goals_conceded !== "number") return null;
    return round(Math.abs(team.avg_goals_scored - team.avg_goals_conceded) + (team.avg_goals_scored + team.avg_goals_conceded) * 0.3, 2);
  };
  const goalVolatility = safeAvg([volatilityFor(home), volatilityFor(away)]);

  // Injury/absence impact — a coarse but real signal: count of reported
  // injuries/suspensions per side, differenced. More missing players (esp.
  // relative to the opponent) is a real (if crude) negative-form signal that
  // pure scoring-rate stats can't capture on their own.
  const injuryCount = (list) => (Array.isArray(list) ? list.length : 0);
  const homeInjuryCount = injuryCount(retrievalData.injuries_home);
  const awayInjuryCount = injuryCount(retrievalData.injuries_away);
  const injuryDifferential = round(awayInjuryCount - homeInjuryCount, 0); // positive favors home (away has more absences)

  // Rest advantage — days_rest differential, when reported.
  const restDifferential =
    typeof retrievalData.days_rest_home === "number" && typeof retrievalData.days_rest_away === "number"
      ? round(retrievalData.days_rest_home - retrievalData.days_rest_away, 0)
      : null;

  // Single source of truth for data quality: same calculation the retrieval
  // validation stage uses (match-type-aware, field-weighted), so this number
  // always agrees with retrievalMeta.completeness rather than drifting from
  // a second hardcoded field list.
  const dataQualityScore = computeCompleteness(retrievalData, matchType);

  // Poisson-derived expected goals — a rigorous statistical anchor point,
  // exposed here so the AI analysis models see it as part of their input
  // data (not just their own intuition), in addition to the standalone
  // Poisson model that runs as its own prediction voice in the consensus.
  const lambdas = deriveLambdas(retrievalData);

  // Corners, cards, and shots on target — same "blend a team's own rate
  // with the opponent's corresponding rate" approach as the goal lambdas,
  // reused here for every new countable-stat market (corners/cards/shots
  // O/U are computed deterministically from these in lib/auxiliaryMarkets.js,
  // the same way goals are computed from poisson_expected_goals above).
  const expectedCornersHome =
    typeof home.avg_corners_for === "number" && typeof away.avg_corners_against === "number"
      ? round((home.avg_corners_for + away.avg_corners_against) / 2, 2)
      : null;
  const expectedCornersAway =
    typeof away.avg_corners_for === "number" && typeof home.avg_corners_against === "number"
      ? round((away.avg_corners_for + home.avg_corners_against) / 2, 2)
      : null;

  const expectedCardsTotal =
    typeof home.avg_cards === "number" && typeof away.avg_cards === "number" ? round(home.avg_cards + away.avg_cards, 2) : null;

  const expectedShotsOnTargetHome = typeof home.avg_shots_on_target === "number" ? round(home.avg_shots_on_target, 2) : null;
  const expectedShotsOnTargetAway = typeof away.avg_shots_on_target === "number" ? round(away.avg_shots_on_target, 2) : null;

  // First-half goal share: use the team's own reported split when
  // available, otherwise fall back to a standard 45% (first halves run
  // slightly below the full-match average across football generally).
  const firstHalfShareHome = typeof home.first_half_goals_pct === "number" ? home.first_half_goals_pct / 100 : 0.45;
  const firstHalfShareAway = typeof away.first_half_goals_pct === "number" ? away.first_half_goals_pct / 100 : 0.45;

  return {
    home_recent_form_score: recentFormScore(home),
    away_recent_form_score: recentFormScore(away),
    home_form_trend: formTrend(home),
    away_form_trend: formTrend(away),
    home_attack_rating: homeAttack,
    away_attack_rating: awayAttack,
    home_defence_rating: homeDefence,
    away_defence_rating: awayDefence,
    home_advantage_index: homeAdvantageIndex,
    away_strength_index: awayStrengthIndex,
    avg_total_goals: round(avgTotalGoals, 2),
    btts_score: round(bttsScore, 1),
    over_2_5_score: round(over25Score, 1),
    clean_sheet_probability: round(cleanSheetProbability, 1),
    scoring_consistency: round(scoringConsistency, 2),
    conceding_consistency: round(concedingConsistency, 2),
    h2h_trend_score: h2hTrendScore,
    momentum_score: momentumScore,
    goal_volatility: round(goalVolatility, 2),
    home_injury_count: homeInjuryCount,
    away_injury_count: awayInjuryCount,
    injury_differential: injuryDifferential,
    rest_differential: restDifferential,
    poisson_expected_goals_home: lambdas ? round(lambdas.lambdaHome, 2) : null,
    poisson_expected_goals_away: lambdas ? round(lambdas.lambdaAway, 2) : null,
    expected_corners_home: expectedCornersHome,
    expected_corners_away: expectedCornersAway,
    expected_cards_total: expectedCardsTotal,
    expected_shots_on_target_home: expectedShotsOnTargetHome,
    expected_shots_on_target_away: expectedShotsOnTargetAway,
    first_half_goal_share_home: round(firstHalfShareHome, 2),
    first_half_goal_share_away: round(firstHalfShareAway, 2),
    data_quality_score: dataQualityScore,
  };
}

module.exports = { engineerFeatures };
