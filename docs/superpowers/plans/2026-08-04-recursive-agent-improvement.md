# Recursive Auto-Improvement Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the design agent a convergent improvement loop — probes derived from its own spec, run against real headless generations, judged mechanically and by eye, one lever moved per failure.

**Architecture:** Two small backend changes make the loop possible: a shared render+diagnose module so a dry run and `showcase:preview` judge identically, and a `--dry-run=<dir>` mode for `showcase:generate` that produces a real OpenRouter run without publishing it. The loop itself is a Claude Code skill plus a versioned probes file; no orchestration code.

**Tech Stack:** TypeScript (NodeNext ESM), Vitest, sharp, Playwright (CLI-only), Markdown skills.

**Spec:** `docs/superpowers/specs/2026-08-04-recursive-agent-improvement-design.md`

## Global Constraints

- Backend is ESM with `moduleResolution: "NodeNext"` — **every relative import must carry the `.js` extension**, even in `.ts` source.
- `src/showcase/platform.ts` holds the CSS viewports (`mobile: 390x844`, `desktop: 1440x1024`) precisely so callers do not import `screenshot.ts`, which pulls in `playwright` (a devDependency) and would crash a production install. New non-CLI modules must import viewport data from `platform.ts` and may only `import type` from `screenshot.ts`.
- `DEVICE_SCALE_FACTOR` is 2, so a correct mobile screen is **780x1688 device px**.
- Coverage gates in `vitest.config.ts` are statements 89 / branches 80 / functions 89 / lines 90. **Do not lower them.** New logic must either be unit-testable without a browser or be an entrypoint added to the `exclude` list with a comment saying why, following the existing entries.
- `npm test -- run` does NOT mean "run the tests" — `run` is a name filter and silently executes ~2 files. Use `npm test`.
- Commit in `pen-editor-backend` only. The repo root is not a git repo, so `.claude/skills/` files are not committed anywhere; that is expected.
- Working directory for all commands: `/Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend`.

---

### Task 1: Shared render+diagnose module

Extract the per-screen loop from the preview entrypoint into a browser-free, unit-testable module so the dry run and `showcase:preview` cannot drift apart.

**Files:**
- Create: `src/showcase/previewScreens.ts`
- Create: `test/showcase-preview-screens.test.ts`
- Modify: `src/showcase/previewRun.ts` (replace its inner loop with a call into the new module)

**Interfaces:**
- Consumes: `normalizeShowcaseHtml` from `./normalizeHtml.js`; `DEAD_SPACE_LIMIT_CSS_PX`, `DEVICE_SCALE_FACTOR`, `measureBottomDeadSpace` from `./previewDiagnostics.js`; `showcaseViewport`, `ShowcasePlatform` from `./platform.js`; `ScreenshotResult` (type only) from `./screenshot.js`.
- Produces:
  - `interface ScreenSource { label: string; html: string; pngPath: string }`
  - `interface ScreenReport { label: string; pngPath: string; width: number; height: number; notes: string[] }`
  - `interface RenderDeps { screenshot(html: string, platform: ShowcasePlatform): Promise<ScreenshotResult>; writeFile(path: string, data: Buffer): Promise<void> }`
  - `renderAndDiagnose(deps: RenderDeps, sources: ScreenSource[], platform: ShowcasePlatform): Promise<ScreenReport[]>`
  - `describeReport(report: ScreenReport): string[]`
  - `screenFileStem(name: string, index: number): string`

- [ ] **Step 1: Write the failing test**

