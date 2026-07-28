# Podcast Stack Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a verified, hand-authored five-screen Podcast Stack mobile showcase run for Tandem.

**Architecture:** Keep all run artifacts in `.handrun/podcast-stack-20260728/` and leave application source unchanged except for a temporary screenshot harness that is removed after rendering. Generate one large cover asset through the existing Gemini helper, author five standalone HTML documents, validate them through the production screenshot implementation, then publish the reviewed manifest through the shared ingest pipeline.

**Tech Stack:** Static HTML/CSS, Google Fonts, Phosphor Icons, TypeScript/tsx, Playwright, existing showcase S3/Postgres pipeline.

## Global Constraints

- Five screens at exactly 390×844 CSS pixels and 780×1688 rendered pixels.
- One Google font: Manrope.
- One muted orange accent below 80% saturation and a cool-neutral base; never pure black.
- Regular Phosphor icons only; no device chrome, JavaScript, transitions, animations, filters, or ad-hoc UI SVGs.
- Every HTML file starts with the approved THESIS / OWN-WORLD / STORY / FIRST VIEWPORT direction comment.
- Any pinned bottom control has at least its full height reserved in content padding.
- The run model is `Codex GPT-5 (hand-authored)`.
- Existing `.handrun` files are preserved; only `.handrun/podcast-stack-20260728/` belongs to this run.

---

### Task 1: Prepare and inspect the cover asset

**Files:**
- Create: `.handrun/podcast-stack-20260728/quiet-cost-cover.webp`

**Interfaces:**
- Consumes: `npm run showcase:image -- "<prompt>"`, which emits `url<TAB>prompt`.
- Produces: one locally inspected cover image used by screens 1–3.

- [ ] **Step 1: Create the run directory**

Run:

```bash
mkdir -p .handrun/podcast-stack-20260728
```

Expected: the directory exists without changing any sibling `.handrun` file.

- [ ] **Step 2: Generate the exact artwork**

Run:

```bash
npm run showcase:image -- "Editorial podcast cover photograph for an episode titled The Quiet Cost of Convenience: close crop of a brushed-steel self-checkout scanner beside one crumpled paper receipt, cool milk-white and graphite palette with one muted burnt-orange object, hard side light, tactile realistic photography, no typography, no logos, no gradients, square composition"
```

Expected: one HTTPS image URL followed by the submitted prompt.

- [ ] **Step 3: Download and inspect the image**

Run:

```bash
curl -L "<generated-url>" -o .handrun/podcast-stack-20260728/quiet-cost-cover.webp
file .handrun/podcast-stack-20260728/quiet-cost-cover.webp
```

Expected: a valid raster image. Inspect it visually and reject it if it has text, logos, unrelated subject matter, or visible generation defects.

### Task 2: Author the five-screen flow

**Files:**
- Create: `.handrun/podcast-stack-20260728/1-your-stack.html`
- Create: `.handrun/podcast-stack-20260728/2-now-playing.html`
- Create: `.handrun/podcast-stack-20260728/3-chapter-notes.html`
- Create: `.handrun/podcast-stack-20260728/4-queue-at-risk.html`
- Create: `.handrun/podcast-stack-20260728/5-offline-error.html`

**Interfaces:**
- Consumes: `.handrun/podcast-stack-20260728/quiet-cost-cover.webp` as a file URL resolved to an absolute path before screenshotting.
- Produces: five self-contained static HTML documents accepted by `openShowcaseBrowser().screenshot(html)`.

- [ ] **Step 1: Author the shared world contract in every file**

Use this exact opening comment before the first `<style>`:

```html
<!--
THESIS: A podcast queue should feel like a deliberate stack of things worth hearing, not a storefront grid. Tandem refuses equal recommendation cards and generic streaming chrome.
OWN-WORLD: Cold milk-white paper, ink-dark type, and one muted orange accent. Episodes overlap like record sleeves and annotated paper covers; hairlines, clipped artwork, visible durations, and offset layers make the interface recognizable without copy.
STORY: The listener builds an evening queue, starts an episode, captures chapter notes, discovers expiring downloads, and repairs one failed offline save.
FIRST VIEWPORT: The active episode owns the upper field while the next pieces of the listening stack remain visibly layered below; the primary action sits in a fully reserved bottom bar.
-->
```

- [ ] **Step 2: Author screen 1 — Your Stack**

Include the expanded episode “The Quiet Cost of Convenience,” the show `Minor Systems`, host `Nadiya Bell`, a `47:16` duration, two offset episode layers, `1h 38m left`, and a bottom `Play from start` action. The screen must communicate queue order without equal card tiles.

- [ ] **Step 3: Author screen 2 — Now Playing**

Show the same cover, `18:42 / 47:16`, chapter `Invisible labor at the kiosk`, a timeline with real chapter divisions, playback controls using regular Phosphor icons, and `Add note at 18:42` as the primary action.

- [ ] **Step 4: Author screen 3 — Chapter Notes**

