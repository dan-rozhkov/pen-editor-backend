import type { Config } from "../config.js";
import { createPgPool, type TraceQueryable } from "../tracing/traceStore.js";
import { DEFAULT_SHOWCASE_PLATFORM, type ShowcasePlatform } from "./platform.js";

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
  // Defaults to "mobile" when omitted, same as the column's own DB default —
  // every caller written before desktop generation existed still inserts a
  // phone screen without having to know this field exists.
  platform?: ShowcasePlatform;
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
  // Every screen of a run shares one platform (one generate/ingest run
  // targets exactly one device class), so this lives on the app, not
  // `ShowcaseScreen` — deliberately not duplicated onto each screen, even
  // though the underlying row carries its own `platform` column, to keep the
  // API and this type from implying a screen could ever disagree with its
  // own app.
  platform: ShowcasePlatform;
  // The app's own recency — MAX(created_at) across its screens, which is also
  // what the feed sorts on when sort=latest.
  createdAt: string;
  // Total claps for this run_id from `showcase_app_likes`, 0 when the app has
  // never been liked (the row doesn't exist yet — see `likeApp`).
  likes: number;
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
    // `"popular"` (default) orders by likes, `"latest"` by recency — the
    // feed's two sort tabs. Kept as an explicit option rather than folded
    // into `cursor` because the first page of either sort has no cursor yet.
    sort?: "popular" | "latest";
    // A theme filter, applied inside the `runs` subquery (a run has exactly
    // one theme, so filtering runs fully determines the screens returned).
    category?: string;
    // A model filter, applied inside the same `runs` subquery as `category`
    // — a run has exactly one model (every screen it publishes shares the
    // generating model), so filtering runs fully determines the screens
    // returned, same reasoning as `category`.
    model?: string;
    // Defaults to "mobile". Unlike `category`, always applied — mobile and
    // desktop apps must never mix in the same feed page, so there is no
    // "unfiltered" state the way an absent category has one.
    platform?: ShowcasePlatform;
  }): Promise<{ apps: ShowcaseApp[]; nextCursor: string | null }>;
  // Defaults `platform` to "mobile". Filtered so a recent desktop run never
  // excludes a mobile theme (or vice versa) from `pickTheme`'s candidate
  // pool — the two platforms rotate through independent theme pools
  // (`themes.ts`), and their "recently used" windows must stay independent
  // too.
  recentThemes(limit: number, platform?: ShowcasePlatform): Promise<string[]>;
  // One screen's `html_url` per recent run, freshest run first — the input to
  // palette rotation (`src/showcase/palette.ts`), which reads the accent back
  // out of published HTML so a new run can steer away from the hue families
  // the gallery has just seen. One screen is enough: a run is one visual
  // world, so every screen of it shares an accent.
  recentRunHtmlUrls(limit: number): Promise<string[]>;
  // For the category chip row: every theme that has at least one published
  // app, with a count, ordered by popularity. Never returns a theme with zero
  // apps, so a chip can never lead to an empty grid. Defaults `platform` to
  // "mobile" — the two platforms have separate theme pools, so a chip row is
  // always scoped to one platform's apps.
  listCategories(platform?: ShowcasePlatform): Promise<Array<{ theme: string; apps: number }>>;
  // For the model chip/filter row: every model that has at least one
  // published app, with a count, ordered by popularity. Verbatim clone of
  // `listCategories` with `model` substituted for `theme` — a run has
  // exactly one model, same as one theme, so the same COUNT(DISTINCT run_id)
  // reasoning applies. Never returns a model with zero apps, so a filter can
  // never lead to an empty grid. Defaults `platform` to "mobile" — the two
  // platforms have separate model pools in practice, so this is always
  // scoped to one platform's apps.
  listModels(platform?: ShowcasePlatform): Promise<Array<{ model: string; apps: number }>>;
  // Upsert-increments the like counter for a run_id and returns the new
  // total, or `null` when `runId` has no published screens — the route turns
  // that into a 404 rather than silently creating a like row for an app that
  // doesn't (or no longer) exists.
  likeApp(runId: string, count: number): Promise<number | null>;
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
  // For `GET /api/showcase/:runId/html` (the showcase's "Open in Editor"
  // handoff — pen-editor's ShowcaseAppCarousel/showcaseScreenHandoff.ts): every
  // *published* screen of one app, pinned-cover-first then newest-first —
  // the same per-app tiebreak `listApps` uses (line ~461) — so the screens
  // this returns land on the editor's canvas in the same order the carousel
  // already shows them. Returns `[]` rather than `null` for an unknown or
  // fully-unpublished runId; the route turns an empty array into 404.
  getAppScreens(runId: string): Promise<ShowcaseScreenSource[]>;
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
  // So `showcase:rescreenshot` re-renders each screen at its own device
  // viewport rather than always the mobile one — a sweep spans every
  // published screen regardless of platform.
  platform: ShowcasePlatform;
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

