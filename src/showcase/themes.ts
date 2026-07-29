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

// Curated pool of desktop web-app domains — the productivity/prosumer/B2B
// software people actually run in a browser window, as distinct from
// `SHOWCASE_THEMES`'s consumer mobile-app pool. Kept separate rather than
// filtered from one shared list because very few of these translate to a
// phone screen (nobody wants a DAW or an infra dashboard on a 390px-wide
// canvas), and vice versa.
export const DESKTOP_THEMES: string[] = [
  "analytics dashboard",
  "CRM",
  "billing and subscriptions admin",
  "email client",
  "project planner",
  "audio workstation (DAW)",
  "code editor / IDE",
  "infrastructure monitoring dashboard",
  "CMS",
  "HR portal",
  "applicant tracking system",
  "customer support helpdesk",
  "invoicing and accounting",
  "design system documentation site",
  "API developer portal",
  "kanban project board",
  "video editing suite",
  "spreadsheet / data grid app",
  "server / database admin panel",
  "e-commerce back office",
  "marketing campaign builder",
  "knowledge base / wiki",
  "team calendar and scheduling",
  "warehouse and inventory management",
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
