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

/** One app — every screen of a single `showcase:generate`/`showcase:ingest`
 * run, in display order (pinned cover first, then newest). The gallery's unit
 * of display *and* of pagination: a page never contains half an app. */
export interface ShowcaseApp {
  runId: string;
  theme: string;
  model: string;
  // The app's own recency — MAX(created_at) across its screens, which is also
  // what the feed sorts on.
  createdAt: string;
  screens: ShowcaseScreen[];
}

export interface ShowcaseStore {
  insertScreen(row: ShowcaseScreenRow): Promise<void>;
  // `limit` counts *apps*, not screens: the gallery renders one card per app,
  // so a page measured in screens would cut an app in half at the page
  // boundary and show a carousel that silently grows when the visitor clicks
  // "Show more". Screens per app are unbounded in the type but bounded in
  // practice (a run publishes at most 5).
  listApps(opts: {
    limit: number;
    cursor?: string;
  }): Promise<{ apps: ShowcaseApp[]; nextCursor: string | null }>;
  recentThemes(limit: number): Promise<string[]>;
  // For `npm run showcase:rescreenshot` — the stored HTML is the source of
  // truth, so every screen can be re-rendered after a screenshot bug fix.
  // `appOf` narrows the sweep to one app: it takes either a run_id or the id
  // of any screen in that run, because in practice you spot the problem on a
  // single screen in the gallery but want its whole carousel re-rendered
  // consistently (a run with half-old, half-new screenshots looks worse than
  // one that is uniformly stale).
  listScreenSources(options?: { appOf?: string }): Promise<ShowcaseScreenSource[]>;
  // For `npm run showcase:replace-html` — one screen by id, or null when the
  // id matches nothing.
  getScreenSource(id: string): Promise<ShowcaseScreenSource | null>;
  // For `npm run showcase:replace-html` — repoints a screen at freshly
  // uploaded HTML. Always a *new* key rather than an overwrite: showcase
  // objects are served `immutable` for a year (services/s3.ts), so writing
  // different bytes under the old key would leave caches serving the broken
  // markup indefinitely.
  updateScreenHtmlUrl(id: string, htmlUrl: string): Promise<void>;
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
  // For `npm run showcase:delete` — removes a whole app (`appOf`, resolved
  // from either a run_id or any screen id in it, same as `listScreenSources`)
  // or a single screen. Returns the rows that were actually deleted, so the
  // caller can report them and tell "nothing matched" apart from success.
  // Deliberately DB-only: the S3 objects behind image_url/html_url are served
  // `immutable` for a year and cost nothing to keep, while deleting them
  // would make a mistaken run unrecoverable.
  deleteScreens(target: DeleteTarget): Promise<ShowcaseDeletedScreen[]>;
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

export type DeleteTarget = { appOf: string } | { screen: string };

export interface ShowcaseDeletedScreen {
  id: string;
  runId: string;
  title: string;
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
}

// A cursor decodes to a real keyset position (`DecodedCursor`), or to
// `"legacy"` when it predates app-wise pagination. Every older format
// addressed a *screen* inside the feed; a page is now a whole number of apps,
// and the screen a legacy cursor names may well sit in the middle of one, so
// there is no position to translate it to. Restarting from the top of the
// feed is the only option that isn't a 400 for a "Show more" click in a tab
// that was already open — one repeated page beats an error.
type Decoded = DecodedCursor | "legacy";

function badCursor(): never {
  throw Object.assign(new Error("Invalid cursor"), { statusCode: 400 });
}

// Current format: `a1|<runSort>|<runId>`, matching the app-level ORDER BY
// (`run_sort, run_id`) so keyset pagination stays a single row-wise
// comparison. Screen-level keys (pinned/created_at/id) are deliberately gone:
// the page boundary now falls between apps, never inside one.
function decodeCursor(cursor: string): Decoded {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw badCursor();
  }
  const parts = decoded.split("|");

  // Screen-addressing formats: 2 fields (`createdAt|id`), 3 (`p0|p1` flag +
  // createdAt + id) or 6 (`r2|…`). Their *shape* is enough to recognize them
  // — their *values* addressed a granularity that's gone, so there is nothing
  // to validate or reuse.
  if (parts.length === 2) return "legacy";
  if (parts.length === 6) {
    if (parts[0] === "r2") return "legacy";
    badCursor();
  }
  if (parts.length !== 3) badCursor();

  const [tag, runSort, runId] = parts;
  // The three-field shape is shared with the oldest format (`p0|p1` flag +
  // createdAt + id), so the leading field is what tells them apart.
  if (tag === "p0" || tag === "p1") return "legacy";
  if (tag !== "a1") badCursor();
  if (!runSort || !runId) badCursor();
  // runSort round-trips through Postgres `::text` at full (microsecond)
  // precision — e.g. `2026-07-28 13:30:57.663475+00`, space separator, no
  // `T`, no `Z` — rather than the millisecond-precision ISO string `toIso()`
  // produces. Truncating it to milliseconds would make the cursor compare as
  // *smaller* than the real column value and silently drop the run it points
  // just past. `Date.parse` accepts that form (a stable, if non-spec, V8
  // extension), so this validation still rejects genuinely malformed values
  // while accepting both shapes.
  if (Number.isNaN(Date.parse(runSort))) badCursor();
  return { runSort, runId };
}

