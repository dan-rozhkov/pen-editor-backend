import { randomUUID } from "node:crypto";
import { SHOWCASE_THEMES, pickTheme } from "./themes.js";
import { runShowcaseGeneration } from "./runner.js";
import { openShowcaseBrowser } from "./screenshot.js";
import { readFlag } from "./cliFlags.js";
import { openShowcaseContext } from "./context.js";
import { publishDepsFrom, publishScreens } from "./publish.js";
import { runAsScript } from "./cli.js";

const RECENT_THEMES_WINDOW = 10;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const themeOverride = readFlag(argv, "theme");
  const modelOverride = readFlag(argv, "model");

  const ctx = await openShowcaseContext("showcase");
  let browserSession: Awaited<ReturnType<typeof openShowcaseBrowser>> | undefined;

  try {
    let theme = themeOverride;
    if (!theme) {
      const recent = await ctx.store.recentThemes(RECENT_THEMES_WINDOW);
      theme = pickTheme(SHOWCASE_THEMES, recent, Math.random);
    }
    console.log(
      `[showcase] generating screens for theme "${theme}"` +
        (modelOverride ? ` with model "${modelOverride}"` : ""),
    );

    const result = await runShowcaseGeneration(ctx.config, theme, modelOverride);
    if (result.screens.length === 0) {
      console.error(`[showcase] no embed screens were produced for theme "${theme}"`);
      process.exitCode = 1;
      return;
    }

    browserSession = await openShowcaseBrowser();
    const session = browserSession;

    const published = await publishScreens(
      publishDepsFrom(ctx, (html) => session.screenshot(html)),
      {
        runId: randomUUID(),
        theme,
        prompt: result.prompt,
        model: result.model,
        screens: result.screens,
      },
    );

    console.log(
      `[showcase] done — theme "${theme}", ${published.length} screen(s):\n` +
        published.map((s) => `  - ${s.title}: ${s.imageUrl}`).join("\n"),
    );
  } finally {
    if (browserSession) await browserSession.close();
    await ctx.close();
  }
}

runAsScript(import.meta.url, "showcase", main);