Create `test/showcase-preview-screens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  describeReport,
  renderAndDiagnose,
  screenFileStem,
  type RenderDeps,
} from "../src/showcase/previewScreens.js";

// A solid-colour PNG of the given device-pixel size. 780x1688 is a correct
// mobile screen (390x844 CSS at deviceScaleFactor 2).
async function png(width: number, height: number, grey: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: grey, g: grey, b: grey } },
  })
    .png()
    .toBuffer();
}

// A screen that is background at the top and content at the bottom, so the
// dead-space measurement (which samples the top-left corner as the ground
// colour) reports zero.
async function pngWithContent(width: number, height: number): Promise<Buffer> {
  const top = { create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } };
  const stripe = await sharp({
    create: { width, height: 40, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .png()
    .toBuffer();
  return sharp(top)
    .composite([{ input: stripe, left: 0, top: height - 40 }])
    .png()
    .toBuffer();
}

function deps(buffer: Buffer, clipped: string[] = []): RenderDeps & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    async screenshot(html: string) {
      // The module must hand normalized HTML to the browser, never the raw
      // input — that difference is exactly what a preview exists to catch.
      expect(html).toContain("<html");
      const meta = await sharp(buffer).metadata();
      return { buffer, width: meta.width!, height: meta.height!, clipped };
    },
    async writeFile(path: string) {
      written.push(path);
    },
  };
}

describe("renderAndDiagnose", () => {
  it("reports a correct screen with no notes and writes its PNG", async () => {
    const d = deps(await pngWithContent(780, 1688));
    const reports = await renderAndDiagnose(
      d,
      [{ label: "01-home", html: "<html><body>hi</body></html>", pngPath: "/tmp/01-home.png" }],
      "mobile",
    );

    expect(reports).toHaveLength(1);
    expect(reports[0].notes).toEqual([]);
    expect(reports[0].width).toBe(780);
    expect(d.written).toEqual(["/tmp/01-home.png"]);
  });

  it("flags a screen whose content overflowed the box", async () => {
    const d = deps(await pngWithContent(780, 2000));
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "mobile",
    );

    expect(report.notes[0]).toContain("expected 780x1688");
  });

  it("flags content sliced by the bottom edge", async () => {
    const d = deps(await pngWithContent(780, 1688), ["span.label cut 14px"]);
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "mobile",
    );

    expect(report.notes).toContain("sliced by the bottom edge: span.label cut 14px");
  });

  it("calls a uniform image a blank mount rather than dead space", async () => {
    const d = deps(await png(780, 1688, 255));
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "mobile",
    );

    expect(report.notes).toEqual([
      "blank mount — nothing rendered, the asset wait probably timed out",
    ]);
  });

  it("judges desktop screens against the desktop box", async () => {
    const d = deps(await pngWithContent(2880, 2048));
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "desktop",
    );

    expect(report.notes).toEqual([]);
  });
});

describe("describeReport", () => {
  it("marks a clean screen ok on one line", () => {
    expect(
      describeReport({ label: "01", pngPath: "/tmp/01.png", width: 780, height: 1688, notes: [] }),
    ).toEqual(["/tmp/01.png — 780x1688  ok"]);
  });

  it("lists each note under the heading", () => {
    expect(
      describeReport({
        label: "01",
        pngPath: "/tmp/01.png",
        width: 780,
        height: 1688,
        notes: ["a", "b"],
      }),
    ).toEqual(["/tmp/01.png — 780x1688", "  ! a", "  ! b"]);
  });
});

describe("screenFileStem", () => {
  it("numbers from one and slugifies the name", () => {
    expect(screenFileStem("Home feed", 0)).toBe("01-home-feed");
  });

  it("falls back to `screen` when the name has no latin characters", () => {
    expect(screenFileStem("Лента", 4)).toBe("05-screen");
  });

  it("collapses punctuation runs and trims the edges", () => {
    expect(screenFileStem("  Cart / Checkout!  ", 9)).toBe("10-cart-checkout");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/showcase-preview-screens.test.ts`
Expected: FAIL — "Failed to load .../src/showcase/previewScreens.js".

- [ ] **Step 3: Write the module**

Create `src/showcase/previewScreens.ts`:

