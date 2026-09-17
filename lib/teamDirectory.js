// A local, offline seed directory of well-known clubs, national teams, and
// their common aliases/nicknames/abbreviations, plus competitions. This is
// NOT a live, exhaustive football database (no such data source is
// available in this environment) — it's a practical, honest subset that
// covers autocomplete, alias resolution, and typo-tolerant search for the
// clubs and competitions people actually search for most. Anything not in
// this seed list still works fine as free-text input; it just won't get
// alias/typo suggestions.

const CLUBS = [
  // Premier League
  "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton & Hove Albion", "Burnley",
  "Chelsea", "Crystal Palace", "Everton", "Fulham", "Ipswich Town", "Leicester City",
  "Liverpool", "Manchester City", "Manchester United", "Newcastle United", "Nottingham Forest",
  "Southampton", "Tottenham Hotspur", "West Ham United", "Wolverhampton Wanderers",
  // La Liga
  "Real Madrid", "Barcelona", "Atletico Madrid", "Sevilla", "Real Sociedad", "Real Betis",
  "Villarreal", "Athletic Bilbao", "Valencia", "Celta Vigo", "Girona", "Osasuna",
  // Serie A
  "Juventus", "Inter Milan", "AC Milan", "Napoli", "AS Roma", "Lazio", "Atalanta",
  "Fiorentina", "Bologna", "Torino",
  // Bundesliga
  "Bayern Munich", "Borussia Dortmund", "RB Leipzig", "Bayer Leverkusen", "Union Berlin",
  "Eintracht Frankfurt", "Wolfsburg", "Borussia Monchengladbach", "Freiburg", "Stuttgart",
  // Ligue 1
  "Paris Saint-Germain", "Marseille", "Monaco", "Lyon", "Lille", "Nice", "Lens", "Rennes",
  // Other major clubs
  "Ajax", "PSV Eindhoven", "Feyenoord", "Porto", "Benfica", "Sporting CP", "Celtic", "Rangers",
  "Galatasaray", "Fenerbahce", "Besiktas", "Al Hilal", "Al Nassr", "Al Ahli",
];

const NATIONAL_TEAMS = [
  "Brazil", "Argentina", "France", "England", "Germany", "Spain", "Portugal", "Italy",
  "Netherlands", "Belgium", "Croatia", "Uruguay", "Colombia", "Mexico", "USA", "Japan",
  "South Korea", "Morocco", "Senegal", "Nigeria", "Ghana", "Egypt", "Ivory Coast",
  "Wales", "Scotland", "Ireland", "Poland", "Switzerland", "Denmark", "Sweden", "Norway",
  "Canada", "Australia", "Saudi Arabia", "Qatar", "Ecuador", "Chile", "Peru", "Costa Rica",
];

// Common nicknames/abbreviations -> canonical name.
const ALIASES = {
  "man utd": "Manchester United", "man u": "Manchester United", "manu": "Manchester United",
  "man city": "Manchester City", "mci": "Manchester City",
  "spurs": "Tottenham Hotspur", "tottenham": "Tottenham Hotspur",
  "brighton": "Brighton & Hove Albion",
  "wolves": "Wolverhampton Wanderers",
  "west ham": "West Ham United",
  "newcastle": "Newcastle United",
  "leicester": "Leicester City",
  "forest": "Nottingham Forest", "nffc": "Nottingham Forest",
  "psg": "Paris Saint-Germain",
  "real": "Real Madrid",
  "barca": "Barcelona", "fcb": "Barcelona",
  "atleti": "Atletico Madrid", "atletico": "Atletico Madrid",
  "juve": "Juventus",
  "inter": "Inter Milan",
  "milan": "AC Milan",
  "bayern": "Bayern Munich", "fcb munich": "Bayern Munich",
  "dortmund": "Borussia Dortmund", "bvb": "Borussia Dortmund",
  "leverkusen": "Bayer Leverkusen",
  "gladbach": "Borussia Monchengladbach",
  "psv": "PSV Eindhoven",
  "olympique marseille": "Marseille", "om": "Marseille",
  "olympique lyonnais": "Lyon", "ol": "Lyon",
  "sporting": "Sporting CP",
  "usa": "United States", "us soccer": "United States",
  "south korea": "South Korea", "korea republic": "South Korea",
  "ivory coast": "Ivory Coast", "cote d'ivoire": "Ivory Coast",
};

