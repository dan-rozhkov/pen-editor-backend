// Curated pool of mobile-app domains the showcase generator picks from. Kept
// broad (consumer + prosumer + niche) so a long run doesn't feel repetitive.
export const SHOWCASE_THEMES: string[] = [
  "fitness tracker",
  "mobile banking",
  "recipe app",
  "car sharing",
  "meditation and sleep",
  "houseplant care",
  "movie tickets",
  "habit tracker",
  "food delivery",
  "travel planner",
  "ebook reader",
  "expense tracker",
  "weather forecast",
  "notes and to-do lists",
  "language learning",
  "music player",
  "sleep tracker",
  "secondhand marketplace",
  "yoga app",
  "water intake tracker",
  "restaurant table booking",
  "cycling app",
  "mood tracker",
  "ride hailing",
  "pet care app",
  "medication tracker",
  "scooter sharing",
  "wedding planner",
  "TV show and movie tracker",
];

// Picks a random theme from `themes`, avoiding anything in `recent` when
// possible. If every theme is "recent" (small pool, long history), the
// exclusion is dropped rather than throwing or looping forever — otherwise a
// run with a short theme list would eventually have nothing left to pick.
export function pickTheme(
  themes: string[],
  recent: string[],
  random: () => number,
): string {
  if (themes.length === 0) {
    throw new Error("pickTheme: themes list must not be empty");
  }

  const recentSet = new Set(recent);
  const candidates = themes.filter((t) => !recentSet.has(t));
  const pool = candidates.length > 0 ? candidates : themes;

  const index = Math.floor(random() * pool.length);
  // Guard against a random() implementation returning exactly 1.
  return pool[Math.min(index, pool.length - 1)];
}