interface DecodedLatestCursor {
  sort: "latest";
  runSort: string;
  runId: string;
}

interface DecodedPopularCursor {
  sort: "popular";
  likes: number;
  runSort: string;
  runId: string;
}

type DecodedCursor = DecodedLatestCursor | DecodedPopularCursor;

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

// Both cursor formats embed a raw runId that ends up bound as `$N::uuid` in
// the HAVING clause. Postgres itself will reject a non-UUID there (22P02),
// but by then it's a query error, not a validation error — a hand-crafted or
// truncated cursor 500s instead of 400ing. Checking the shape here, before
// the value ever reaches SQL, keeps a malformed cursor a client error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // to validate or reuse. `l1` (popular sort) is 4 fields, so it never
  // collides with these.
  if (parts.length === 2) return "legacy";
  if (parts.length === 6) {
    if (parts[0] === "r2") return "legacy";
    badCursor();
  }

  if (parts.length === 4) {
    const [tag, likesStr, runSort, runId] = parts;
    if (tag !== "l1") badCursor();
    if (!likesStr || !runSort || !runId) badCursor();
    // Likes is a plain non-negative integer, never a float or a signed value
    // — round-tripped straight from the BIGINT column, so anything else is a
    // corrupted or hand-crafted cursor.
    if (!/^\d+$/.test(likesStr)) badCursor();
    const likes = Number(likesStr);
    if (Number.isNaN(Date.parse(runSort))) badCursor();
    if (!UUID_RE.test(runId)) badCursor();
    return { sort: "popular", likes, runSort, runId };
  }

  if (parts.length !== 3) badCursor();

  const [tag, runSort, runId] = parts;
  // The three-field shape is shared with the oldest format (`p0|p1` flag +
  // createdAt + id), so the leading field is what tells them apart.
  if (tag === "p0" || tag === "p1") return "legacy";
  if (tag !== "a1") badCursor();
  if (!runSort || !runId) badCursor();
  if (!UUID_RE.test(runId)) badCursor();
  // runSort round-trips through Postgres `::text` at full (microsecond)
  // precision — e.g. `2026-07-28 13:30:57.663475+00`, space separator, no
  // `T`, no `Z` — rather than the millisecond-precision ISO string `toIso()`
  // produces. Truncating it to milliseconds would make the cursor compare as
  // *smaller* than the real column value and silently drop the run it points
  // just past. `Date.parse` accepts that form (a stable, if non-spec, V8
  // extension), so this validation still rejects genuinely malformed values
  // while accepting both shapes.
  if (Number.isNaN(Date.parse(runSort))) badCursor();
  return { sort: "latest", runSort, runId };
}

