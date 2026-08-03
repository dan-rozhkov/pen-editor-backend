import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SHOWCASE_THEMES, DESKTOP_THEMES, pickTheme } from "./themes.js";
import { recentAccentFamilies } from "./palette.js";
import { runShowcaseGeneration } from "./runner.js";
import { openShowcaseBrowser } from "./screenshot.js";
import { hasFlag, readFlag, parsePlatformFlag, parseDryRunDir } from "./cliFlags.js";
import { openShowcaseContext } from "./context.js";
import { publishDepsFrom, publishScreens } from "./publish.js";
import { resolveCoverIndex } from "./ingest.js";
import { describeReport, renderAndDiagnose, screenFileStem } from "./previewScreens.js";
import { buildContactSheet } from "./previewDiagnostics.js";
import { runAsScript } from "./cli.js";

const RECENT_THEMES_WINDOW = 10;
// Six runs is roughly the gallery's first visible row, and — with eight hue
// families — leaves the model real room to choose rather than backing it into
// the one band nobody has used yet.
const RECENT_PALETTES_WINDOW = 6;
const FETCH_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const themeOverride = readFlag(argv, "theme");
  const modelOverride = readFlag(argv, "model");
  const coverFlag = readFlag(argv, "cover");
  const coverFlagPresent = hasFlag(argv, "cover");
  const platform = parsePlatformFlag(argv, "showcase");
  const dryRunDir = parseDryRunDir(argv, "showcase");
  // Screen count isn't known until the agent has run, so this first pass
  // only validates presence/format; the upper-bound check happens below
  // once `result.screens.length` exists.
  let coverIndex: number | undefined;
  try {
    coverIndex = resolveCoverIndex({ raw: coverFlag, flagPresent: coverFlagPresent });
  } catch (err) {
    console.error(`[showcase] ${(err as Error).message}`);
    process.exit(1);
  }

  const ctx = await openShowcaseContext("showcase");
  let browserSession: Awaited<ReturnType<typeof openShowcaseBrowser>> | undefined;

  try {
    const themePool = platform === "desktop" ? DESKTOP_THEMES : SHOWCASE_THEMES;
    let theme = themeOverride;
    if (!theme) {
      const recent = await ctx.store.recentThemes(RECENT_THEMES_WINDOW, platform);
      theme = pickTheme(themePool, recent, Math.random);
    }
    // Palette rotation: read the accents of the last few published runs back
    // out of their HTML so this run can steer away from them. Best-effort by
    // construction (`recentAccentFamilies` swallows fetch failures) — a run
    // must still happen when S3 is unreachable, it just loses the hint.
    const avoidHueFamilies = await recentAccentFamilies(
      await ctx.store.recentRunHtmlUrls(RECENT_PALETTES_WINDOW),
      async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
        return res.text();
      },
    );

    console.log(
      `[showcase] generating ${platform} screens for theme "${theme}"` +
        (modelOverride ? ` with model "${modelOverride}"` : "") +
        (avoidHueFamilies.length ? `, avoiding accents: ${avoidHueFamilies.join(", ")}` : ""),
    );

    const result = await runShowcaseGeneration(ctx.config, theme, modelOverride, {
      avoidHueFamilies,
      platform,
    });
    if (result.screens.length === 0) {
      console.error(`[showcase] no embed screens were produced for theme "${theme}"`);
      process.exitCode = 1;
      return;
    }
    try {
      coverIndex = resolveCoverIndex({
        raw: coverFlag,
        flagPresent: coverFlagPresent,
        screenCount: result.screens.length,
      });
    } catch (err) {
      console.error(`[showcase] ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    browserSession = await openShowcaseBrowser();
    const session = browserSession;

    if (dryRunDir) {
      // A real run of the real agent, kept out of the gallery: the improvement
      // loop generates several of these per iteration, and publishing them
      // would fill the showcase with half-finished apps and pay S3 for them.
      // Everything upstream of here — theme choice, palette avoidance, the
      // turn itself — is untouched, so what is judged is what would ship.
      await mkdir(dryRunDir, { recursive: true });

      const sources = await Promise.all(
        result.screens.map(async (screen, index) => {
          const stem = screenFileStem(screen.name, index);
          const htmlPath = join(dryRunDir, `${stem}.html`);
          await writeFile(htmlPath, screen.htmlContent, "utf8");
          return { label: stem, html: screen.htmlContent, pngPath: join(dryRunDir, `${stem}.png`) };
        }),
      );

      const reports = await renderAndDiagnose(
        { screenshot: (html, p) => session.screenshot(html, p), writeFile },
        sources,
        platform,
      );
      for (const report of reports) {
        for (const line of describeReport(report)) console.log(line);
      }

      const sheet = join(dryRunDir, "_sheet.png");
      await buildContactSheet(
        reports.map((r) => ({ path: r.pngPath, label: r.label })),
        sheet,
      );

      const problems = reports.reduce((n, r) => n + r.notes.length, 0);
      console.log(
        `[showcase] dry run — theme "${theme}", model "${result.model}", ` +
          `${reports.length} screen(s) in ${dryRunDir}, ${problems} mechanical problem(s)\n` +
          `${sheet}  — LOOK AT IT`,
      );
      return;
    }

    const published = await publishScreens(
      publishDepsFrom(ctx, (html, screenPlatform) => session.screenshot(html, screenPlatform)),
      {
        runId: randomUUID(),
        theme,
        prompt: result.prompt,
        model: result.model,
        screens: result.screens,
        coverIndex,
        platform,
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
