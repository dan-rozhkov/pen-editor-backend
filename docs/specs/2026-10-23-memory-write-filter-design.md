# Memory write filter on System One

## Why

The `memory` tool writes entries that are injected into every system prompt and
live forever (no TTL; the only repair is the CLI curator). Models save one-off
task details and restate facts already stored. A cheap System One check before
an `add` is written keeps the stores compact.

## Questions

One `client.evaluate` call per tool call, at most `MAX_FILTERED_ADDS = 8` adds
(the first 8; later adds are kept unasked). State:
`{ target, existing_entries: string[], new_entries: [{ text }] }`. Everything is
passed through `scrubPii` and cut to 600 characters. Entries may be in any
language; the questions are English.

- `durable_<i>` (Noul): is `new_entries[i].text` a durable fact that stays
  useful in a future, unrelated conversation, not a one-off detail of the
  current task? `target: user` asks about identity, role, preferences, working
  style; `target: memory` asks about environment, conventions, tool quirks,
  lessons.
- `duplicate_<i>` (Noul): does an entry in `existing_entries` already state the
  same fact (same meaning, other words)? Asked only when the existing list is
  non-empty. Existing entries exclude any entry exactly equal (trimmed) to one
  of the new texts (exact repeats are already a no-op in `apply.ts`) and any
  entry containing the trimmed `old_text` of a `remove`/`replace` in the same
  batch: that entry is being rewritten by this call, so it cannot count as
  "already stored". Without this, consolidating `[remove 'prefers dark UI',
  add 'prefers dark UI and dark themes']` would drop the add as a duplicate
  and lose the fact.

## Thresholds

- `MEMORY_FILTER_DURABLE_MIN` (0.3): not durable when durable Noul is BELOW it.
  Conservative: only a confident no drops; about 0.5 means unsure, keep.
- `MEMORY_FILTER_DUPLICATE_MIN` (0.7): duplicate when duplicate Noul is AT OR
  ABOVE it.

A missing answer (vendor refused: key absent) means unknown and never drops.

## Modes

`MEMORY_FILTER_MODE`: `off` (default; no vendor call, no snapshot read,
byte-identical behaviour), `shadow`, `enforce`.

- enforce: load snapshot (bounded by `MEMORY_SNAPSHOT_TIMEOUT_MS`, the same
  2000 ms as the prompt snapshot read), await the filter (`MEMORY_FILTER_TIMEOUT_MS`, 2000),
  remove dropped adds, apply the rest. Nothing left: the store is not called and
  the tool returns `{ ok: true, saved: false, message, skipped }`. Otherwise the
  normal success result gains `skipped: [{ content, reason }]` and a message
  telling the model not to retry. A partial drop is not a failure. When the
  filter drops EVERY op, `ctx.failures.count` is incremented, so
  `MEMORY_MAX_FAILURES` stops a model that keeps retrying the same rejected
  entries. The tool call's `abortSignal` is passed to the vendor call.
- shadow: the write is exactly as before. The snapshot read is awaited (same
  timeout) BEFORE the write, so the judgement sees pre-write state; only the
  vendor call is detached (`MEMORY_FILTER_SHADOW_TIMEOUT_MS`, 10000) and only
  logs. The abort signal is not passed: an aborted request must not censor the
  measurement. `wouldDrop` is computed by the same function enforce uses to
  decide drops, including the referenced-add rule below.
- no TypeSafe client in a non-off mode: log `no-client`, write as usual.

## Fail-open

Snapshot read error or timeout (logged with outcome `failed` in both modes,
then written unfiltered), vendor error, timeout, missing answers, adds beyond the
cap: every one of them keeps the entry. The module never throws.

## Referenced-add rule

`replace`/`remove` pass through. If a later op in the same batch has an
(trimmed) `old_text` that is a substring of a dropped add's content, the add is kept:
otherwise that op fails with `no_match` and the atomic batch dies.

## Out of scope

`replace` content is not judged on purpose: replace is the consolidation path,
and judging it could block merging entries.

## Log format

One line per filtered call, never entry contents:
`[memoryFilter] {"mode","origin","target","adds","asked","wouldDrop","dropped","outcome","verdicts":[{"durable","duplicate","drop"}]}`.
Probabilities are rounded to 2 decimals; `dropped` is 0 in shadow. Outcomes:
`asked | nothing-to-ask | no-client | failed`.

## Rollout

1. Ship with `off`.
2. Set `shadow` on Render; read the `[memoryFilter]` lines (Russian entries are
   the risk: Jev is trained mostly on English). Check the `wouldDrop` share and
   the verdict spread against real entries; tune the two thresholds.
3. Switch to `enforce` once `wouldDrop` entries look right.
