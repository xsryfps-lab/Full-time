/**
 * Produces a human-readable "why" narrative from the engineered features —
 * NOT true SHAP-style feature-importance (that requires a differentiable
 * model; this is an LLM + statistical ensemble, so no such gradient exists).
 * This is a deliberately transparent, deterministic set of threshold rules
 * over the same engineered features every prediction model was given,
 * surfaced so a person can sanity-check *why* the system leaned the way it
 * did without pretending to more precision than the method actually has.
 */
function buildFeatureNotes(features, fixture) {
  if (!features) return [];
  const notes = [];
  const home = fixture?.home || "Home";
  const away = fixture?.away || "Away";

  if (typeof features.momentum_score === "number") {
    if (features.momentum_score > 20) notes.push(`${home} is in significantly better recent form than ${away} (momentum ${features.momentum_score > 0 ? "+" : ""}${features.momentum_score}).`);
    else if (features.momentum_score < -20) notes.push(`${away} is in significantly better recent form than ${home} (momentum ${features.momentum_score}).`);
  }

  if (typeof features.home_form_trend === "number" && features.home_form_trend > 1) notes.push(`${home}'s form is trending upward across their recent matches.`);
  if (typeof features.home_form_trend === "number" && features.home_form_trend < -1) notes.push(`${home}'s form is trending downward across their recent matches.`);
  if (typeof features.away_form_trend === "number" && features.away_form_trend > 1) notes.push(`${away}'s form is trending upward across their recent matches.`);
  if (typeof features.away_form_trend === "number" && features.away_form_trend < -1) notes.push(`${away}'s form is trending downward across their recent matches.`);

  if (typeof features.home_advantage_index === "number" && features.home_advantage_index > 1) notes.push(`A strong home-advantage index favors ${home}.`);
  if (typeof features.away_strength_index === "number" && features.away_strength_index > 1) notes.push(`${away}'s away-form index is notably strong for a travelling side.`);

  if (typeof features.goal_volatility === "number" && features.goal_volatility > 3.2) notes.push("High combined goal volatility — expect a less predictable, potentially high-swing scoreline.");

  if (typeof features.injury_differential === "number" && features.injury_differential >= 2) notes.push(`${away} is missing notably more players to injury/suspension than ${home}.`);
  if (typeof features.injury_differential === "number" && features.injury_differential <= -2) notes.push(`${home} is missing notably more players to injury/suspension than ${away}.`);

  if (typeof features.rest_differential === "number" && features.rest_differential >= 2) notes.push(`${home} has a rest-days advantage heading into this fixture.`);
  if (typeof features.rest_differential === "number" && features.rest_differential <= -2) notes.push(`${away} has a rest-days advantage heading into this fixture.`);

  if (typeof features.data_quality_score === "number" && features.data_quality_score < 60) notes.push(`Data quality was limited (${features.data_quality_score}/100) — treat this prediction with extra caution.`);

  if (typeof features.poisson_expected_goals_home === "number" && typeof features.poisson_expected_goals_away === "number") {
    const diff = features.poisson_expected_goals_home - features.poisson_expected_goals_away;
    if (Math.abs(diff) < 0.25) notes.push("The Poisson expected-goals baseline sees this as a closely-matched, genuinely uncertain fixture.");
  }

  return notes;
}

module.exports = { buildFeatureNotes };
