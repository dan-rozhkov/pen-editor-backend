import { SHOWCASE_THEMES, DESKTOP_THEMES, pickTheme } from "./themes.js";
import { openShowcaseContext } from "./context.js";
import { parsePlatformFlag } from "./cliFlags.js";
import { runAsScript } from "./cli.js";

const RECENT_THEMES_WINDOW = 10;

// CLI entrypoint for `npm run showcase:theme -- [--platform=mobile|desktop]`
// — prints one theme from the requested platform's pool, skipping the last
// 10 already used *on that platform*, and nothing else. `showcase:generate`
// picks its own theme inline; a hand-authored run (ingestRun.ts) needs the
// same choice made the same way *before* any HTML is written, so it can name
// the theme in its manifest.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const platform = parsePlatformFlag(argv, "theme");
  const ctx = await openShowcaseContext("theme");
  try {
    const recent = await ctx.store.recentThemes(RECENT_THEMES_WINDOW, platform);
    const pool = platform === "desktop" ? DESKTOP_THEMES : SHOWCASE_THEMES;
    console.log(pickTheme(pool, recent, Math.random));
  } finally {
    await ctx.close();
  }
}

runAsScript(import.meta.url, "theme", main);
