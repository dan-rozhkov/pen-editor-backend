# Impeccable v4.0.1 Skill Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `pen-editor-backend/src/skills/` from Impeccable v3.9.1 to v4.0.1, and inline the v4 quality floor into the auto-loaded `prototype` skill so every create-new run is held to the v4 bar automatically.

**Architecture:** Skills are flat Markdown files in `src/skills/*.md`, loaded at startup by `src/ai/skills.ts` and injected one-at-a-time as a synthetic tool-call/result pair (see repo `CLAUDE.md`). Because injection is one-skill-at-a-time, each ported skill must stay **self-contained**: the shared v4 `craft-floor` is folded into the `frontend-design` hub AND a compact floor digest is inlined per command skill. The register model (brand/product) is retired in favor of v4's four visitor modes.

**Tech Stack:** Markdown skill files; TypeScript (ESM, NodeNext — relative imports need `.js`); Vitest; ESLint. No new runtime deps.

## Global Constraints

- **Source of truth:** Impeccable **v4.0.1**, upstream `pbakaus/impeccable` tag `skill-v4.0.1`, commit `eda81f09378d32c93fec6d3cd8f1ecbf13595e15`. Reference files materialized at **`/tmp/impeccable-v4-ref/reference/`** by Task 0. Port bodies **verbatim from upstream, then apply the Adaptation Recipe** — do not paraphrase from memory.
- **Adaptation Recipe (apply to every ported body):**
  1. Keep our frontmatter shape: `name:`, `description:`, and `args:` (list of `{name, description, required}`) only. No `argument-hint`, `user-invocable`, `allowed-tools`, `license` in command skills (frontend-design keeps its license/NOTICE line).
  2. Strip ALL Impeccable CLI scaffolding: `npx impeccable …`, `node {{scripts_path}}/*.mjs`, `context.mjs`, `concept-seed.mjs`, `serve-question.mjs`, `surface-brief.mjs`, `detect.mjs`, `pin.mjs`, `context-signals.mjs`, and any `hooks`/`doctor`/`live`/`pin` command invocations. Replace the *intent* with plain instructions where the philosophy matters; delete pure tooling steps.
  3. Strip PRODUCT.md / DESIGN.md file-system assumptions **except** where a skill genuinely produces a document (`document` writes a design doc). Never instruct the agent to read/write PRODUCT.md/DESIGN.md/surface briefs on disk — the agent has no project filesystem; it has canvas + `get_editor_state`.
  4. Clarification prompts use the literal token `{{ask_instruction}}` (the loader replaces it). Never leave upstream's "ask the user" phrasing where a token belongs.
  5. Handoffs are `/X` (no `impeccable` prefix), and only linked when a local skill `X.md` exists. Remove links to skills we do not ship.
  6. Replace upstream's parent `SKILL.md` references with a pointer to the local **`frontend-design`** hub.
  7. Convert vendor-conditional blocks (`<codex>…</codex>`, `<gemini>…</gemini>`, `<claude>…</claude>`) into neutral prose that applies to all models (we serve one model set; keep the *content*, drop the per-vendor gating tags).
  8. **Self-contained floor tail (D2):** append to each command body a short `## Quality floor` section with the essential v4 Verify + Refuse bullets (contrast, depth/shadow, spacing rhythm, type measure/tracking, one authored motion, real states, honest copy) and one line: "Full floor lives in the `frontend-design` skill."
- **Visitor modes (replace brand/product register everywhere):** **Persuade** (visitor decides/acts — landing, marketing, pricing), **Operate** (visitor completes a task — app UI, dashboards, editors, settings), **Read** (visitor understands — docs, guides), **Experience** (visitor is inside the work — portfolios, galleries). Mode is chosen from the requested surface, not the product.
- **Skip entirely (do not port):** `ios`, `android`, `adapt.native`, `audit.native`, `init`, `hooks`, `live`, `doctor`, `routing`, `codex`, and all `.mjs` scripts.
- **No new runtime dependencies.** Backend is ESM/NodeNext; any TS import edits keep `.js` extensions.
- **Verification gates:** `npm run lint`, `npm test`, `npm run build` all pass before the release task.

---