```ts
import { normalizeShowcaseHtml } from "./normalizeHtml.js";
import {
  DEAD_SPACE_LIMIT_CSS_PX,
  DEVICE_SCALE_FACTOR,
  measureBottomDeadSpace,
} from "./previewDiagnostics.js";
import { showcaseViewport, type ShowcasePlatform } from "./platform.js";
import type { ScreenshotResult } from "./screenshot.js";

// The render-and-judge pass shared by `showcase:preview` (hand-authored files)
// and `showcase:generate --dry-run` (a real generation, unpublished).
//
// It lives apart from both entrypoints so the two cannot drift: a preview that
// normalizes differently from the pipeline, or judges against a different box,
// fails in exactly the way a preview exists to catch. Dependencies are
// injected rather than imported so this stays testable without the Chromium CI
// does not install — the type-only import of `ScreenshotResult` is erased at
// compile time and keeps `playwright` out of this module's graph.

export interface ScreenSource {
  /** Used in logs and the contact sheet; the PNG path is given separately. */
  label: string;
  html: string;
  pngPath: string;
}

export interface ScreenReport {
  label: string;
  pngPath: string;
  width: number;
  height: number;
  /** Defects worth a human's attention; empty means the screen passed. */
  notes: string[];
}

export interface RenderDeps {
  screenshot(html: string, platform: ShowcasePlatform): Promise<ScreenshotResult>;
  writeFile(path: string, data: Buffer): Promise<void>;
}

export async function renderAndDiagnose(
  deps: RenderDeps,
  sources: ScreenSource[],
  platform: ShowcasePlatform,
): Promise<ScreenReport[]> {
  const viewport = showcaseViewport(platform);
  const expected = {
    width: viewport.width * DEVICE_SCALE_FACTOR,
    height: viewport.height * DEVICE_SCALE_FACTOR,
  };

  const reports: ScreenReport[] = [];
  // Sequential on purpose: one page at a time is what the browser session
  // promises, and the log reads in screen order.
  for (const source of sources) {
    const html = normalizeShowcaseHtml(source.html);
    const { buffer, width, height, clipped } = await deps.screenshot(html, platform);
    await deps.writeFile(source.pngPath, buffer);

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

    reports.push({ label: source.label, pngPath: source.pngPath, width, height, notes });
  }
  return reports;
}

/** The lines an entrypoint prints for one screen. */
export function describeReport(report: ScreenReport): string[] {
  const suffix = report.notes.length === 0 ? "  ok" : "";
  return [
    `${report.pngPath} — ${report.width}x${report.height}${suffix}`,
    ...report.notes.map((note) => `  ! ${note}`),
  ];
}

/** `01-home-feed` — a sortable, filesystem-safe stem for a generated screen.
 * Screen names arrive from the model and may be non-latin or punctuated; the
 * number carries the ordering, so a name that slugifies to nothing is fine. */
export function screenFileStem(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${String(index + 1).padStart(2, "0")}-${slug || "screen"}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/showcase-preview-screens.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Rewrite the preview entrypoint on top of the module**

In `src/showcase/previewRun.ts`, replace the import block and the `try { for (const file of files) { … } }` body. The new file body between the usage check and the contact sheet becomes:

```ts
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
```

Its imports become:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { openShowcaseBrowser } from "./screenshot.js";
import { buildContactSheet } from "./previewDiagnostics.js";
import { describeReport, renderAndDiagnose } from "./previewScreens.js";
import { parsePlatformFlag } from "./cliFlags.js";
import { runAsScript } from "./cli.js";
```

Delete the now-unused `viewport`/`expected` locals and the `normalizeShowcaseHtml`, `showcaseViewport`, `DEAD_SPACE_LIMIT_CSS_PX`, `DEVICE_SCALE_FACTOR`, `measureBottomDeadSpace` imports from this file. Keep the header comment, the `--sheet` block, and the trailing non-zero exit exactly as they are. Update the header comment's "The three checks below" sentence to "The three checks it runs" and note that they now live in `previewScreens.ts`.

- [ ] **Step 6: Verify the whole suite, types and lint**

Run: `npm test && npm run build && npm run lint`
Expected: all green. Coverage must still clear statements 89 / branches 80 / functions 89 / lines 90 — the new module is fully unit-tested, so it raises coverage rather than lowering it. **Do not touch the thresholds.**

- [ ] **Step 7: Smoke the real preview against a real screen**

Run:
```bash
printf '<html><body style="margin:0;height:100vh;background:#fff"><div style="height:100px;background:#111"></div></body></html>' > /tmp/probe.html
npm run showcase:preview -- /tmp/probe.html
```
Expected: it prints `/tmp/probe.png — 780x1688` followed by a dead-space note, and exits non-zero. (If Chromium is missing: `npx playwright install chromium`.) This proves the refactor still drives a real browser.

- [ ] **Step 8: Commit**

```bash
git add src/showcase/previewScreens.ts src/showcase/previewRun.ts test/showcase-preview-screens.test.ts
git commit -m "refactor(showcase): share the render-and-judge pass between preview and callers"
```

---

### Task 2: `--dry-run=<dir>` for `showcase:generate`

A real OpenRouter generation whose screens land on disk instead of in the gallery — the loop's runner.

