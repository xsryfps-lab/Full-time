// Detects whether a fixture is a club match or an international match, since
// they need fundamentally different data: club football has league tables,
// points, and home/away splits; international football has FIFA rankings,
// tournament form, and no meaningful "home ground" in most cases.
const INTERNATIONAL_KEYWORDS = [
  "world cup", "euro", "european championship", "nations league", "afcon",
  "africa cup", "copa america", "asian cup", "gold cup", "olympics",
  "qualifier", "qualifying", "international friendly", "concacaf", "uefa nations",
  "caf ", "conmebol", "friendlies", "u-21", "u21", "under-21", "u-23", "u23",
];

function detectMatchType(league) {
  const l = (league || "").toLowerCase();
  return INTERNATIONAL_KEYWORDS.some((kw) => l.includes(kw)) ? "international" : "club";
}

module.exports = { detectMatchType, INTERNATIONAL_KEYWORDS };
