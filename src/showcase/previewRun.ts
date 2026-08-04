import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { openShowcaseBrowser } from "./screenshot.js";
import { buildContactSheet } from "./previewDiagnostics.js";
import { describeReport, renderAndDiagnose } from "./previewScreens.js";
import { parsePlatformFlag } from "./cliFlags.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for
// `npm run showcase:preview -- [--platform=…] [--sheet] a.html b.html …`
// — renders hand-authored screens through the real pipeline, writes each PNG
// next to its source, and reports the defects a dimension check cannot see.
//
// It is a permanent script because the alternative is what the hand-run skill
// used to prescribe: every session writing a throwaway harness into `src/`,
// running it once per file, and deleting it again. That cost a fresh Chromium
// launch per screen, left `tsc`/lint/jscpd stepping on a file that was
// mid-life, and skipped `normalizeShowcaseHtml`, which `publish.ts` and
// `rescreenshot.ts` both apply — so the preview and the published screen could
// differ in exactly the way a preview exists to catch.
//
// The three checks it runs — the ones that have actually cost rebuilds — now
// live in `previewScreens.ts`, shared with `showcase:generate --dry-run`.
// Every defect got past the size check at a perfect 780×1688: a screen ending
// in a band of nothing, a row of content shaved by the bottom edge, and a
// blank mount left behind when the asset wait timed out.
//
// Needs neither Postgres nor S3: no `openShowcaseContext`, just a browser.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const platform = parsePlatformFlag(argv, "preview");
  const sheet = argv.includes("--sheet");
  const files = argv.filter((a) => !a.startsWith("--"));

  if (files.length === 0) {
    console.error(
      "[preview] usage: npm run showcase:preview -- " +
        "[--platform=mobile|desktop] [--sheet] <file.html> …",
    );
    process.exit(1);
  }

  // One browser for every file — the whole point of taking a list.
  const session = await openShowcaseBrowser();
  const rendered: { path: string; label: string }[] = [];
  const problems: string[] = [];
  try {
    const sources = await Promise.all(
      files.map(async (file) => ({
        label: basename(file, ".html"),
        html: await readFile(file, "utf8"),
        pngPath: file.replace(/\.html$/, ".png"),
      })),
    );

    const reports = await renderAndDiagnose(
      { screenshot: (html, p) => session.screenshot(html, p), writeFile },
      sources,
      platform,
    );

    for (const report of reports) {
      rendered.push({ path: report.pngPath, label: report.label });
      for (const line of describeReport(report)) console.log(line);
      for (const note of report.notes) problems.push(`${basename(report.pngPath)}: ${note}`);
    }
  } finally {
    await session.close();
  }

  if (sheet && rendered.length > 0) {
    const destination = join(dirname(rendered[0].path), "_sheet.png");
    await buildContactSheet(rendered, destination);
    console.log(`${destination}  (${rendered.length} screens) — LOOK AT IT`);
  }

  // Non-zero exit so an agent looping over this script does not have to parse
  // the log to notice. These are reports, not judgements: a screen can be
  // deliberately built past the fold, in which case say so and move on.
  if (problems.length > 0) {
    console.error(`[preview] ${problems.length} problem(s) across ${files.length} screen(s)`);
    process.exit(1);
  }
}

runAsScript(import.meta.url, "preview", main);