### Task 0: Branch and materialize the v4 reference

**Files:**
- No source files changed. Working-tree/branch + `/tmp/impeccable-v4-ref/`.

- [ ] **Step 1: Create the working branch**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
git checkout main && git pull --ff-only origin main
git checkout -b impeccable-v4
```
Expected: `Switched to a new branch 'impeccable-v4'`

- [ ] **Step 2: Ensure the v4 reference exists at the stable path (idempotent)**

Run:
```bash
if [ ! -d /tmp/impeccable-v4-ref/reference ]; then
  cd /tmp && mkdir -p imp-v4 && \
  gh api repos/pbakaus/impeccable/tarball/refs/tags/skill-v4.0.1 > imp-v4.tar.gz && \
  tar xzf imp-v4.tar.gz -C imp-v4 && \
  SRC=$(find /tmp/imp-v4 -type d -path '*skill/reference' | head -1 | xargs dirname) && \
  mkdir -p /tmp/impeccable-v4-ref && cp -R "$SRC/reference" /tmp/impeccable-v4-ref/reference && \
  cp "$SRC/SKILL.src.md" /tmp/impeccable-v4-ref/SKILL.src.md
fi
ls /tmp/impeccable-v4-ref/reference | wc -l
```
Expected: `34`

- [ ] **Step 3: Snapshot our current skill set for diffing later**

Run:
```bash
ls /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend/src/skills/*.md | xargs -n1 basename > /tmp/impeccable-v4-ref/OUR-SKILLS-BEFORE.txt
cat /tmp/impeccable-v4-ref/OUR-SKILLS-BEFORE.txt | wc -l
```
Expected: `32`

No commit (setup only).

---

### Task 1: Fold craft-floor into the `frontend-design` hub

**Files:**
- Modify: `src/skills/frontend-design.md`
- Reference: `/tmp/impeccable-v4-ref/reference/craft-floor.md`

**Interfaces:**
- Produces: the canonical `## Quality floor` content (Verify + Refuse + Calibration) that every command skill's floor tail is a digest of, and that `prototype.md` inlines in full (Task 7).

- [ ] **Step 1: Read both files**

Read `src/skills/frontend-design.md` (keep its frontmatter, its Anthropic-lineage identity, and the `license:`/NOTICE attribution line intact) and `/tmp/impeccable-v4-ref/reference/craft-floor.md`.

- [ ] **Step 2: Merge the v4 floor into the hub**

Append (or merge into the existing aesthetics section) three subsections built from `craft-floor.md`, per Adaptation Recipe rule 7 (fold the `<codex>`/`<gemini>` tips into neutral prose):
- **Verify** — contrast (body/placeholder ≥4.5:1, large ≥3:1; tint secondary text from the surface hue, never gray); depth (shadows need offset + soft blur; zero-offset colored halo is banned); spacing (tight groups, generous separation, more space above a heading than below); type (measure 65–75ch, display ≤6rem, tracking floor −0.04em with −0.02/−0.03em usually better, balanced headings, real copy at every breakpoint, no overflow); motion (one authored moment, exponential ease-out from an already-visible default, reach past transform/opacity to blur/backdrop-filter/clip-path/mask/shadow, never one identical section fade); states (hover/disabled/loading/error/empty + real content, keyboard focus, responsive); copy (product's own language; controls name their action, errors name problem + recovery); coverage (every brief requirement findable in seconds).
- **Refuse (category defaults, not hard bans — the brief can earn any)** — identical-card grids / nested cards; hero-metric template; eyebrow over every section; decorative section numbers; modal-by-reflex; gradient text; glassmorphism-as-decoration; colored side-stripe borders >1px; decorative sparklines/progress-rings/soft-shadow rounded-rects standing in for content; mono-as-"technical"; theme picked by category instead of use-scene; ghost card (1px border under wide soft shadow — declare elevation once); over-round cards (radii 12–16px; pills only for small controls); sketchy/doodle SVG and `feTurbulence` grain; `repeating-linear-gradient` stripes / grid-overlay backgrounds without a real canvas under them; never animate an image on hover (give the container the feedback).
- **Calibration (anti-default self-check)** — name the AI-cluster looks (warm cream + high-contrast serif + terracotta/signal-red; near-black + one neon accent + glow; broadsheet hairlines + italic serif + tracked mono labels) and the rule: where the brief leaves the aesthetic free, if someone could guess your aesthetic from the category alone, rework. Book/warm/child subjects do not license cream+serif. A brief-pinned world pins the world, not its softest rendition.

End the section with: "The floor holds the mechanics; it never picks the direction. With every check green, spend the page on the committed world; when torn between refined and committed, commit."

- [ ] **Step 3: Verify the hub still loads and carries the floor**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
node -e "import('./src/ai/skills.ts')" 2>/dev/null; \
grep -c "Quality floor\|Refuse\|Calibration" src/skills/frontend-design.md
```
Expected: a count ≥ 3 (the three headings present). (The `node -e` is a smoke import; ignore its output.)

- [ ] **Step 4: Commit**

```bash
git add src/skills/frontend-design.md
git commit -m "feat(skills): fold Impeccable v4 craft-floor into frontend-design hub"
```

---

### Task 2: Port the three new v4 playbooks (new-work, operate, visualize)

**Files:**
- Create: `src/skills/new-work.md`, `src/skills/operate.md`, `src/skills/visualize.md`
- Reference: `/tmp/impeccable-v4-ref/reference/{new-work,operate,visualize}.md`

**Interfaces:**
- Produces: `/new-work`, `/operate`, `/visualize` handoff targets consumed by `prototype.md`, `typeset.md`, `shape.md`, and the mode wiring.

- [ ] **Step 1: Create `new-work.md`**

Frontmatter:
```markdown
---
name: new-work
description: Playbook for making a NEW surface or replacing a visual world — pick a committed visual direction (world), write the direction contract, prove-don't-claim, before building. Load when starting a fresh screen/page/flow with no established look to inherit.
args: []
---
```
Body: port `/tmp/impeccable-v4-ref/reference/new-work.md` per the Adaptation Recipe, with these specific removals/rewrites:
- Delete the `concept-seed.mjs` / `serve-question.mjs` / `surface-brief.mjs` steps and the QUALITY-BAR image-board machinery and the `impeccable-finish-reviewer` subagent handoff. Keep their **philosophy** as plain instructions: (a) redesign-vs-extend-vs-inherit decision; (b) derive **5–7 concrete visual worlds** from the audience's real world (span ≥3 material families, exclude the category's predictable default); (c) commit ONE direction (don't present a ranked menu of safe candidates); offer 1–2 alternates + a "play it straight / category-standard" escape hatch the agent never recommends; (d) the **direction contract** recorded before building — THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM (≤150 words, in the artifact's opening comment); (e) truth binds *claims* (prices, customers, benchmarks, capabilities) not *demonstrations* — author illustrative content at full fidelity and label it synthetic.
- Color strategy: Restrained / Committed / Full-palette / Drenched; commit color at page scale; dark-vs-light from the use scene, never by category.
- Font reflex-reject list (the training-data defaults to avoid unless no other face works): Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, Space Grotesk, Space Mono, IBM Plex, Inter-as-display, DM Sans, DM Serif, Outfit, Plus Jakarta Sans, Instrument Sans.
- Replace `{{scripts_path}}` visualize step with: "When image generation is available, load `/visualize` first."
- Adapt to our surface: "artifact" = an `embed` node's `htmlContent`; "build" = generate HTML via `batch_design`. No filesystem.

- [ ] **Step 2: Create `operate.md`**

Frontmatter:
```markdown
---
name: operate
description: Deeper guidance for Operate and Read surfaces — task completion, scanability, native affordances, comprehension and wayfinding. Load when designing app UI, dashboards, editors, settings, docs, or guides.
args: []
---
```
Body: port `/tmp/impeccable-v4-ref/reference/operate.md` per the Adaptation Recipe.

- [ ] **Step 3: Create `visualize.md`**

Frontmatter:
```markdown
---
name: visualize
description: Optional pre-build step — render 2-3 compositional options for a locked direction and put them before the user before generating the final HTML. Use when image generation is available and the surface is visually ambitious.
args: []
---
```
Body: port `/tmp/impeccable-v4-ref/reference/visualize.md` per the Adaptation Recipe. Make it **non-blocking**: image generation is a backend capability, not guaranteed; if unavailable, skip and proceed to build. Frame the deliverable as "options shown in chat", not files on disk.

- [ ] **Step 4: Verify the three skills load and expose correct names**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
for f in new-work operate visualize; do
  head -3 src/skills/$f.md | grep -q "name: $f" && echo "$f OK" || echo "$f BAD"
done
grep -L "{{scripts_path}}\|concept-seed\|serve-question\|npx impeccable" src/skills/new-work.md src/skills/operate.md src/skills/visualize.md
```
Expected: `new-work OK`, `operate OK`, `visualize OK`, and all three paths printed by `grep -L` (meaning none contain the stripped CLI tokens).

- [ ] **Step 5: Commit**

```bash
git add src/skills/new-work.md src/skills/operate.md src/skills/visualize.md
git commit -m "feat(skills): port v4 new-work, operate, visualize playbooks (dice CLI stripped)"
```

---

### Task 3: Port command bodies — Group A (adapt, animate, audit, bolder, clarify, colorize, critique)

**Files:**
- Modify: `src/skills/{adapt,animate,audit,bolder,clarify,colorize,critique}.md`
- Reference: `/tmp/impeccable-v4-ref/reference/<same>.md`

- [ ] **Step 1: For each of the 7 skills, re-port the body**

For each skill file: preserve our existing frontmatter (`name`/`description`/`args`), replace the body with the v4.0.1 upstream body from the matching reference file, and apply the full Adaptation Recipe (including rule 8, the `## Quality floor` tail). Skill-specific notes:
- `critique.md` — leave the `audience/brand data` prose wording (it is a persona-generation instruction, not a `/brand` handoff); do NOT link `/brand`. Keep its heuristic scoring intact.
- `audit.md` — this is the web audit; do NOT reference the native variant.
- `colorize.md`, `bolder.md`, `animate.md`, `clarify.md`, `adapt.md` — bodies got much leaner in v4; the floor tail (rule 8) is what restores self-sufficiency.

- [ ] **Step 2: Verify no stripped tokens leaked and frontmatter intact**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
for f in adapt animate audit bolder clarify colorize critique; do
  head -1 src/skills/$f.md | grep -q "^---" && \
  ! grep -q "{{scripts_path}}\|npx impeccable\|concept-seed\|serve-question\|user-invocable\|allowed-tools" src/skills/$f.md \
  && echo "$f OK" || echo "$f CHECK"
done
```
Expected: all seven print `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/skills/adapt.md src/skills/animate.md src/skills/audit.md src/skills/bolder.md src/skills/clarify.md src/skills/colorize.md src/skills/critique.md
git commit -m "feat(skills): port v4 bodies — group A (adapt/animate/audit/bolder/clarify/colorize/critique)"
```

---

### Task 4: Port command bodies — Group B (delight, distill, document, extract, harden, layout, onboard)

**Files:**
- Modify: `src/skills/{delight,distill,document,extract,harden,layout,onboard}.md`
- Reference: `/tmp/impeccable-v4-ref/reference/<same>.md`

- [ ] **Step 1: For each of the 7 skills, re-port the body**

Same procedure as Task 3 Step 1 (preserve frontmatter, replace body from upstream, apply Adaptation Recipe incl. floor tail). Skill-specific notes:
- `document.md` — this skill legitimately produces a design document; keep its "capture the visual system" deliverable but reframe the output as a summary returned in chat / written into the design's opening comment, NOT a DESIGN.md file on disk (rule 3 exception is about producing a doc, not about a filesystem path).
- `extract.md` — upstream unchanged from v3.9.1 (`same` in the diff); still re-apply the recipe and add the floor tail for consistency.
- `onboard.md` — upstream unchanged (`same`); same treatment.

- [ ] **Step 2: Verify**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
for f in delight distill document extract harden layout onboard; do
  head -1 src/skills/$f.md | grep -q "^---" && \
  ! grep -q "{{scripts_path}}\|npx impeccable\|user-invocable\|allowed-tools\|DESIGN.md on disk" src/skills/$f.md \
  && echo "$f OK" || echo "$f CHECK"
done
```
Expected: all seven print `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/skills/delight.md src/skills/distill.md src/skills/document.md src/skills/extract.md src/skills/harden.md src/skills/layout.md src/skills/onboard.md
git commit -m "feat(skills): port v4 bodies — group B (delight/distill/document/extract/harden/layout/onboard)"
```

---

### Task 5: Port command bodies — Group C (optimize, overdrive, polish, quieter, shape, typeset)

**Files:**
- Modify: `src/skills/{optimize,overdrive,polish,quieter,shape,typeset}.md`
- Reference: `/tmp/impeccable-v4-ref/reference/<same>.md`

- [ ] **Step 1: For each of the 6 skills, re-port the body**

Same procedure. Skill-specific notes:
- `polish.md` — the test suite asserts `description` matches `/quality pass/i` and that the body contains the phrase `final pass`. v4 description ("Final quality pass before shipping") satisfies the first. Ensure the ported body still contains the literal phrase **"final pass"** (add it in the floor tail or intro sentence if v4's lean body dropped it). Preserve the `args: [{name: target, …}]` frontmatter exactly.
- `shape.md` — v4 `shape` owns task discovery then enters new-work for visual-world decisions. Repoint its build/world handoff to **`/new-work`**.
- `typeset.md` — **repoint the two `/brand` handoffs** (lines ~17 and ~166 in the current file: "run the font selection procedure in the `/brand` skill" and "live in the `/brand` skill under Font selection procedure and Reflex-reject list"). The font-selection procedure + reflex-reject list now live in **`/new-work`** (Task 2) and the `frontend-design` hub; point both references there.
- `overdrive.md` — keep its "push past conventional limits" intent; ensure floor tail present.

- [ ] **Step 2: Verify polish phrase + no dangling /brand link**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
grep -q "final pass" src/skills/polish.md && echo "polish-phrase OK" || echo "polish-phrase MISSING"
grep -rn "/brand\b\|/product\b" src/skills/*.md || echo "no dangling brand/product handoffs OK"
for f in optimize overdrive polish quieter shape typeset; do
  ! grep -q "{{scripts_path}}\|npx impeccable\|user-invocable" src/skills/$f.md && echo "$f OK" || echo "$f CHECK"
done
```
Expected: `polish-phrase OK`, `no dangling brand/product handoffs OK`, all six `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/skills/optimize.md src/skills/overdrive.md src/skills/polish.md src/skills/quieter.md src/skills/shape.md src/skills/typeset.md
git commit -m "feat(skills): port v4 bodies — group C (optimize/overdrive/polish/quieter/shape/typeset)"
```

---

### Task 6: Retire the register skills; make `craft` a deprecated alias

**Files:**
- Delete: `src/skills/brand.md`, `src/skills/product.md`
- Modify: `src/skills/craft.md`

**Interfaces:**
- Consumes: the `/new-work`, `/operate` targets from Task 2; the typeset repoint from Task 5 (must already be done — no remaining `/brand` link).

- [ ] **Step 1: Confirm nothing still links to brand/product**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
grep -rn "/brand\b\|/product\b\|load_skill.*brand\|load_skill.*product" src/skills/*.md src/ai/*.ts || echo "clear"
```
Expected: `clear`. If not clear, fix the referrer first (repoint to `/new-work` or `/operate`).

- [ ] **Step 2: Delete the two register skills**

Run:
```bash
git rm src/skills/brand.md src/skills/product.md
```

- [ ] **Step 3: Rewrite `craft.md` as a thin deprecated alias**

Replace the whole file with:
```markdown
---
name: craft
description: Deprecated alias for an ordinary new-work / prototype request. Kept for backward compatibility — prefer the prototype flow.
args:
  - name: feature
    description: What to build.
    required: false
---

`craft` is a deprecated alias and adds nothing on its own. To build something new on the canvas, follow the `prototype` skill (single static `embed` mockups) and, for choosing a committed visual direction, the `/new-work` playbook. This file exists only so an explicit `/craft` command still resolves.
```

- [ ] **Step 4: Verify the skill set shrank by two and craft is thin**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
ls src/skills/*.md | wc -l
test ! -e src/skills/brand.md && test ! -e src/skills/product.md && echo "register skills gone"
wc -l src/skills/craft.md
```
Expected: `33` (was 32, +3 new −2 deleted = 33), `register skills gone`, and craft.md small (≤ ~15 lines).

- [ ] **Step 5: Commit**

```bash
git add -A src/skills/
git commit -m "feat(skills): retire brand/product register (v4 4-mode model); craft -> deprecated alias"
```

---

### Task 7: Modes wiring in system-prompt + auto-beauty in prototype/slides

**Files:**
- Modify: `src/ai/system-prompt.ts` (create-new brief around line 55)
- Modify: `src/skills/prototype.md`
- Modify: `src/skills/slides.md`
- Reference: `/tmp/impeccable-v4-ref/reference/{craft-floor,new-work}.md`

**Interfaces:**
- Consumes: the four visitor modes (Global Constraints); the floor content canonized in Task 1.

- [ ] **Step 1: Read the current create-new brief in system-prompt.ts**

Read `src/ai/system-prompt.ts` around the `ask_user` brief (the paragraph beginning "Before you create anything NEW on the canvas … Gather the brief in one form: audience, platform/size, tone/style, scope, and brand constraints …").

- [ ] **Step 2: Replace the register framing with mode framing**

Edit that paragraph so the brief gathers, in one `ask_user` form: **audience, platform/size, the visitor mode for this surface (Persuade / Operate / Read / Experience), tone/style, scope, and constraints (e.g. whether to reuse existing variables/fonts)** — replacing the words "and brand constraints". Add one sentence: "Choose the mode from the surface the user asked for, not the product (a tool's landing page is still Persuade; a docs page is Read)." Do not otherwise change the FIRST-DECISION routing note.

- [ ] **Step 3: Inline the v4 quality floor into `prototype.md`**

In `prototype.md`, in/next to its existing taste-rules section, inline the **full** v4 craft-floor (Verify + Refuse + Calibration — the same content canonized in `frontend-design` in Task 1, written out in full here so a create-new run is self-sufficient without a second skill load). Then add a concise **"Commit the world first"** block to the Mandatory flow, before HTML generation:
- Pick the visitor mode (already in the brief).
- Name the visual world and write a one-paragraph direction contract in the embed's opening HTML comment: THESIS / OWN-WORLD / STORY / FIRST VIEWPORT. For a genuinely open new surface, consult `/new-work`.
- **Prove, don't claim:** show the subject doing its job; author demonstration content at full fidelity and label synthetic; never invent prices/customers/benchmarks/capabilities.
- Keep every existing prototype rule (embed-only, device presets, no device chrome, component mapping, fixed-viewport sizing, HTML safety).

- [ ] **Step 4: Reference the floor from `slides.md`**

In `slides.md`, add one line pointing to the shared quality floor ("Apply the quality floor from the `frontend-design` skill / prototype taste rules"), and repoint any `/brand` or `/product` mention to `/new-work`/`/operate` if present. Keep all deck-specific rules (1024×768, shared master, filmstrip) intact.

- [ ] **Step 5: Verify wiring**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
grep -q "Persuade" src/ai/system-prompt.ts && echo "modes in prompt OK" || echo "modes MISSING"
grep -qi "prove, don't claim\|Commit the world" src/skills/prototype.md && echo "prototype world-step OK" || echo "prototype step MISSING"
grep -qi "Refuse\|Calibration\|floor" src/skills/prototype.md && echo "prototype floor OK" || echo "prototype floor MISSING"
grep -rn "/brand\b\|/product\b" src/skills/slides.md || echo "slides clear"
```
Expected: `modes in prompt OK`, `prototype world-step OK`, `prototype floor OK`, `slides clear`.

- [ ] **Step 6: Commit**

```bash
git add src/ai/system-prompt.ts src/skills/prototype.md src/skills/slides.md
git commit -m "feat(skills): wire v4 visitor modes + inline craft-floor into auto-loaded prototype"
```

---

### Task 8: Update tests, then lint/test/build green

**Files:**
- Modify: `test/skills.test.ts`, `test/system-prompt.test.ts` (only if assertions break)

- [ ] **Step 1: Run the suite to see what the port broke**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
npm test 2>&1 | tail -40
```
Expected: failures pinpointing assertions that reference old content (candidates: `skills.test.ts` `polish` "final pass"/args/description; any brand/product reference; `system-prompt.test.ts` brief wording).

- [ ] **Step 2: Fix `skills.test.ts` if needed**

If `polish.content` no longer contains `final pass`, prefer fixing the **skill** (Task 5 should have kept the phrase); only if the phrase is genuinely obsolete, update the assertion to a phrase that exists in the v4 polish body. Ensure `polish.args` still equals the `target` arg the test expects (frontmatter must be preserved). Confirm the "no skill body contains `{{ask_instruction}}` after load" test still passes (the loader strips it).

- [ ] **Step 3: Fix `system-prompt.test.ts` if needed**

Update any assertion that pinned the old "brand constraints" wording to the new mode wording. Keep the prototype-routing regression assertions (weaker-model `load_skill(prototype)`) unchanged and green.

- [ ] **Step 4: Full green gate**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
npm run lint && npm test && npm run build
```
Expected: lint 0 errors; all tests pass; build succeeds (`tsc → dist/`).

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test: update skill/system-prompt assertions for Impeccable v4 port"
```

---

### Task 9: Code review, release, memory

**Files:**
- Modify: `package.json` (version), memory files under the auto-memory dir.

- [ ] **Step 1: Self-review the diff**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
git diff main...impeccable-v4 --stat
```
Then invoke `/code-review` on the branch diff and address any findings.

- [ ] **Step 2: Merge to main and push**

Only after the user confirms merge (per repo policy). Then:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
git checkout main && git merge --ff-only impeccable-v4 && git push origin main
```

- [ ] **Step 3: Version bump via ship-release convention**

Use the `ship-release` skill (annotated tag, minor bump — this is a feature-level skill-set change):
```bash
npm version minor -m "chore: release v%s — Impeccable v4.0.1 skill port"
git push origin main --follow-tags
```
Then verify the release landed (tag pushed, CI green).

- [ ] **Step 4: Update auto-memory**

Supersede `design-skills-impeccable-v391.md`: rewrite (or add a new memory + delete the old) recording that skills are now **Impeccable v4.0.1** — 4 visitor modes replace brand/product register, craft-floor folded into the frontend-design hub, prototype auto-inlines the floor for automatic beauty on create-new, new-work/operate/visualize added, native/CLI skills skipped. Update the `MEMORY.md` index line.

---

## Self-Review

**Spec coverage** (each spec section → task):
- Architecture D1 craft-floor→hub → Task 1. ✓
- D2 lean body + floor tail → Global Constraints recipe rule 8, applied in Tasks 3–5. ✓
- D3 four modes → Global Constraints + Task 7 (system-prompt) + body ports. ✓
- D4 auto-beauty in prototype → Task 7. ✓
- Scope A (20 command bodies) → Tasks 3–5 (7+7+6=20). ✓
- Scope B (new-work/operate/visualize) → Task 2. ✓
- Scope C (retire brand/product, craft alias) → Task 6. ✓
- Scope D (modes in system-prompt) → Task 7. ✓
- Scope E (prototype/slides auto-beauty) → Task 7. ✓
- Scope F (skip native/CLI) → Global Constraints. ✓
- Tests/release/memory → Tasks 8–9. ✓

**Placeholder scan:** No "TBD/TODO". Long skill bodies are ported "verbatim from upstream `<exact path>` + Adaptation Recipe" — an actionable instruction with an exact source, not a placeholder. Short concrete content (frontmatter blocks, craft alias body, verification commands) is inlined in full.

**Type/name consistency:** New skill names `new-work`/`operate`/`visualize` are referenced identically in Tasks 2, 5 (typeset repoint), 6 (craft alias), 7 (prototype/slides). The `/brand` retirement in Task 6 depends on the typeset repoint in Task 5 — Task 6 Step 1 guards this with a grep gate. Skill count math: 32 − 2 (brand/product) + 3 (new-work/operate/visualize) = 33, asserted in Task 6 Step 4.
