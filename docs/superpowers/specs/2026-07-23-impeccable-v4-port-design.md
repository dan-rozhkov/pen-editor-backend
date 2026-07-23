# Impeccable v4.0.1 port — design spec

**Date:** 2026-07-23
**Repo:** `pen-editor-backend`
**Status:** approved for implementation

## Goal

Update the design-agent skills in `pen-editor-backend/src/skills/` from Impeccable
**v3.9.1** (ported 2026-07-02) to **v4.0.1** (upstream `pbakaus/impeccable`, tag
`skill-v4.0.1`, released 2026-07-22), and wire the v4 quality floor so that it is
applied **automatically whenever the agent prototypes** — not only when a user types
an explicit `/<skill>` command.

Two user requirements drive this:

1. Bring our skills up to Impeccable v4.
2. Whenever the agent prototypes something on the canvas, it must use the v4 skills
   automatically so the result comes out beautiful — no explicit user action required.

## Source of truth

Upstream raw files under `skill/reference/` at tag `skill-v4.0.1` in `pbakaus/impeccable`.
The website changelog is abstract; the reference `.md` files are authoritative.

## Key finding that shapes the port

In v4 the individual command skills got **much leaner** (e.g. `bolder` 120→31 lines,
`polish` 241→97, `typeset` 279→80, `clarify` 288→94). The reason is structural: v4
extracted the shared taste rules into a new **`craft-floor.md`** that each command skill
now *defers to* (loaded once, immediately before editing UI). Upstream can load the floor
plus a lean command skill together.

**Our constraint:** the backend injects **one** skill per turn (skills.ts / chat.ts inject
a single skill body as a synthetic tool-call + tool-result pair; system-prompt tells the
model to "load at most one skill"). A lean v4 command body on its own would lose the floor
content. The port must keep each skill **self-contained**.

## Architecture decisions

### D1 — craft-floor lives in the `frontend-design` hub