Show timestamped synthetic listener notes at `06:18` and `18:42`, one explicitly labelled synthetic excerpt, and an empty `31:05 · The receipt trail` chapter with a concrete `Add first note` action.

- [ ] **Step 5: Author screen 4 — Queue at Risk**

Show two selected downloads expiring tomorrow at organic times, one non-expiring item, explicit storage impact (`184.7 MB selected`, `1.26 GB free`), and a primary `Keep 2 offline` action. Use a warning state without a modal or decorative side stripe.

- [ ] **Step 6: Author screen 5 — Offline Error**

State that `Streetlight Frequency` failed because its source link expired, preserve its `#3 in Evening Stack` position, show `72.4 MB`, and provide `Try download again` plus the secondary `Remove from stack`.

- [ ] **Step 7: Run static constraint checks**

Run:

```bash
rg -L 'THESIS:.*Podcast queue|THESIS: A podcast queue' .handrun/podcast-stack-20260728/*.html
rg -n '<script|on[a-z]+=|transition:|animation:|@keyframes|filter:|backdrop-filter|#000000|#000\\b|<svg' .handrun/podcast-stack-20260728/*.html
```

Expected: the first command prints nothing; the second prints nothing.

### Task 3: Render and review with the production screenshotter

**Files:**
- Create temporarily: `src/showcase/previewTmp.ts`
- Create: `.handrun/podcast-stack-20260728/1-your-stack.png`
- Create: `.handrun/podcast-stack-20260728/2-now-playing.png`
- Create: `.handrun/podcast-stack-20260728/3-chapter-notes.png`
- Create: `.handrun/podcast-stack-20260728/4-queue-at-risk.png`
- Create: `.handrun/podcast-stack-20260728/5-offline-error.png`
- Delete after rendering: `src/showcase/previewTmp.ts`

**Interfaces:**
- Consumes: five authored HTML files.
- Produces: five reviewed 780×1688 PNGs and no persistent source-tree harness.

- [ ] **Step 1: Add the temporary harness**

```ts
import { readFile, writeFile } from "node:fs/promises";
import { openShowcaseBrowser } from "./screenshot.js";

const session = await openShowcaseBrowser();
try {
  for (const file of process.argv.slice(2)) {
    const html = await readFile(file, "utf8");
    const { buffer, width, height } = await session.screenshot(html);
    await writeFile(file.replace(/\.html$/, ".png"), buffer);
    console.log(`${file} — ${width}x${height}`);
  }
} finally {
  await session.close();
}
```

- [ ] **Step 2: Render all five screens**

Run:

```bash
npx tsx src/showcase/previewTmp.ts .handrun/podcast-stack-20260728/*.html
```

Expected: five `— 780x1688` lines and no `[showcase] grew the screen` or render-ready warning.

- [ ] **Step 3: Inspect every PNG**

Verify each screen at full resolution for clipping, fallback fonts, blank icons, broken artwork, state clarity, and cross-screen continuity. Revise HTML and repeat Step 2 until every check passes.

- [ ] **Step 4: Remove the harness and verify the source tree**

Run:

```bash
rm src/showcase/previewTmp.ts
npm run build
```

Expected: the temporary harness is absent and TypeScript build succeeds.

### Task 4: Dry-run and publish

**Files:**
- Create: `.handrun/podcast-stack-20260728/run.json`

**Interfaces:**
- Consumes: five reviewed HTML files.
- Produces: one published showcase run with returned image URLs.

- [ ] **Step 1: Create the exact manifest**

```json
{
  "theme": "podcast stack",
  "prompt": "Design Tandem, a five-screen mobile podcast queue that treats episodes as a deliberate physical stack: build the evening queue, play The Quiet Cost of Convenience, attach chapter notes, protect expiring downloads, and recover one failed offline save. Use a cold milk-white paper world, ink-dark type, one muted orange accent, Manrope, and regular Phosphor icons.",
  "model": "Codex GPT-5 (hand-authored)",
  "screens": [
    { "name": "1 · Your Stack", "file": "1-your-stack.html", "cover": true },
    { "name": "2 · Now Playing", "file": "2-now-playing.html" },
    { "name": "3 · Chapter Notes", "file": "3-chapter-notes.html" },
    { "name": "4 · Queue at Risk", "file": "4-queue-at-risk.html" },
    { "name": "5 · Offline Error", "file": "5-offline-error.html" }
  ]
}
```

- [ ] **Step 2: Validate without external writes**

Run:

```bash
npm run showcase:ingest -- --manifest .handrun/podcast-stack-20260728/run.json --dry-run
```

Expected: exactly five named screens under theme `podcast stack`, with screen 1 selected as cover, and no S3/Postgres mutation.

- [ ] **Step 3: Publish**

Run:

```bash
npm run showcase:ingest -- --manifest .handrun/podcast-stack-20260728/run.json
```

Expected: five uploaded screen records and five returned image URLs.

- [ ] **Step 4: Record authoritative evidence**

Capture the run ID, screen IDs, dimensions, and returned URLs. Confirm `git status --short` shows no temporary harness and no tracked implementation changes beyond the documentation commits.
