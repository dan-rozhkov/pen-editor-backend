# Showcase probes — mobile

The fixed yardstick for `/improve-design-agent`. Each probe is one checkable
expectation drawn from the agent's own spec (`src/skills/*.md`) or from a defect
that already shipped. The set only grows: a failure that gets fixed stays here
so the next loop re-checks it.

Lives outside `src/` on purpose — `src/skills/` is loaded by `src/ai/skills.ts`
at startup, and a probe file in there would be advertised to the model as a
skill.

**Fields.** `expectation` is one line a judge can rule on. `source` is where the
expectation came from — a skill file, a pipeline invariant, or a dated
incident; a probe sourced from a real incident is evidence, not opinion, and
must not be softened later by someone who does not remember the incident.
`judge` is `mechanical` (`showcase:preview` / the dry run reports it) or
`by eye` (someone looks at the PNG). `status` is updated at the end of a loop
session.

---

### P-001 every screen renders in the box
expectation: every screen is exactly 780x1688 device px
source: pipeline invariant (`src/showcase/platform.ts`)
judge: mechanical
status: unknown

### P-002 nothing is sliced by the bottom edge
expectation: no leaf element is cut by the bottom of the screen
source: incident — a shelf published with its captions shaved off at a perfect 780x1688
judge: mechanical
status: unknown

### P-003 no screen ends in a band of nothing
expectation: less than 160 CSS px of bare background at the foot of the screen
source: `src/skills/prototype.md` ("no screen ends in 200px of dead space")
judge: mechanical
status: unknown

### P-004 the mount is never blank
expectation: no screen renders as a single uniform colour
source: incident — the render-ready wait timed out on heavy photos and published an empty mount
judge: mechanical
status: unknown

### P-005 the pinned bottom bar keeps its labels
expectation: nothing in the pinned bottom bar is clipped or dropped to fit
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
expectation: the screen count in the run log matches the number the agent described in its own turn — the judge reads the run log, not the PNGs, and there is no mechanical check for this: the dry run only ever prints its own count, so absence of a note is not evidence
source: incident — `extractEmbeds` truncated a batch at an unescaped quote and published blank screens; split from the original probe, which also asserted no screen is blank — that half is already covered by P-004
judge: by eye
status: unknown

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

### P-013 the pinned bottom bar renders at its full intended height
expectation: the pinned bottom bar is not compressed below its intended height
source: incident 2026-07-31 — the 844 box fails three quiet ways at once; split from P-005
judge: by eye
status: unknown

### P-014 content above the pinned bar respects the box
expectation: content above the pinned bottom bar neither overflows behind it nor pushes the screen past the box
source: incident 2026-07-31 — the 844 box fails three quiet ways at once; split from P-005
judge: by eye
status: unknown

### P-015 the run commits to one navigation shell
expectation: every screen shares the `SHELL:` declared in the direction contract (TabBar / Stack / Hub / Single-view / Feed); a TabBar carries 3–5 genuinely peer destinations, and a single-task app (calculator, timer, one form) has no tab bar at all
source: `src/skills/prototype.md` ("Navigation shell"), ported from OJO Design Skills' navigation-shell selection
judge: by eye
status: unknown

### P-016 no unfilled placeholder copy
expectation: no lorem, John Doe / Acme / example.com, literal "Title"/"Card" labels, a timestamp or round metric repeated 3+ times, or a generic CTA (Submit / Continue / Learn More) reused on one screen
source: `src/showcase/htmlAudit.ts` (honest-copy triggers ported from OJO Design Skills' anti-patterns)
judge: mechanical
status: unknown

### P-017 no device chrome drawn into the screen
expectation: no hardcoded clock + signal/battery glyph row, no wifi + battery cluster, no pill home indicator, no phone bezel around the 390x844 box
source: `src/showcase/htmlAudit.ts` (re-drawn-chrome triggers) and `src/skills/prototype.md` ("NO device/OS chrome")
judge: mechanical
status: unknown

### P-018 register declared with evidence and honoured
expectation: a `REGISTER:` line is present in the direction contract with all five dials (Energy/Finish/Density/Weight/Seriousness) and a short evidence phrase; the built screens match the declared values rather than defaulting to a house look
source: `src/skills/prototype.md` ("Register"), ported from OJO Design Skills' Style Register Derivation
judge: by eye
status: unknown

### P-019 track declared and fitting
expectation: a `TRACK:` line is present in the direction contract; utility themes (dashboards, admin, settings, utilities, trackers, calculators, B2B tools, forms, docs) land on Convention with a named reference language recognisable in the screens; brand-experience themes (social, commerce, lifestyle, entertainment, creative tools) land on Innovation
source: `src/skills/prototype.md` ("Decide the TRACK"), ported from OJO Design Skills' Step 0 Product Type Assessment
judge: by eye
status: unknown