Fold v4 `craft-floor.md` (the **Verify** checks, the **Refuse** category-default list, and
the calibration anti-defaults) into our existing shared-principles hub
`src/skills/frontend-design.md`. This matches our long-standing convention ("the
shared-principles hub is the frontend-design skill, referenced in place of impeccable's
parent SKILL.md") and mirrors v4's structure, where craft-floor is the shared floor.

Do **not** overwrite frontend-design's Anthropic-lineage identity/attribution
(license/NOTICE line stays); append/merge the v4 floor content into it.

### D2 — lean command bodies + a self-contained floor tail

Port the v4 lean bodies for the shared command skills, but because our injection is
one-skill-at-a-time, append to each a compact **"Quality floor"** tail: the essential
Verify/Refuse bullets inlined, plus a one-line pointer to the frontend-design hub for the
full version. Net effect: bodies are updated to v4 taste and stay self-sufficient (no
regression vs. our current richer v3.9.1 bodies).

### D3 — 4 visitor modes replace the brand/product register

v4 retired the brand-or-product register field and replaced it with four **visitor modes**
that name what success looks like on a given surface:

- **Persuade** — visitor decides and acts (landing, marketing, pricing).
- **Operate** — visitor completes a task (app UI, dashboards, editors, settings).
- **Read** — visitor understands something (docs, articles, guides).
- **Experience** — visitor is inside the work (portfolios, galleries, showcases).

Mode is chosen from the *requested surface*, not the product.

### D4 — auto-beauty in prototyping via the auto-loaded `prototype` skill

`prototype.md` is already auto-loaded (per the FIRST-DECISION routing note in
system-prompt.ts) on any "create something new on the canvas" request. That is the
injection point for requirement #2: inline the full v4 quality floor into it so every
create-new run is held to the v4 bar without the user typing any command.

## Scope of changes

### A. Update bodies to v4 (20 shared command skills — keep, re-port body)

`adapt, animate, audit, bolder, clarify, colorize, critique, delight, distill, document,
extract, harden, layout, onboard, optimize, overdrive, polish, quieter, shape, typeset`

For each: replace the body with the v4.0.1 reference body, then re-apply our adaptation
conventions:

- flat one-file-per-skill, keep existing `name`/`description`/`args` frontmatter shape;
- strip all impeccable CLI scaffolding (`npx impeccable`, `node scripts/*.mjs`,
  `context.mjs`/`concept-seed.mjs`/`serve-question.mjs`/`surface-brief.mjs`/`detect.mjs`,
  pin/hooks/doctor invocations, PRODUCT.md/DESIGN.md file assumptions except where a skill
  genuinely produces a doc);
- clarification uses the literal `{{ask_instruction}}` token;
- handoffs are `/X` with no `impeccable` prefix, linked only when `X` exists locally;
- reference the frontend-design hub in place of impeccable's parent SKILL.md;
- apply D2 (self-contained floor tail).

### B. New v4 files to port (as prose, CLI machinery stripped)

- **new-work.md** — the "new surface / new-or-replacement visual world" playbook:
  redesign-vs-extend semantics, derive 5–7 concrete visual worlds from the audience's
  world, the **direction contract** (THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM),
  prove-don't-claim, calibration anti-defaults, color strategy, font-reflex avoidance.
  **Strip** the dice machinery: `concept-seed.mjs` external seeding, the
  `serve-question.mjs` browser decision page, QUALITY-BAR image boards, and the
  finish-reviewer/asset-producer subagents. Keep the *philosophy* those scripts encoded
  (pick a committed world, present one direction with a couple of alternates, don't ship
  the category default) as plain instructions. Referenced by `prototype`.
- **operate.md** — deeper Operate/Read guidance.
- **visualize.md** — optional "render three compositional options before building" step,
  mapped to our image-gen. Soft/non-blocking (image gen is a backend route; don't hard-gate
  the build on it).

### C. Retire the register skills

Delete **brand.md** and **product.md**. Repoint every `/brand` and `/product` handoff
(present in slides, typeset, critique, craft, research, overdrive) to the appropriate mode
guidance (`new-work` / `operate`) or remove the link.

Convert **craft.md** to a thin deprecated alias (v4 makes `craft` a deprecated alias for an
ordinary new-work request): point it at the create-new flow (`prototype` / `new-work`).

### D. Register → modes wiring in system-prompt.ts

- Replace the "brand constraints" framing in the create-new `ask_user` brief (line ~55)
  with a mode-aware brief: infer/choose the visitor mode (Persuade/Operate/Read/Experience)
  as part of the brief instead of asking for a brand/product register.
- Thread the four modes into the create-new routing note so the agent commits a mode per
  surface.

### E. Requirement #2 — auto-beauty in `prototype.md`

- Inline the full v4 **craft-floor** (Verify + Refuse + calibration) into `prototype.md`'s
  taste-rules section, so a create-new run is self-sufficiently held to the v4 bar.
- Add a lightweight **commit-the-world + direction-contract** step to the prototype
  Mandatory flow (a condensed `new-work` step: name the visual world and the first
  viewport before generating HTML), plus **prove-don't-claim**.
- `slides.md`: reference the same floor (keep its deck-specific rules intact).

### F. Skip (per convention — not relevant to this backend)

`ios, android, adapt.native, audit.native` (native app code), `init, hooks, live, doctor,
routing, codex`, and all `.mjs` scripts.

## Tests & release

- **`test/skills.test.ts`** — asserts `polish.description` matches `/quality pass/i`
  (v4 desc "Final quality pass before shipping" still matches), `polish.args` equals the
  `target` arg (preserve frontmatter), and `polish.content` contains the phrase
  `"final pass"` (ensure the v4 polish body still contains it, or update the assertion),
  and that no skill body contains `{{ask_instruction}}` after loading. Update as needed.
- **`test/system-prompt.test.ts`** — update any brand/product/register expectations to the
  mode framing; keep the existing prototype-routing regression assertions green.
- Remove references to the deleted `brand`/`product` skills anywhere in `test/`.
- Run `npm run lint && npm test && npm run build` in `pen-editor-backend`.
- Version: bump `pen-editor-backend` a **minor** version via `npm version` (annotated tag)
  per the ship-release convention; this is a feature-level change to the skill set.
- Update auto-memory: supersede `design-skills-impeccable-v391.md` with a v4 note
  (versions, retired brand/product → modes, craft-floor→frontend-design, auto-beauty in
  prototype).

## Execution plan

Land as one backend change (no cross-repo tool contract is touched — these are skills, not
`penTools`). Because it spans ~24 skill files plus system-prompt and tests, fan the body
re-ports out to subagents by group (per the `/auto` pattern), then converge:

1. Hub + floor: `frontend-design.md` (fold in craft-floor) + new `new-work.md`,
   `operate.md`, `visualize.md`.
2. Command-body ports (group the 20 skills across subagents), each applying D2.
3. Register retirement: delete brand/product, repoint handoffs, `craft.md` alias.
4. system-prompt.ts modes wiring + `prototype.md`/`slides.md` auto-beauty.
5. Tests, lint, build, `/code-review`, version bump, memory.

## Non-goals / explicitly deferred

- No backend equivalent of the "direction by dice" concept-seeding engine
  (`concept-seed.mjs`) or the `serve-question.mjs` browser decision page — philosophy only.
- No native (iOS/Android) skills.
- No Impeccable CLI infra (hooks/doctor/live/pin/detect).
