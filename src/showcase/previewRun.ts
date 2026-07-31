import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { openShowcaseBrowser, showcaseViewport } from "./screenshot.js";
import { normalizeShowcaseHtml } from "./normalizeHtml.js";
import {
  DEAD_SPACE_LIMIT_CSS_PX,
  DEVICE_SCALE_FACTOR,
  buildContactSheet,
  measureBottomDeadSpace,
} from "./previewDiagnostics.js";
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
// The three checks below are the ones that have actually cost rebuilds. Every
// defect got past the size check at a perfect 780×1688: a screen ending in a
// band of nothing, a row of content shaved by the bottom edge, and a blank
// mount left behind when the asset wait timed out.
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

  const viewport = showcaseViewport(platform);
  const expected = {
    width: viewport.width * DEVICE_SCALE_FACTOR,
    height: viewport.height * DEVICE_SCALE_FACTOR,
  };

  // One browser for every file — the whole point of taking a list.
  const session = await openShowcaseBrowser();
  const rendered: { path: string; label: string }[] = [];
  const problems: string[] = [];
  try {
    for (const file of files) {
      const html = normalizeShowcaseHtml(await readFile(file, "utf8"));
      const { buffer, width, height, clipped } = await session.screenshot(html, platform);
      const out = file.replace(/\.html$/, ".png");
      await writeFile(out, buffer);
      rendered.push({ path: out, label: basename(out, ".png") });

      const notes: string[] = [];
      if (width !== expected.width || height !== expected.height) {
        notes.push(`wrong size — expected ${expected.width}x${expected.height}, content overflows`);
      }
      if (clipped.length > 0) notes.push(`sliced by the bottom edge: ${clipped.join(", ")}`);

      const dead = await measureBottomDeadSpace(buffer);
      if (dead.blank) {
        notes.push("blank mount — nothing rendered, the asset wait probably timed out");
      } else if (dead.cssPx > DEAD_SPACE_LIMIT_CSS_PX) {
        notes.push(`${dead.cssPx}px of dead space at the bottom`);
      }

      console.log(`${out} — ${width}x${height}${notes.length === 0 ? "  ok" : ""}`);
      for (const note of notes) {
        console.log(`  ! ${note}`);
        problems.push(`${basename(out)}: ${note}`);
      }
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