function encodeCursor(fields: DecodedCursor): string {
  const encoded =
    fields.sort === "latest"
      ? `a1|${fields.runSort}|${fields.runId}`
      : `l1|${fields.likes}|${fields.runSort}|${fields.runId}`;
  return Buffer.from(encoded, "utf8").toString("base64url");
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
  platform: string;
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
  // `showcase_app_likes.likes` is BIGINT, and node-postgres returns BIGINT as
  // a decimal string rather than a JS `number` (to avoid silently losing
  // precision above 2^53) — converted to `number` in the app-building loop
  // below, same as everywhere else in this file that surfaces a count.
  run_likes: string;
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
           (id, run_id, theme, title, prompt, model, image_url, image_url_1x, lqip, html_url, width, height, platform)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
          row.platform ?? DEFAULT_SHOWCASE_PLATFORM,
        ],
      );
    },

    async listApps({
      limit,
      cursor,
      sort = "popular",
      category,
      model,
      platform = DEFAULT_SHOWCASE_PLATFORM,
    }) {
      const params: unknown[] = [];

      params.push(platform);
      // Always applied, unlike the theme/model filters below — mobile and
      // desktop apps must never mix on the same feed page.
      let filterClause = `AND platform = $${params.length}`;
      if (category) {
        params.push(category);
        filterClause += ` AND theme = $${params.length}`;
      }
      if (model) {
        params.push(model);
        filterClause += ` AND model = $${params.length}`;
      }

      let cursorClause = "";
      if (cursor) {
        const decoded = decodeCursor(cursor);
        // A legacy cursor addresses a single screen, a granularity this feed
        // no longer paginates by — there is nothing to translate, so this
        // page is served as if no cursor had been given (see decodeCursor).
        // Same treatment for a cursor whose own sort tag disagrees with the
        // requested `sort` (e.g. a stale tab still holding an `a1` cursor
        // after switching to Most popular) — it addresses a position in an
        // ordering that isn't the one being paginated, so there is nothing
        // valid to resume from.
        if (decoded !== "legacy" && decoded.sort === sort) {
          if (decoded.sort === "latest") {
            params.push(decoded.runSort, decoded.runId);
            // Row-wise comparison against both app-level sort keys at once,
            // not two ANDed columns: with `AND` an app whose `run_sort` ties
            // the cursor's would come back on a later page too.
            //
            // `HAVING`, not `WHERE`: `run_sort` is the MAX aggregate this
            // very query computes, so it does not exist yet at WHERE time.
            // `showcase_screens.run_id`, not bare `run_id`: the FROM list now
            // joins `showcase_app_likes l`, which also has a `run_id` column,
            // so an unqualified reference is ambiguous to Postgres (not just
            // to a human reader) and the whole query fails at parse time —
            // "Show more" 500'd on page 2 of every sort until this was
            // qualified. `GROUP BY`/`SELECT` already qualify it; `HAVING` was
            // the one clause that didn't.
            cursorClause = `HAVING (MAX(created_at), showcase_screens.run_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
          } else {
            params.push(decoded.likes, decoded.runSort, decoded.runId);
            // Same row-wise comparison, now over three columns
            // (likes, run_sort, run_id) — ANDing them would let an app tied
            // on like count with the cursor's come back on more than one
            // page. `run_likes`'s defining expression is repeated verbatim
            // (a HAVING clause can't reference the outer SELECT's alias).
            // `showcase_screens.run_id` for the same ambiguity reason as the
            // `latest` branch above.
            cursorClause = `HAVING (COALESCE(MAX(l.likes), 0), MAX(created_at), showcase_screens.run_id) < ($${params.length - 2}::bigint, $${params.length - 1}::timestamptz, $${params.length}::uuid)`;
          }
        }
      }
      params.push(limit);

      const runsOrderBy =
        sort === "latest"
          ? "run_sort DESC, run_id DESC"
          : "run_likes DESC, run_sort DESC, run_id DESC";
      // Two stages, and the split is the whole point: `runs` picks exactly
      // `limit` *apps* by their sort order, then the outer select takes every
      // screen belonging to them. Paginating the screens directly (what this
      // used to do) let a page boundary fall inside an app, so the gallery —
      // which renders one card per app — showed a carousel missing its last
      // screens until the visitor happened to click "Show more".
      const sql = `SELECT s.id, s.run_id, s.theme, s.title, s.prompt, s.model, s.image_url, s.image_url_1x, s.lqip, s.html_url, s.width, s.height, s.platform, s.created_at, s.pinned_at,
                          runs.run_sort, runs.run_likes, s.created_at::text AS created_at_text, runs.run_sort::text AS run_sort_text
                   FROM showcase_screens s
                   JOIN (
                     SELECT showcase_screens.run_id AS run_id, MAX(created_at) AS run_sort, COALESCE(MAX(l.likes), 0) AS run_likes
                     FROM showcase_screens
                     LEFT JOIN showcase_app_likes l ON l.run_id = showcase_screens.run_id
                     WHERE published = true ${filterClause}
                     GROUP BY showcase_screens.run_id
                     ${cursorClause}
                     ORDER BY ${runsOrderBy}
                     LIMIT $${params.length}
                   ) runs ON runs.run_id = s.run_id
                   WHERE s.published = true
                   ORDER BY ${sort === "latest" ? "runs.run_sort DESC" : "runs.run_likes DESC, runs.run_sort DESC"}, s.run_id DESC, (s.pinned_at IS NOT NULL) DESC, s.created_at DESC, s.id DESC`;
      const result = (await db.query(sql, params)) as {
        rows: ShowcaseScreenDbRow[];
      };

      // Rows arrive already grouped by app (the ORDER BY leads with the app
      // keys), so a single pass in feed order rebuilds the apps without
      // re-sorting anything.
      const apps: ShowcaseApp[] = [];
      const byRun = new Map<string, ShowcaseApp>();
      let lastRunSortText = "";
      let lastLikes = 0;
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
            // Same reasoning as theme/model: one run is one platform, so the
            // first screen's own `platform` column describes the whole app.
            platform: row.platform as ShowcasePlatform,
            createdAt: toIso(row.run_sort),
            likes: Number(row.run_likes),
            screens: [],
          };
          byRun.set(row.run_id, app);
          apps.push(app);
        }
        app.screens.push(screen);
        lastRunSortText = row.run_sort_text;
        lastLikes = Number(row.run_likes);
      }

      const nextCursor =
        apps.length === limit && apps.length > 0
          ? encodeCursor(
              sort === "latest"
                ? {
                    sort: "latest",
                    // Full-precision text, not `toIso(...)`/`app.createdAt`
                    // — those truncate to milliseconds and must never feed
                    // the cursor (see the comment on
                    // `ShowcaseScreenDbRow.run_sort_text`). The display
                    // `createdAt` stays millisecond-precision ISO.
                    runSort: lastRunSortText,
                    runId: apps[apps.length - 1].runId,
                  }
                : {
                    sort: "popular",
                    likes: lastLikes,
                    runSort: lastRunSortText,
                    runId: apps[apps.length - 1].runId,
                  },
            )
          : null;
      return { apps, nextCursor };
    },

    async recentThemes(limit, platform = DEFAULT_SHOWCASE_PLATFORM) {
      const result = (await db.query(
        `SELECT theme, MAX(created_at) AS last_seen
           FROM showcase_screens
          WHERE platform = $2
           GROUP BY theme
           ORDER BY last_seen DESC
           LIMIT $1`,
        [limit, platform],
      )) as { rows: Array<{ theme: string }> };
      return result.rows.map((r) => r.theme);
    },

    async recentRunHtmlUrls(limit) {
      // DISTINCT ON collapses each run to one screen, but Postgres requires
      // its expression to lead the ORDER BY — so recency ordering happens in
      // the outer query rather than inside the deduplication.
      const result = (await db.query(
        `SELECT html_url FROM (
             SELECT DISTINCT ON (run_id) run_id, html_url, created_at
               FROM showcase_screens
              WHERE published = true
              ORDER BY run_id, created_at DESC
           ) t
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      )) as { rows: Array<{ html_url: string }> };
      return result.rows.map((r) => r.html_url);
    },

    async listCategories(platform = DEFAULT_SHOWCASE_PLATFORM) {
      // COUNT(DISTINCT run_id), not COUNT(*): a chip's count is apps, not
      // screens, matching what the grid actually paginates by — a run
      // publishing 5 screens must not make its theme look 5x more popular
      // than one that published fewer.
      const result = (await db.query(
        `SELECT theme, COUNT(DISTINCT run_id) AS apps
           FROM showcase_screens
           WHERE published = true AND platform = $1
           GROUP BY theme
           ORDER BY apps DESC, theme ASC`,
        [platform],
      )) as { rows: Array<{ theme: string; apps: string }> };
      // COUNT(...) is BIGINT — see the comment on `run_likes` above for why
      // node-postgres hands that back as a string.
      return result.rows.map((r) => ({ theme: r.theme, apps: Number(r.apps) }));
    },

    async listModels(platform = DEFAULT_SHOWCASE_PLATFORM) {
      // Verbatim clone of `listCategories` with `model` substituted for
      // `theme` — see that method's comment for why COUNT(DISTINCT run_id),
      // not COUNT(*).
      const result = (await db.query(
        `SELECT model, COUNT(DISTINCT run_id) AS apps
           FROM showcase_screens
           WHERE published = true AND platform = $1
           GROUP BY model
           ORDER BY apps DESC, model ASC`,
        [platform],
      )) as { rows: Array<{ model: string; apps: string }> };
      return result.rows.map((r) => ({ model: r.model, apps: Number(r.apps) }));
    },

    async likeApp(runId, count) {
      // Existence is checked up front, against `showcase_screens` rather
      // than `showcase_app_likes`, so an unknown or fully-deleted run_id
      // 404s instead of silently creating a like row for an app nobody can
      // ever see — `showcase:delete` removes rows only, so a like row for a
      // deleted run would otherwise outlive the app it belonged to.
      const existing = (await db.query(
        "SELECT 1 FROM showcase_screens WHERE run_id = $1 AND published = true LIMIT 1",
        [runId],
      )) as { rows: unknown[] };
      if (existing.rows.length === 0) return null;

      const result = (await db.query(
        `INSERT INTO showcase_app_likes (run_id, likes, updated_at)
           VALUES ($1, $2, now())
         ON CONFLICT (run_id) DO UPDATE
           SET likes = showcase_app_likes.likes + $2, updated_at = now()
         RETURNING likes`,
        [runId, count],
      )) as { rows: Array<{ likes: string }> };
      return Number(result.rows[0].likes);
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
        `SELECT id, title, html_url, width, height, platform
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
          platform: string;
        }>;
      };
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        htmlUrl: row.html_url,
        width: row.width,
        height: row.height,
        platform: row.platform as ShowcasePlatform,
      }));
    },

    async getScreenSource(id) {
      const result = (await db.query(
        `SELECT id, title, html_url, width, height, platform FROM showcase_screens WHERE id = $1::uuid`,
        [id],
      )) as {
        rows: Array<{
          id: string;
          title: string;
          html_url: string;
          width: number;
          height: number;
          platform: string;
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
        platform: row.platform as ShowcasePlatform,
      };
    },

    async getAppScreens(runId) {
      const result = (await db.query(
        `SELECT id, title, html_url, width, height, platform
           FROM showcase_screens
          WHERE run_id = $1::uuid AND published = true
          ORDER BY (pinned_at IS NOT NULL) DESC, created_at DESC, id DESC`,
        [runId],
      )) as {
        rows: Array<{
          id: string;
          title: string;
          html_url: string;
          width: number;
          height: number;
          platform: string;
        }>;
      };
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        htmlUrl: row.html_url,
        width: row.width,
        height: row.height,
        platform: row.platform as ShowcasePlatform,
      }));
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

      // A like belongs to the app (run_id), not any one screen row, so
      // deleting screens can orphan it — `likeApp`'s existence check runs
      // against `showcase_screens`, not `showcase_app_likes`, so a leftover
      // row would just sit there silently until the same run_id got
      // published again (e.g. a re-`showcase:ingest` of a corrected run) and
      // resurrect its old count on an app nobody actually liked yet.
      const runIds = [...new Set(result.rows.map((r) => r.run_id))];
      if (runIds.length > 0) {
        if ("appOf" in target) {
          // The whole app is gone — its counter has nothing left to belong
          // to. `deleteScreens({ appOf })` always removes every row of the
          // run (see the WHERE above), so there is no "some screens remain"
          // case to check here.
          await db.query("DELETE FROM showcase_app_likes WHERE run_id = ANY($1::uuid[])", [
            runIds,
          ]);
        } else {
          // A single screen: only clear the counter if that was the run's
          // last published screen — an app that still has other published
          // screens keeps its likes.
          const runId = runIds[0];
          const remaining = (await db.query(
            "SELECT 1 FROM showcase_screens WHERE run_id = $1 AND published = true LIMIT 1",
            [runId],
          )) as { rows: unknown[] };
          if (remaining.rows.length === 0) {
            await db.query("DELETE FROM showcase_app_likes WHERE run_id = $1", [runId]);
          }
        }
      }

      return result.rows.map((r) => ({ id: r.id, runId: r.run_id, title: r.title }));
    },

    close: () => db.end(),
  };
}
