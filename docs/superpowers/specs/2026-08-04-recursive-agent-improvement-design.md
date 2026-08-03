# Recursive auto-improvement of the design agent

Date: 2026-08-04
Repos: `pen-editor-backend` (dry-run flag, shared preview module, probes file),
repo root `.claude/skills/` (the loop itself)

## Problem

The design agent is improved reactively. A defect ships to the gallery, someone
looks at the PNG, an incident is diagnosed, a paragraph lands in a skill. Nothing
re-checks the fix on the next run, and nothing checks that a fix for one defect
did not reintroduce another. There is no fixed yardstick, so there is no way to
say whether the agent is getting better.

The missing piece is a convergent loop: derive checkable expectations from the
agent's own spec, run the real agent, judge the artefacts, move exactly one lever
per failure, and re-run. Everything the loop needs already exists except the loop
— real headless runs (`showcase:generate`), full log visibility, mechanical
judging (`showcase:preview`), and a written spec (`src/skills/*.md`).

Reference: Ashpreet Bedi, "How to Recursively Improve Your Agents"
(<https://x.com/ashpreetbedi/status/2084301728363462919>). The idea taken from it
is the loop shape and the one-lever discipline; the Agno/AgentOS platform it is
built on is not relevant here.

## Scope

- A `/improve-design-agent` skill that runs the loop end to end.
- A `--dry-run=<dir>` mode for `showcase:generate`: real generation, no publish.
- A shared preview module so the dry-run and `showcase:preview` judge identically.
- A versioned probes file seeded from incidents we have already paid for.

Explicitly out of scope for this version: mining probes from traces
(`/analyze-insights` already does that job), auto-commit of skill edits, a nightly
cron, a run-history log in the repo, desktop-platform probes.

## The loop

```
probes/showcase-mobile.md  ─┐
src/skills/*.md (the spec)  ├─→ [1] select probes relevant to this run
past incidents             ─┘
        │
        ▼
[2] 3 × npm run showcase:generate -- --dry-run=<dir>   real OpenRouter turn
        │  HTML + PNG on disk; no S3, no rows in Postgres beyond the usual reads
        ▼
[3] judge, two layers:
      mechanical — size, bottom-edge clipping, dead space, blank mount
      by eye     — every PNG and the contact sheet, against each probe's expectation
        ▼
[4] one lever per failure: a single edit to a single skill file
        ▼
[5] re-run: the same three themes again, judging only the probes that failed
        ▼
exit when every probe is green, or after 3 iterations, or blocked → report + skill
diff; commit only after the user approves
```

Default budget: 3 runs per iteration, up to 3 iterations (~9 generations).
One run is too few to tell a systemic defect from model flakiness — a defect that
appears in one of three runs is reported as suspected, not fixed.

### Why dry-run is load-bearing

Without it the loop pushes nine half-finished apps into the live gallery and
spends S3 on them. The run itself stays real: same `prepareChatTurn`, same skills,
same model. Only publication is skipped.

### Why judging by eye is not optional

The header comment in `src/showcase/previewDiagnostics.ts` states the case
already: every defect that has actually shipped rendered at a perfect 780×1688
and passed every automated gate the pipeline had. A loop judged only
mechanically converges on green, not on good — and on skills, "good" is the whole
point. Mechanical checks gate the cheap failures; the eye judges the rest.

## Backend changes

1. **`--dry-run=<dir>` in `src/showcase/run.ts`.** After `runShowcaseGeneration`,
   write each screen as `NN-<slug>.html` into the directory, render and diagnose
   it through the shared module, print the same per-screen report
   `showcase:preview` prints, and skip `publishScreens` entirely. The theme and
   palette reads that precede generation stay as they are, so a dry run still
   avoids recently used themes and accents.
2. **Extract `src/showcase/previewScreens.ts`.** The loop in `previewRun.ts` —
   normalize, screenshot, write PNG, measure, collect notes — moves here and is
   called by both `previewRun.ts` and the dry-run branch. Without this the dry
   run and the preview can disagree in exactly the way the preview exists to
   catch.
3. **Tests.** Flag parsing in `test/showcase-cli-flags.test.ts`; the new module
   unit-tested without a browser, following `showcase-preview-diagnostics`'s
   existing pattern of keeping browser-free logic separable.

The judge-by-eye layer and the skill edits live in the skill, not in code.

## Probes

File: `pen-editor-backend/probes/showcase-mobile.md` — outside `src/` so the skill
loader never sees it and `tsc` never compiles around it.

Each probe is four fields:

```markdown
### P-014 the tab bar does not drift away from growing content
expectation: a pinned bottom bar is fully visible on every screen that has one
source: incident 2026-07-31 (the 844 box), prototype.md
judge: by eye
status: green as of 2026-08-04
```

`judge:` is `mechanical` or `by eye`, and decides which layer of step 3 rules on
it. `status:` is updated by the loop at the end of a session so the next session
can see convergence.

The seed set comes from incidents already paid for: the 844 box and the tab-bar
labels, a pinned bar vanishing under z-index, a blank mount when the asset wait
times out, an absolute `<img>` growing the screen, UA styles on unstyled
controls, the beige-terracotta palette bias, `batch_design` truncating on an
unescaped quote, and "a brief of prohibitions yields austere screens". About
10–12 probes. Every new failure is added permanently — this is the cheap form of
"turn failures into evals".

## Error handling and stopping

- A generation that dies mid-turn (the known `minimax-m3` flake: the turn ends
  before `batch_design` with `finishReason "other"`) is retried once, then
  recorded as an infrastructure failure, not a probe failure.
- A probe that fails for a reason no single lever can address is marked
  `blocked:` with the reason and left for the user; the loop does not invent a
  multi-file refactor to satisfy it.
- Skill edits are made in the working tree and left uncommitted. The loop ends
  with a report — probe, evidence, lever, file — and the diff.

## Testing

The backend changes are covered by the existing Vitest suite (flag parsing plus
the extracted module). The loop itself is not unit-tested: its output is a skill
diff reviewed by a human, and its correctness is exactly the thing the probes
measure.
