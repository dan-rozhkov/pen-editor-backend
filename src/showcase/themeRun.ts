import { SHOWCASE_THEMES, pickTheme } from "./themes.js";
import { openShowcaseContext } from "./context.js";
import { runAsScript } from "./cli.js";

const RECENT_THEMES_WINDOW = 10;

// CLI entrypoint for `npm run showcase:theme` — prints one theme, skipping the
// last 10 already used, and nothing else. `showcase:generate` picks its own
// theme inline; a hand-authored run (ingestRun.ts) needs the same choice made
// the same way *before* any HTML is written, so it can name the theme in its
// manifest.
async function main(): Promise<void> {
  const ctx = await openShowcaseContext("theme");
  try {
    const recent = await ctx.store.recentThemes(RECENT_THEMES_WINDOW);
    console.log(pickTheme(SHOWCASE_THEMES, recent, Math.random));
  } finally {
    await ctx.close();
  }
}

runAsScript(import.meta.url, "theme", main);
