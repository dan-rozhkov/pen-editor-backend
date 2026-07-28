import type { Config } from "../config.js";
import { createPgPool, type TraceQueryable } from "../tracing/traceStore.js";

export interface ShowcaseScreenRow {
  id: string;
  runId: string;
  theme: string;
  title: string;
  prompt: string;
  model: string;
  imageUrl: string;
  // Half-width WebP variant and inline blurred placeholder. Optional: rows
  // published before the derivatives migration (or not yet backfilled by
  // `showcase:reencode`) simply don't have them.
  imageUrl1x?: string;
  lqip?: string;
  htmlUrl: string;
  width: number;
  height: number;
}

export interface ShowcaseScreen extends ShowcaseScreenRow {
  createdAt: string;
  pinned: boolean;
}

export interface ShowcaseStore {
  insertScreen(row: ShowcaseScreenRow): Promise<void>;
  listScreens(opts: {
    limit: number;
    cursor?: string;
  }): Promise<{ screens: ShowcaseScreen[]; nextCursor: string | null }>;
  recentThemes(limit: number): Promise<string[]>;
  // For `npm run showcase:rescreenshot` — the stored HTML is the source of
  // truth, so every screen can be re-rendered after a screenshot bug fix.
  listScreenSources(): Promise<ShowcaseScreenSource[]>;
  // For both `npm run showcase:rescreenshot` and `npm run showcase:reencode`
  // — the only way any code writes `image_url`. There is deliberately no
  // PNG-only "just update image_url" path: every writer that touches the
  // image goes through `buildDerivatives` and updates image_url,
  // image_url_1x, lqip and the dimensions together, so a stale @1x/LQIP can
  // never survive a repair.
  updateScreenDerivatives(update: ShowcaseDerivativesUpdate): Promise<void>;
  // For `npm run showcase:reencode` — every row's current image (2x URL, and
  // 1x if it already has one, to support `--force`) without the HTML/theme
  // fields `listScreenSources` carries, which reencode never touches.
  listScreenImages(): Promise<ShowcaseImageSource[]>;
  // Exclusive within the screen's own run_id: clears any existing pin for
  // that app before setting the new one, so "the first screen of this app" is
  // always at most one row and never needs reconciling. Other apps' pins are
  // untouched. Returns false (no-op) when `id` does not match any row.
  pinScreen(id: string): Promise<boolean>;
  // Clears every pin, or just one app's when `runId` is given.
  clearPin(runId?: string): Promise<void>;
  close(): Promise<void>;
}

export interface ShowcaseScreenSource {
  id: string;
  title: string;
  htmlUrl: string;
  width: number;
  height: number;
}

export interface ShowcaseDerivativesUpdate {
  id: string;
  imageUrl: string;
  imageUrl1x: string;
  lqip: string;
  // The dimensions of the *2x WebP* actually stored at `imageUrl` — not
  // necessarily the source PNG's. Callers (rescreenshot.ts, reencode.ts)
  // pass `derivatives.webp2x.{width,height}` here so the row always
  // describes the object it points at; the frontend builds srcset `w`
  // descriptors straight from these columns.
  width: number;
  height: number;
}

export interface ShowcaseImageSource {
  id: string;
  title: string;
  imageUrl: string;
  imageUrl1x?: string;
}

interface DecodedCursor {
  runSort: string;
  runId: string;
  pinned: boolean;
  createdAt: string;
  id: string;
}

// A cursor decodes to a real keyset position (`DecodedCursor`), or to
// `"legacy"` when it is a pre-per-app-pin cursor: those encoded a sort order
// (`pinned, created_at, id`) that no longer matches the feed's, and there is
// no way to translate a position in the old order into one in the new order.
// Restarting the request from the top of the feed is the only option that
// isn't a 400 for a page-2+ click in a tab that was already open — one
// repeated page beats an error.
type Decoded = DecodedCursor | "legacy";

function badCursor(): never {
  throw Object.assign(new Error("Invalid cursor"), { statusCode: 400 });
}

// Current format: `r2|<runSort>|<runId>|<p0|p1>|<createdAt>|<id>`, matching
// the ORDER BY column order (`run_sort, run_id, pinned, created_at, id`) so
// keyset pagination stays a single row-wise comparison. The `r2` tag lets
// this be told apart from the two older formats below without guessing from
// field count alone.
function decodeCursor(cursor: string): Decoded {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw badCursor();
  }
  const parts = decoded.split("|");

  // Pre-per-app-pin formats: 2 fields (`createdAt|id`) or 3 (`p0|p1` flag +
  // createdAt + id). Their *shape* is enough to recognize them — their
  // *values* described a sort order that's gone, so there is nothing to
  // validate or reuse; treat any 2-field cursor, or any 3-field cursor with a
  // valid pinned flag, as legacy without inspecting the rest.
  if (parts.length === 2) return "legacy";
  if (parts.length === 3) {
    const [flag] = parts;
    if (flag === "p0" || flag === "p1") return "legacy";
    badCursor();
  }

  if (parts.length !== 6) badCursor();
  const [tag, runSort, runId, flag, createdAt, id] = parts;
  if (tag !== "r2") badCursor();
  if (flag !== "p0" && flag !== "p1") badCursor();
  if (!runSort || !runId || !createdAt || !id) badCursor();
  // runSort/createdAt round-trip through Postgres `::text` at full
  // (microsecond) precision — e.g. `2026-07-28 13:30:57.663475+00`, space
  // separator, no `T`, no `Z` — rather than the millisecond-precision ISO
  // string `toIso()` produces. `Date.parse` still accepts that form (a
  // stable, if non-spec, V8 extension), so no loosening of this validation
  // was needed — it correctly keeps rejecting genuinely malformed values
  // (e.g. "not-a-date") while accepting both shapes.
  if (Number.isNaN(Date.parse(runSort))) badCursor();
  if (Number.isNaN(Date.parse(createdAt))) badCursor();
  return { runSort, runId, pinned: flag === "p1", createdAt, id };
}