**Files:**
- Modify: `src/showcase/cliFlags.ts` (add `parseDryRunDir`)
- Modify: `src/showcase/run.ts` (branch before `publishScreens`)
- Modify: `test/showcase-cli-flags.test.ts` (cover the new parser)
- Modify: `CLAUDE.md` (document the flag under the showcase commands)

**Interfaces:**
- Consumes: `renderAndDiagnose`, `describeReport`, `screenFileStem` from Task 1; `hasFlag`/`readFlag` from `./cliFlags.js`; `runShowcaseGeneration` (returns `{ theme, prompt, model, screens: { name, htmlContent }[] }`); `openShowcaseBrowser` from `./screenshot.js`.
- Produces: `parseDryRunDir(argv: string[], tag: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

Append to `test/showcase-cli-flags.test.ts`:

```ts
describe("parseDryRunDir", () => {
  // The existing `afterEach(() => vi.restoreAllMocks())` in this file sits
  // inside the `parsePlatformFlag` describe block, so it does not cover this
  // one — the process.exit spy below must be torn down here.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseDryRunDir(["--theme=x"], "showcase")).toBeUndefined();
  });

  it("reads the directory from the inline form", () => {
    expect(parseDryRunDir(["--dry-run=/tmp/probe-01"], "showcase")).toBe("/tmp/probe-01");
  });

  it("reads the directory from the separated form", () => {
    expect(parseDryRunDir(["--dry-run", "/tmp/probe-01"], "showcase")).toBe("/tmp/probe-01");
  });

  it("exits when the flag is given without a directory", () => {
    // A valueless --dry-run would otherwise read as "publish normally", which
    // is the one outcome a dry run must never produce.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    parseDryRunDir(["--dry-run"], "showcase");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toContain("--dry-run needs a directory");
  });
});
```

Add `parseDryRunDir` to the existing import from `../src/showcase/cliFlags.js` at the top of the file. The file already imports `vi` and calls `afterEach(() => vi.restoreAllMocks())` — confirm that teardown exists and add it if it does not.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/showcase-cli-flags.test.ts`
Expected: FAIL — `parseDryRunDir is not a function`.

- [ ] **Step 3: Add the parser**

Append to `src/showcase/cliFlags.ts`:

```ts
/** `--dry-run=<dir>` for `showcase:generate`: run the agent for real, write
 * the screens into `<dir>` instead of publishing them. Unlike the boolean
 * `--dry-run` the repair CLIs take (see `parseCommonRepairFlags`), this one
 * needs a directory — a valueless flag is a mistake worth exiting on, because
 * falling back to "no dry run" would publish a probe run into the live
 * gallery, which is the one outcome the flag exists to prevent. */
export function parseDryRunDir(argv: string[], tag: string): string | undefined {
  if (!hasFlag(argv, "dry-run")) return undefined;
  const dir = readFlag(argv, "dry-run");
  if (!dir) {
    console.error(`[${tag}] --dry-run needs a directory, e.g. --dry-run=/tmp/probe-01`);
    process.exit(1);
  }
  return dir;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/showcase-cli-flags.test.ts`
Expected: PASS.

- [ ] **Step 5: Branch the generator entrypoint**

In `src/showcase/run.ts`:

Add to the imports:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasFlag, readFlag, parsePlatformFlag, parseDryRunDir } from "./cliFlags.js";
import { describeReport, renderAndDiagnose, screenFileStem } from "./previewScreens.js";
import { buildContactSheet } from "./previewDiagnostics.js";
```

(merge the `cliFlags.js` import with the existing one rather than duplicating it).

Read the flag next to the other flags at the top of `main`:

```ts
  const dryRunDir = parseDryRunDir(argv, "showcase");
