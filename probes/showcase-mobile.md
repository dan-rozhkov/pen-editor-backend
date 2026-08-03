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