function encodeCursor(fields: DecodedCursor): string {
  const { runSort, runId, pinned, createdAt, id } = fields;
  return Buffer.from(
    `r2|${runSort}|${runId}|${pinned ? "p1" : "p0"}|${createdAt}|${id}`,
    "utf8",
  ).toString("base64url");
}

interface ShowcaseScreenDbRow {
  id: string;
  run_id: string;
  theme: string;
  title: string;
  prompt: string;
  model: string;
  image_url: string;
  image_url_1x: string | null;
  lqip: string | null;
  html_url: string;
  width: number;
  height: number;
  created_at: string | Date;
  pinned_at: string | Date | null;
  run_sort: string | Date;
  // Full (microsecond) precision text form of the two columns above, used
  // only to build the keyset cursor. Postgres stores `created_at` — and
  // therefore the `run_sort` window aggregate derived from it — with
  // microsecond precision, but the JS `Date` values above (and `toIso()`)
  // truncate to milliseconds. Building the cursor from the truncated value
  // made it compare as *smaller* than the real column value, so every
  // remaining row of the run the page ended in (they all share that run's
  // `run_sort`) failed the `< cursor` predicate on the very first tuple
  // element and was silently dropped. See
  // docs/superpowers/specs/2026-07-28-showcase-per-app-pin-design.md.
  created_at_text: string;
  run_sort_text: string;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ShowcaseScreenDbRow): ShowcaseScreen {
  return {
    id: row.id,
    runId: row.run_id,
    theme: row.theme,
    title: row.title,
    prompt: row.prompt,
    model: row.model,
    imageUrl: row.image_url,
    // NULL -> undefined, not null: `ShowcaseScreenRow`/`ShowcaseScreen` model
    // "not backfilled yet" as an absent field, matching how `insertScreen`
    // and the API response treat it.
    imageUrl1x: row.image_url_1x ?? undefined,
    lqip: row.lqip ?? undefined,
    htmlUrl: row.html_url,
    width: row.width,
    height: row.height,
    createdAt: toIso(row.created_at),
    pinned: row.pinned_at !== null,
  };
}