```

Then, in the `try` block, replace the publish tail — everything from `browserSession = await openShowcaseBrowser();` through the final `console.log` — with:

```ts
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
```

…leaving the existing `publishScreens` call and its `console.log` exactly as they are below. Note the `writeFile` passed to `renderAndDiagnose` is `node:fs/promises`' — its `(path, data)` signature matches `RenderDeps`.

Leave the `--cover` validation above untouched: it runs before the branch and is harmless in a dry run.

- [ ] **Step 6: Verify types, lint and the suite**

Run: `npm run build && npm run lint && npm test`
Expected: all green. `src/showcase/run.ts` is already in the coverage `exclude` list as an entrypoint, so the branch does not move the gates.

- [ ] **Step 7: Smoke a real dry run**

Run: `npm run showcase:generate -- --theme="доставка еды" --dry-run=/tmp/probe-smoke`
Expected: a real generation (a few minutes), then `.html`/`.png` pairs plus `_sheet.png` in `/tmp/probe-smoke`, a per-screen report, and **no** new app in the gallery. Verify the last part with `psql`-free evidence: the log must not contain any `https://` S3 URLs, which only the publish path prints.

If the run dies before `batch_design` with `finishReason "other"`, that is the known `minimax-m3`-class flake — retry once before treating it as a defect.

- [ ] **Step 8: Document the flag**

In `CLAUDE.md`, under the backend commands block, add to the showcase lines:

```bash
npm run showcase:generate -- --dry-run=<dir>   # real agent run, screens to disk, nothing published
```

And in the "The showcase" section, after the sentence describing `showcase:generate`, add: "`--dry-run=<dir>` runs the same generation but writes the screens and their PNGs into a directory instead of publishing them — this is what the `/improve-design-agent` loop runs against."

- [ ] **Step 9: Commit**

```bash
git add src/showcase/cliFlags.ts src/showcase/run.ts test/showcase-cli-flags.test.ts CLAUDE.md
git commit -m "feat(showcase): add --dry-run=<dir> so a real generation can be judged unpublished"
```

---

### Task 3: The probes file

The fixed yardstick. Seeded only from defects that have already cost a rebuild — no invented probes.

**Files:**
- Create: `probes/showcase-mobile.md`
- Modify: `CLAUDE.md` (one line pointing at it)

**Interfaces:**
- Consumes: nothing in code — this file is read by the skill in Task 4.
- Produces: the probe format `### P-NNN <title>` / `expectation:` / `source:` / `judge: mechanical | by eye` / `status:`.

- [ ] **Step 1: Write the file**

Create `probes/showcase-mobile.md`:

````markdown
# Showcase probes — mobile

The fixed yardstick for `/improve-design-agent`. Each probe is one checkable
expectation drawn from the agent's own spec (`src/skills/*.md`) or from a defect
that already shipped. The set only grows: a failure that gets fixed stays here
so the next loop re-checks it.

Lives outside `src/` on purpose — `src/skills/` is loaded by `src/ai/skills.ts`
at startup, and a probe file in there would be advertised to the model as a
skill.

**Fields.** `expectation` is one line a judge can rule on. `judge` is
`mechanical` (`showcase:preview` / the dry run reports it) or `by eye` (someone
looks at the PNG). `status` is updated at the end of a loop session.

---

### P-001 every screen renders in the box
expectation: every screen is exactly 780x1688 device px
source: pipeline invariant (`src/showcase/platform.ts`)
judge: mechanical
status: green as of 2026-08-04

### P-002 nothing is sliced by the bottom edge
expectation: no leaf element is cut by the bottom of the screen
source: incident — a shelf published with its captions shaved off at a perfect 780x1688
judge: mechanical
status: green as of 2026-08-04

### P-003 no screen ends in a band of nothing
expectation: less than 160 CSS px of bare background at the foot of the screen
source: `src/skills/prototype.md` ("no screen ends in 200px of dead space")
judge: mechanical
status: green as of 2026-08-04

### P-004 the mount is never blank
expectation: no screen renders as a single uniform colour
source: incident — the render-ready wait timed out on heavy photos and published an empty mount
judge: mechanical
status: green as of 2026-08-04

### P-005 the pinned bottom bar survives the 844 box
expectation: a pinned bottom bar keeps its labels and its full height; content above it neither overflows nor doubles the screen
source: incident 2026-07-31 — the 844 box fails three quiet ways at once
judge: by eye
status: unknown

### P-006 the pinned bar is not hidden under a later layer
expectation: a bar that exists in the HTML is visible in the PNG
source: incident — a z-index trap; the 780x1688 size check cannot see a missing element
judge: by eye
status: unknown

### P-007 an absolutely positioned image does not grow the screen
expectation: decorative cut-outs are backgrounds, not absolute `<img>` elements
source: incident — `coverPinnedBars` ignores `overflow: hidden`
judge: by eye
status: unknown

