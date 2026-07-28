# Showcase: per-app pinned screen

Supersedes the global pin from `2026-07-28-showcase-pinned-screen-design.md`.

## Problem

`pinned_at` is exclusive across the whole table: pinning a screen made it the
first row of the entire feed, and every new pin silently unpinned the previous
one. What is actually wanted is a **cover per app** — each run (`run_id`) may
designate one screen that opens its carousel. Feed order between apps stays
chronological.

This also fixes `--cover=<n>` at publish time, which read as "cover of this
run" but in practice stole the single global pin from whatever run had it.

## Design

### Data

`pinned_at TIMESTAMPTZ` stays; its exclusivity scope moves from the table to
the run. Migration `005_showcase_pin_per_run.sql`:

- partial unique index on `run_id WHERE pinned_at IS NOT NULL` — at most one
  pin per app, enforced by the database, not by convention;
- index supporting the new ordering;
- drops the old `showcase_screens_published_pinned_idx` (its leading
  `(pinned_at IS NOT NULL) DESC` no longer matches any query).

Migrations are applied at server startup by `startupMigrations.ts` — the new
file needs no extra wiring beyond being in the directory.

### Ordering (`store.listScreens`)

Two levels:

1. apps by recency — `MAX(created_at) OVER (PARTITION BY run_id)` as
   `run_sort`, then `run_id` as a tiebreak;
2. inside an app — `(pinned_at IS NOT NULL) DESC, created_at DESC, id DESC`.

All keys descending, so keyset pagination keeps using one row-wise `<`
comparison. A side effect worth having: screens of one run are now guaranteed
contiguous in the feed instead of merely usually contiguous, so
`groupScreensByApp` on the client never has to stitch a run split by unrelated
rows.

Because the window function has to be computed before it can be filtered on,
the query wraps the projection in a subselect and applies the cursor predicate
outside it.

### Cursor

New format: `r2|<runSort>|<runId>|<p0|p1>|<createdAt>|<id>`, base64url. The
older 2- and 3-field formats describe a different sort order and cannot be
translated; they are accepted and ignored (the request restarts from the top
of the feed). They only ever appear in tabs opened before this shipped, where
one repeated page is a better outcome than a 400.

### Pinning

- `pinScreen(id)` — clear-then-set within that screen's `run_id` only, one
  statement. Committed state is always at most one pin per run — the unique
  index is the backstop. Two concurrent `pinScreen` calls for the same run
  targeting different currently-unpinned screens don't block each other (each
  statement matches a disjoint set of rows), so the second commit can still
  hit a `unique_violation`; that fails loudly (caught by `runAsScript`,
  printed, exit 1) and the CLI invocation can simply be re-run. That's
  accepted, not fixed.
- `clearPin(runId?)` — all pins, or one app's pin.

### CLI (`npm run showcase:pin`)

- `--screen <id>` — pin as that app's cover.
- `--clear` — clear every pin; `--clear --run <runId>` — clear one app's.
- `--list` (default) — screens in feed order, grouped by app, pinned marked.

`--screen`, `--clear` and `--list` stay mutually exclusive; `--run` is only
valid with `--clear`.

### API and client

`GET /api/showcase` is unchanged in shape — the pin is expressed purely as
row order, and `ShowcaseAppCarousel` already renders `app.screens` in feed
order, so the first slide follows automatically. No frontend change.

## Testing

- store: within-run pin order, app order by recency, pagination across a page
  boundary that splits a run, legacy cursor restarts from the top, pin
  exclusivity is per run and leaves other runs' pins alone;
- `resolvePinAction`: `--run` accepted only with `--clear`, mutual exclusion,
  limit validation;
- route: existing tests keep passing against the new store shape.

## Trade-off accepted

There is no longer a way to promote an app to the front of the feed; ordering
between apps is always chronological.