export function createShowcaseStore(
  config: Config,
  pool?: TraceQueryable,
): ShowcaseStore | null {
  if (!config.TRACE_DATABASE_URL) return null;
  const db: TraceQueryable = pool ?? createPgPool(config.TRACE_DATABASE_URL);

  return {
    async insertScreen(row) {
      await db.query(
        `INSERT INTO showcase_screens
           (id, run_id, theme, title, prompt, model, image_url, image_url_1x, lqip, html_url, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          row.id,
          row.runId,
          row.theme,
          row.title,
          row.prompt,
          row.model,
          row.imageUrl,
          row.imageUrl1x ?? null,
          row.lqip ?? null,
          row.htmlUrl,
          row.width,
          row.height,
        ],
      );
    },

    async listScreens({ limit, cursor }) {
      const params: unknown[] = [];
      let cursorClause = "";
      if (cursor) {
        const decoded = decodeCursor(cursor);
        // A legacy cursor describes a position in a sort order that no
        // longer exists — there is nothing to translate, so this page is
        // served as if no cursor had been given at all (see decodeCursor).
        if (decoded !== "legacy") {
          const { runSort, runId, pinned, createdAt, id } = decoded;
          params.push(runSort, runId, pinned, createdAt, id);
          // Row-wise comparison against all five sort keys at once, not five
          // ANDed columns: a naive `ORDER BY` swap would put a screen back on
          // a later page merely because some earlier key tied. `false <
          // true` in Postgres, so this stays consistent with the
          // `(pinned_at IS NOT NULL) DESC` ordering below.
          cursorClause = `WHERE (run_sort, run_id, (pinned_at IS NOT NULL), created_at, id) < ($${params.length - 4}::timestamptz, $${params.length - 3}::uuid, $${params.length - 2}::boolean, $${params.length - 1}::timestamptz, $${params.length}::uuid)`;
        }
      }
      params.push(limit);
      // The window function has to be computed before it can be filtered on,
      // so the projection (including `published = true`) lives in a
      // subselect and the keyset predicate applies outside it.
      const sql = `SELECT id, run_id, theme, title, prompt, model, image_url, image_url_1x, lqip, html_url, width, height, created_at, pinned_at, run_sort,
                          created_at::text AS created_at_text, run_sort::text AS run_sort_text
                   FROM (
                     SELECT id, run_id, theme, title, prompt, model, image_url, image_url_1x, lqip, html_url, width, height, created_at, pinned_at,
                            MAX(created_at) OVER (PARTITION BY run_id) AS run_sort
                     FROM showcase_screens
                     WHERE published = true
                   ) feed
                   ${cursorClause}
                   ORDER BY run_sort DESC, run_id DESC, (pinned_at IS NOT NULL) DESC, created_at DESC, id DESC
                   LIMIT $${params.length}`;
      const result = (await db.query(sql, params)) as {
        rows: ShowcaseScreenDbRow[];
      };
      const screens = result.rows.map(mapRow);
      const lastRow = result.rows[result.rows.length - 1];
      const nextCursor =
        screens.length === limit && screens.length > 0
          ? encodeCursor({
              // Full-precision text, not `toIso(lastRow.run_sort)` /
              // `screens[...].createdAt` — those truncate to milliseconds
              // and must never feed the cursor (see the comment on
              // `ShowcaseScreenDbRow.created_at_text`/`run_sort_text`). The
              // display `createdAt` on `screens[...]` stays
              // millisecond-precision ISO; only the cursor needs the raw
              // text form.
              runSort: lastRow.run_sort_text,
              runId: screens[screens.length - 1].runId,
              pinned: screens[screens.length - 1].pinned,
              createdAt: lastRow.created_at_text,
              id: screens[screens.length - 1].id,
            })
          : null;
      return { screens, nextCursor };
    },

    async recentThemes(limit) {
      const result = (await db.query(
        `SELECT theme, MAX(created_at) AS last_seen
           FROM showcase_screens
           GROUP BY theme
           ORDER BY last_seen DESC
           LIMIT $1`,
        [limit],
      )) as { rows: Array<{ theme: string }> };
      return result.rows.map((r) => r.theme);
    },

    async listScreenSources() {
      // Oldest first, and unpublished rows included: a re-render is a repair of
      // whatever is stored, not a feed the visitor sees.
      const result = (await db.query(
        `SELECT id, title, html_url, width, height
           FROM showcase_screens
           ORDER BY created_at ASC, id ASC`,
        [],
      )) as {
        rows: Array<{
          id: string;
          title: string;
          html_url: string;
          width: number;
          height: number;
        }>;
      };
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        htmlUrl: row.html_url,
        width: row.width,
        height: row.height,
      }));
    },

    async updateScreenDerivatives({ id, imageUrl, imageUrl1x, lqip, width, height }) {
      await db.query(
        `UPDATE showcase_screens SET image_url = $2, image_url_1x = $3, lqip = $4, width = $5, height = $6 WHERE id = $1`,
        [id, imageUrl, imageUrl1x, lqip, width, height],
      );
    },

    async listScreenImages() {
      const result = (await db.query(
        `SELECT id, title, image_url, image_url_1x
           FROM showcase_screens
           ORDER BY created_at ASC, id ASC`,
        [],
      )) as {
        rows: Array<{
          id: string;
          title: string;
          image_url: string;
          image_url_1x: string | null;
        }>;
      };
      return result.rows.map((r) => ({
        id: r.id,
        title: r.title,
        imageUrl: r.image_url,
        imageUrl1x: r.image_url_1x ?? undefined,
      }));
    },

    async pinScreen(id) {
      // Existence is checked up front so an unknown id is reported as such:
      // the CASE-WHEN update below matches on `pinned_at IS NOT NULL OR id =
      // $1`, which would otherwise happily clear the current pin and report
      // success for an id that clearing every row already meant no-oping on.
      // It also gives us the run_id, which scopes the update below to this
      // screen's own app.
      const existing = (await db.query(
        "SELECT run_id FROM showcase_screens WHERE id = $1",
        [id],
      )) as { rows: Array<{ run_id: string }> };
      if (existing.rows.length === 0) return false;
      const runId = existing.rows[0].run_id;

      // Clear-then-set in one round trip rather than two statements: a crash
      // between them would otherwise leave the run with either zero or two
      // pins, both of which break the "at most one cover per app" invariant.
      // Scoping to `run_id = $2` is what keeps this from touching — or even
      // reading past — any other app's pin.
      await db.query(
        `UPDATE showcase_screens SET pinned_at = CASE WHEN id = $1 THEN now() ELSE NULL END
           WHERE run_id = $2 AND (pinned_at IS NOT NULL OR id = $1)`,
        [id, runId],
      );
      return true;
    },

    async clearPin(runId) {
      if (runId) {
        await db.query(
          "UPDATE showcase_screens SET pinned_at = NULL WHERE pinned_at IS NOT NULL AND run_id = $1",
          [runId],
        );
        return;
      }
      await db.query(
        "UPDATE showcase_screens SET pinned_at = NULL WHERE pinned_at IS NOT NULL",
        [],
      );
    },

    close: () => db.end(),
  };
}