const COMPETITIONS = [
  "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Eredivisie",
  "Primeira Liga", "Scottish Premiership", "Championship", "MLS", "Saudi Pro League",
  "UEFA Champions League", "UEFA Europa League", "UEFA Europa Conference League",
  "UEFA Nations League", "FIFA World Cup", "World Cup Qualifiers", "UEFA Euro",
  "Copa America", "Africa Cup of Nations", "AFC Asian Cup", "CONCACAF Gold Cup",
  "FA Cup", "EFL Cup", "Copa del Rey", "Coppa Italia", "DFB-Pokal", "Coupe de France",
  "International Friendly",
];

// -----------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------

function titleCase(str) {
  const smallWords = new Set(["and", "of", "the", "&"]);
  return str
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word, i) => {
      if (i > 0 && smallWords.has(word.toLowerCase())) return word.toLowerCase();
      if (/^[A-Z0-9]{2,4}$/.test(word)) return word; // preserve existing acronyms like "PSG", "FC"
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Resolve a raw team-name string against the alias table, then title-case it. Never fails — falls back to cleaned-up input. */
function normalizeTeamName(raw) {
  const cleaned = (raw || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return cleaned;
  const alias = ALIASES[cleaned.toLowerCase()];
  if (alias) return alias;
  const exact = [...CLUBS, ...NATIONAL_TEAMS].find((n) => n.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;
  return titleCase(cleaned);
}

function normalizeCompetitionName(raw) {
  const cleaned = (raw || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return cleaned;
  const exact = COMPETITIONS.find((c) => c.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;
  return titleCase(cleaned);
}

// -----------------------------------------------------------------------
// Typo-tolerant fuzzy search (Levenshtein distance, small + fast for these list sizes)
// -----------------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Search the seed list + alias table + arbitrary extra names (e.g. teams
 * seen in this user's own history) for matches to a query, typo-tolerant.
 * Ranks: exact prefix match > substring match > close-edit-distance match.
 */
function searchTeams(query, { extraNames = [], limit = 8 } = {}) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const pool = [...new Set([...CLUBS, ...NATIONAL_TEAMS, ...extraNames])];

  const scored = pool.map((name) => {
    const lower = name.toLowerCase();
    let score = 0;
    if (lower === q) score = 100;
    else if (lower.startsWith(q)) score = 85;
    else if (lower.includes(q)) score = 65;
    else {
      const dist = levenshtein(q, lower.slice(0, q.length + 3));
      score = dist <= 2 ? 40 - dist * 10 : 0;
    }
    return { name, score };
  });

  // Also check alias matches, mapping back to canonical name.
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (alias.startsWith(q) || alias.includes(q)) {
      const existing = scored.find((s) => s.name === canonical);
      if (existing) existing.score = Math.max(existing.score, alias.startsWith(q) ? 80 : 55);
      else scored.push({ name: canonical, score: alias.startsWith(q) ? 80 : 55 });
    }
  }

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.name);
}

function searchCompetitions(query, { extraNames = [], limit = 8 } = {}) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const pool = [...new Set([...COMPETITIONS, ...extraNames])];
  return pool
    .map((name) => {
      const lower = name.toLowerCase();
      let score = 0;
      if (lower === q) score = 100;
      else if (lower.startsWith(q)) score = 85;
      else if (lower.includes(q)) score = 60;
      return { name, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.name);
}

module.exports = { normalizeTeamName, normalizeCompetitionName, searchTeams, searchCompetitions, CLUBS, NATIONAL_TEAMS, COMPETITIONS, ALIASES };