### P-008 unstyled controls do not fall back to system chrome
expectation: no button, input or select renders with the browser's default appearance
source: incident — UA styles leaking into embeds; fixed with a reset inside `@layer`
judge: by eye
status: unknown

### P-009 the palette is not the warm-cream default
expectation: the run's accent family differs from the beige/terracotta band unless the theme demands it
source: incident — deepseek clusters on warm cream; `--model` note in `src/showcase/runner.ts`
judge: by eye
status: unknown

### P-010 every screen the agent announced actually arrived
expectation: the screen count in the run log matches the number the agent described in its own turn, and none of them is blank
source: incident — `extractEmbeds` truncated a batch at an unescaped quote and published blank screens
judge: mechanical (read from the run log, not the PNG)
status: green as of 2026-08-04

### P-011 the flow reads as one product
expectation: type, spacing and colour are shared across the run's screens; no screen looks authored separately
source: `src/skills/prototype.md` (OWN-WORLD direction contract)
judge: by eye
status: unknown

### P-012 the brief is not austere
expectation: screens show a point of view — imagery, colour and a stated hierarchy — rather than reading as a list of prohibitions obeyed
source: incident — "a brief of prohibitions yields dry screens"
judge: by eye
status: unknown
````

- [ ] **Step 2: Point at it from CLAUDE.md**

In `CLAUDE.md`, in the "The showcase" section, add a sentence at the end: "`probes/showcase-mobile.md` holds the checkable expectations the `/improve-design-agent` loop judges a run against; every new defect is added there so the next loop re-checks it."

- [ ] **Step 3: Verify it does not reach the model**

Run: `npm test`
Expected: green — in particular the skills tests, which enumerate `src/skills/`. The probes file lives outside `src/`, so no skill count changes. If any test asserts a skill list and now fails, the file is in the wrong place: move it, do not edit the assertion.

- [ ] **Step 4: Commit**

```bash
git add probes/showcase-mobile.md CLAUDE.md
git commit -m "docs(showcase): seed the probe set from defects that already shipped"
```

---

### Task 4: The `/improve-design-agent` skill

The loop itself. No code — a procedure, with the discipline that makes it converge.

**Files:**
- Create: `/Users/daniilrozhkov/prj/pen-editor-app/.claude/skills/improve-design-agent/SKILL.md`

**Interfaces:**
- Consumes: `npm run showcase:generate -- --dry-run=<dir>` (Task 2), `probes/showcase-mobile.md` (Task 3), `src/skills/*.md`.
- Produces: nothing importable — its output is an uncommitted skill diff plus a report.

- [ ] **Step 1: Write the skill**

Create the directory and `SKILL.md`:

