# Showcase filters and likes

Date: 2026-07-29
Repos: `pen-editor-backend` (feed, likes, migration), `pen-editor` (filter row, like button)

## Problem

The showcase at `/` is one flat feed: every published app, newest first, no way
to narrow it and no way for a visitor to say they like something. Two things are
missing — a way to browse by what the app *is about*, and a signal of what people
actually like, which should also become the default order.

Mobbin's discover header is the reference: a sort tab group, a divider, then a
horizontally scrolling row of category chips.

## Scope

- A filter row above the grid: sort tabs (`Most popular` / `Latest`) + category chips.
- **Default sort is `Most popular`.**
- Filter state lives in the URL query string.
- Likes: unlimited "claps" per visitor, no dedup, per app.

Explicitly out of scope: Sites/desktop tab (no desktop screens exist), Top rated
(no rating signal), filtering by model, per-screen likes.

## UX

```
Most popular   Latest   │   [All] [mobile banking] [fitness tracker] [food delivery] →
━━━━━━━━━━━━
```

- Sort tabs on the left, underline on the active one.
- Category chips right of a vertical divider, horizontally scrollable
  (`scrollbar-none`, same treatment as the app carousel), `All` first.
- The chip list is **only themes present in the database**, ordered by app count
  descending. No chip ever leads to an empty grid, and hand-run themes that were
  never in `SHOWCASE_THEMES` show up automatically.
- URL: `/?sort=latest&category=mobile%20banking`. The defaults (`popular`, no
  category) write **no** query params, so the canonical URL stays `/`.
  `useSearchParams` is the single source of truth — no duplicated local state.
- Changing a tab or chip resets the cursor and refetches page 1. The filter row
  stays mounted; the skeleton grid renders below it.
- A category with no apps renders an empty state with a "Show all" reset.

## Data model

New table, not a column on `showcase_screens`: a like belongs to an *app*
(`run_id`), which is 5 screen rows. A column would mean five row updates per
increment and an ambiguous "which screen's counter is authoritative".

```sql
-- src/analysis/migrations/007_showcase_likes.sql
CREATE TABLE IF NOT EXISTS showcase_app_likes (
  run_id     UUID PRIMARY KEY,
  likes      BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Migrations already apply at server startup (`src/startupMigrations.ts`), so a
route reading the new table cannot outrun its schema.

## API

### `GET /api/showcase`

New query params, both optional:

- `sort`: `popular` (default) | `latest`
- `category`: a theme string; absent means all

The `runs` subquery gains `LEFT JOIN showcase_app_likes` →
`COALESCE(likes, 0) AS run_likes`, and the category filter applies there (a run
has exactly one theme, so filtering the runs fully determines the output).

- `latest`: `ORDER BY run_sort DESC, run_id DESC` — unchanged, cursor stays `a1|…`.
- `popular`: `ORDER BY run_likes DESC, run_sort DESC, run_id DESC`, cursor
  `l1|<likes>|<runSort>|<runId>` with a **row-wise tuple comparison**
  `(run_likes, run_sort, run_id) < (…)`. ANDed columns would return apps tied on
  like count on more than one page.

`run_sort` in the cursor keeps coming from `::text` at full microsecond
precision. Building it from a JS `Date` truncates to milliseconds, compares as
smaller than the real column value, and silently drops every remaining row of
the run the page ended in — the bug fixed in the per-app-pin work.

The cursor carries its sort tag. A cursor whose tag disagrees with the request's
`sort` is ignored and the page is served from the top — the same choice already
made for legacy cursors, and better than a 400 for a stale open tab.

Each app in the response gains `likes: number`.

Likes placed between two page requests can, rarely, duplicate or skip a card at
a page boundary. Accepted deliberately; the alternative is snapshotting the
ordering, which this feature does not justify.

### `GET /api/showcase/categories`

`{ categories: [{ theme, apps }] }` over published rows, ordered by `apps` desc.

### `POST /api/showcase/:runId/like`

Body `{ count: number }`, 1..25. `INSERT … ON CONFLICT (run_id) DO UPDATE SET
likes = showcase_app_likes.likes + $2, updated_at = now()`, returns
`{ likes: <new total> }`. 404 when the run has no published screens.

No per-visitor dedup — claps are meant to be repeatable. The 1..25 bound exists
solely so a single request cannot post `count: 1e9`; it is not a rate limit.

## Like button (frontend)

- Heart + count, **bottom-right of the card panel**, always visible. The
  carousel arrows are hover-only, which does not exist on touch; the dots
  (top-right) and model label (bottom-centre) already own their corners.
- A click increments a local counter immediately. The accumulated delta is
  POSTed once, debounced ~700 ms, and also flushed on `visibilitychange` and on
  unmount — a burst of claps must not be a burst of requests.
- A failed request rolls back only the unconfirmed delta.
- A filled heart means "I have clapped this app before": a set of `runId`s in
  `localStorage`. Cosmetic only; it never affects the counter or the ordering.
- The grid does **not** re-sort under the cursor while clapping. A new order
  appears on the next load or tab switch.

## Testing

Backend:
- `test/showcase-store.test.ts` — popular ordering, tie-break, a cursor crossing
  a boundary between apps with equal like counts, category filtering. Assert
  against the real query, not a fake SQL matcher: a matcher that doesn't mirror
  the production statement makes the test a tautology.
- `test/showcase-route.test.ts` — `sort`/`category` validation, `likes` in the
  response, the like endpoint (count bound, 404, increment), the categories
  endpoint.

Frontend:
- Filter row: clicking a tab/chip produces the right request params and URL.
- State restored from the URL on load (including a category not in the chip list).
- Like button: optimistic increment, one debounced request per burst, rollback
  on failure.

## Merge order

Backend first (migration + endpoints), frontend second. The tool-contract rule
does not formally apply here, but the frontend cannot work against a feed that
lacks `sort` and `likes`.