function encodeCursor(fields: DecodedCursor): string {
  const { runSort, runId } = fields;
  return Buffer.from(`a1|${runSort}|${runId}`, "utf8").toString("base64url");
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

    async listApps({ limit, cursor }) {
      const params: unknown[] = [];
      let cursorClause = "";
      if (cursor) {
        const decoded = decodeCursor(cursor);
        // A legacy cursor addresses a single screen, a granularity this feed
        // no longer paginates by — there is nothing to translate, so this
        // page is served as if no cursor had been given (see decodeCursor).
        if (decoded !== "legacy") {
          const { runSort, runId } = decoded;
          params.push(runSort, runId);
          // Row-wise comparison against both app-level sort keys at once, not
          // two ANDed columns: with `AND` an app whose `run_sort` ties the
          // cursor's would come back on a later page too.
          //
          // `HAVING`, not `WHERE`: `run_sort` is the MAX aggregate this very
          // query computes, so it does not exist yet at WHERE time.
          cursorClause = `HAVING (MAX(created_at), run_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
        }
      }
      params.push(limit);
      // Two stages, and the split is the whole point: `runs` picks exactly
      // `limit` *apps* by their recency, then the outer select takes every
      // screen belonging to them. Paginating the screens directly (what this
      // used to do) let a page boundary fall inside an app, so the gallery —
      // which renders one card per app — showed a carousel missing its last
      // screens until the visitor happened to click "Show more".
      const sql = `SELECT s.id, s.run_id, s.theme, s.title, s.prompt, s.model, s.image_url, s.image_url_1x, s.lqip, s.html_url, s.width, s.height, s.created_at, s.pinned_at,
                          runs.run_sort, s.created_at::text AS created_at_text, runs.run_sort::text AS run_sort_text
                   FROM showcase_screens s
                   JOIN (
                     SELECT run_id, MAX(created_at) AS run_sort
                     FROM showcase_screens
                     WHERE published = true
                     GROUP BY run_id
                     ${cursorClause}
                     ORDER BY run_sort DESC, run_id DESC
                     LIMIT $${params.length}
                   ) runs ON runs.run_id = s.run_id
                   WHERE s.published = true
                   ORDER BY runs.run_sort DESC, s.run_id DESC, (s.pinned_at IS NOT NULL) DESC, s.created_at DESC, s.id DESC`;
      const result = (await db.query(sql, params)) as {
        rows: ShowcaseScreenDbRow[];
      };

      // Rows arrive already grouped by app (the ORDER BY leads with the app
      // keys), so a single pass in feed order rebuilds the apps without
      // re-sorting anything.
      const apps: ShowcaseApp[] = [];
      const byRun = new Map<string, ShowcaseApp>();
      let lastRunSortText = "";
      for (const row of result.rows) {
        const screen = mapRow(row);
        let app = byRun.get(row.run_id);
        if (!app) {
          app = {
            runId: row.run_id,
            // Theme and model are per-run in practice (one generate/ingest
            // run writes one theme and one model to every screen it
            // publishes), so the first screen's values describe the app.
            theme: row.theme,
            model: row.model,
            createdAt: toIso(row.run_sort),
            screens: [],
          };
          byRun.set(row.run_id, app);
          apps.push(app);
        }
        app.screens.push(screen);
        lastRunSortText = row.run_sort_text;
      }

      const nextCursor =
        apps.length === limit && apps.length > 0
          ? encodeCursor({
              // Full-precision text, not `toIso(...)`/`app.createdAt` — those
              // truncate to milliseconds and must never feed the cursor (see
              // the comment on `ShowcaseScreenDbRow.run_sort_text`). The
              // display `createdAt` stays millisecond-precision ISO.
              runSort: lastRunSortText,
              runId: apps[apps.length - 1].runId,
            })
          : null;
      return { apps, nextCursor };
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

    async listScreenSources(options) {
      // Oldest first, and unpublished rows included: a re-render is a repair of
      // whatever is stored, not a feed the visitor sees.
      const appOf = options?.appOf;
      // COALESCE resolves the argument as a screen id first and falls back to
      // treating it as a run_id, so callers can pass whichever one they have.
      const where = appOf
        ? `WHERE run_id = COALESCE((SELECT run_id FROM showcase_screens WHERE id = $1::uuid), $1::uuid)`
        : "";
      const result = (await db.query(
        `SELECT id, title, html_url, width, height
           FROM showcase_screens
           ${where}
           ORDER BY created_at ASC, id ASC`,
        appOf ? [appOf] : [],
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

    async getScreenSource(id) {
      const result = (await db.query(
        `SELECT id, title, html_url, width, height FROM showcase_screens WHERE id = $1::uuid`,
        [id],
      )) as {
        rows: Array<{
          id: string;
          title: string;
          html_url: string;
          width: number;
          height: number;
        }>;
      };
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        htmlUrl: row.html_url,
        width: row.width,
        height: row.height,
      };
    },

    async updateScreenHtmlUrl(id, htmlUrl) {
      await db.query(`UPDATE showcase_screens SET html_url = $2 WHERE id = $1::uuid`, [
        id,
        htmlUrl,
      ]);
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

    async deleteScreens(target) {
      // One statement per shape rather than a shared WHERE: the app form has
      // to resolve its argument through the same COALESCE(screen -> run)
      // trick `listScreenSources` uses, which the single-screen form must not
      // do (passing a screen id there would take its whole run with it).
      const sql =
        "appOf" in target
          ? `DELETE FROM showcase_screens
               WHERE run_id = COALESCE((SELECT run_id FROM showcase_screens WHERE id = $1::uuid), $1::uuid)
               RETURNING id, run_id, title`
          : `DELETE FROM showcase_screens WHERE id = $1::uuid RETURNING id, run_id, title`;
      const result = (await db.query(sql, [
        "appOf" in target ? target.appOf : target.screen,
      ])) as { rows: Array<{ id: string; run_id: string; title: string }> };
      return result.rows.map((r) => ({ id: r.id, runId: r.run_id, title: r.title }));
    },

    close: () => db.end(),
  };
}