```markdown
---
name: improve-design-agent
description: Use when improving the showcase design agent against its own spec — "прогони петлю улучшения", "improve the design agent", "почему витрина опять сухая", or after a batch of defects has accumulated. Runs real unpublished generations, judges them against the probe set, and moves one lever per failure.
---

# Improve the design agent

A convergent loop: probes from the agent's own spec, real runs, two-layer
judging, one lever per failure. It ends with an uncommitted skill diff and a
report — never a commit.

Work in `/Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend`.

## Budget

Default: **3 runs per iteration, at most 3 iterations** (~9 generations).
Each run is a real OpenRouter turn — minutes and tokens. Do not exceed the
budget to chase a probe; report it unresolved instead.

## The loop

### 1. Select probes

Read `probes/showcase-mobile.md` and the skills the run will exercise
(`src/skills/prototype.md` first). Every probe applies unless it is marked
`blocked:`. If the user named a concern ("экраны сухие"), put its probes first
in the report — but still judge all of them, because the lever you move for one
probe is exactly what breaks another.

### 2. Run

```bash
npm run showcase:generate -- --theme="<theme>" --dry-run=/tmp/rai-<iteration>-<n>
```

Three different themes per iteration. Do not pass `--model` unless the user
asked — the loop must judge the model that actually ships
(`SHOWCASE_MODEL_ID` in `src/showcase/runner.ts`).

A run that dies before `batch_design` with `finishReason "other"` is the known
model flake. Retry it once, then record it as an infrastructure failure — it is
not a probe failure and must not cause a skill edit.

### 3. Judge, both layers

**Mechanical:** the dry run already printed a note per defect. Every note maps
to a probe (P-001..P-004, P-010).

**By eye:** open `_sheet.png`, then every screen PNG with the Read tool. This
layer is not optional. Every defect that has actually shipped rendered at a
perfect 780x1688 and passed every mechanical gate — see the header comment in
`src/showcase/previewDiagnostics.ts`. For each `judge: by eye` probe, write one
line: pass, or the evidence for the failure ("03-cart: tab bar labels clipped,
bar is 44px instead of 56").

A probe that fails in one run of three is **suspected**, not failed: report it,
do not fix it. A probe that fails in two or more is a defect.

### 4. Move one lever

For each defect, exactly one edit to exactly one file in `src/skills/`. A lever
is: tighten an existing rule, add a rule, or change a stated default. It is not:
a rewrite, a new section, or the same instruction repeated more emphatically.

Prefer editing the rule that is already there over adding a new one — the skills
are long, and a loop that only ever appends makes the spec worse while making
the probes greener.

Record every edit as `probe → evidence → lever → file:line`.

Never edit `src/showcase/*.ts` to make a probe pass. If a probe can only be
fixed in code, mark it `blocked: needs a pipeline change — <what>` in the probes
file and leave it.

### 5. Re-run

Same three themes, fresh dry-run directories. Judge only the probes that failed,
plus the mechanical layer in full (it is free and it catches regressions the
lever introduced).

Stop when every probe is green, or after the third iteration, or when the only
remaining failures are `blocked:`.

### 6. Report

Update `status:` on every probe you ruled on. Add a probe for any new defect
you found that was not already covered — this is how the set grows.

Then report to the user:

- one line per probe: green / fixed / suspected / blocked
- for each lever: the diff hunk and why that lever and not another
- infrastructure failures separately, with counts
- what you would look at next

Leave everything uncommitted. The user reviews the skill diff and decides.

## Anti-patterns

| Temptation | Why it is wrong |
|---|---|
| Judge only mechanically — it is faster | Converges on green, not on good. Every shipped defect passed the mechanical gates. |
| Fix a probe by editing the pipeline | The loop improves the agent, not the renderer. Mark it `blocked:` instead. |
| Two edits for one failure | You lose which one worked, and the next iteration cannot attribute the change. |
| Publish the run to look at it in the gallery | `--dry-run` exists for this. Nine probe apps in the showcase is the failure mode. |
| Lower the bar in a probe so it passes | The probe set is the yardstick. Changing it to fit the result is measuring nothing. |
| Delete a probe that has been green for a while | Green probes are the regression suite. They cost nothing to keep. |
```

- [ ] **Step 2: Verify the skill is discoverable**

Run: `ls /Users/daniilrozhkov/prj/pen-editor-app/.claude/skills/improve-design-agent/SKILL.md`
Expected: the path exists. The skill appears in the skill list on the next session; it needs no registration. Nothing to commit — the repo root is not a git repo.

- [ ] **Step 3: Dry-check the procedure end to end**

Do not run the full loop here — it is the user's call to spend the tokens. Instead verify each command in the skill runs: `npm run showcase:generate -- --help`-style invocation is not supported, so confirm instead that `parseDryRunDir` rejects a valueless flag:

Run: `npm run showcase:generate -- --dry-run`
Expected: exits 1 with `[showcase] --dry-run needs a directory, e.g. --dry-run=/tmp/probe-01`, before any model call.

- [ ] **Step 4: Report to the user**

The plan is finished. Tell the user the loop is ready, what one invocation costs (~9 real generations, 30–45 minutes), and offer to run the first iteration.

---

## Self-review

**Spec coverage:**
- Loop architecture → Task 4.
- `--dry-run=<dir>` → Task 2.
- Shared preview module → Task 1.
- Probes file, format, seed set → Task 3.
- Error handling (model flake, blocked probes, uncommitted edits) → Task 4, steps 2/4/6.
- Out of scope (trace mining, auto-commit, cron, run history, desktop probes) → absent from every task, as intended.

**Types:** `RenderDeps`/`ScreenSource`/`ScreenReport` are defined in Task 1 and consumed in Task 2 with the same names and shapes. `parseDryRunDir` is defined and used with the same signature in Task 2. `screenFileStem(name, index)` — `index` is zero-based in both the definition and the call site.
