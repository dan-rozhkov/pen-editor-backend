import { describe, expect, it, vi } from "vitest";
import {
  createShowcaseStore,
  type ShowcaseScreenRow,
} from "../src/showcase/store.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

function fakePool(
  rows: unknown[] = [],
): TraceQueryable & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    }),
    end: vi.fn(async () => {}),
  };
}

const row: ShowcaseScreenRow = {
  id: "11111111-1111-1111-1111-111111111111",
  runId: "22222222-2222-2222-2222-222222222222",
  theme: "fitness",
  title: "Workout tracker",
  prompt: "a fitness onboarding screen",
  model: "google/gemini-2.5-flash",
  imageUrl: "https://cdn.example.test/1.png",
  htmlUrl: "https://cdn.example.test/1.html",
  width: 390,
  height: 844,
};

// A minimal in-memory interpreter for exactly the SQL this store issues.
// There is no pg-mem-style engine in this repo's dependencies, so this fake
// re-implements the store's own contract (filter published, window-partition
// by run_id, apply the keyset predicate, sort, paginate; scope pin/clear
// updates by run_id) well enough to give the ordering/pagination/exclusivity
// tests real behavior to assert on, rather than only asserting SQL strings.
interface FakeRow {
  id: string;
  run_id: string;
  theme: string;
  title: string;
  prompt: string;
  model: string;
  image_url: string;
  image_url_1x?: string | null;
  lqip?: string | null;
  html_url: string;
  width: number;
  height: number;
  created_at: Date;
  // Full (microsecond) precision text form of `created_at`, as Postgres'
  // `::text` cast would return it — e.g. "2026-07-20T00:00:00.500123Z".
  // Optional: defaults to `created_at.toISOString()` (millisecond precision,
  // same as every pre-existing fixture) when a test doesn't care about
  // sub-millisecond digits.
  created_at_raw?: string;
  pinned_at: Date | null;
  published: boolean;
  // Mirrors `showcase_app_likes.likes` for this row's run_id — every row of
  // one run should carry the same value (a like belongs to the app, not the
  // screen); the fake takes the max across a run's rows, same as the real
  // query's `COALESCE(MAX(l.likes), 0)`, so a mismatched fixture can't
  // silently pass. Defaults to 0 (no likes row) when unset.
  likes?: number;
}

// Recovers full (microsecond) precision from a raw timestamp string as
// epoch microseconds — something a JS `Date` cannot hold (it floors to
// milliseconds). `Date.parse` on the fraction-stripped string gives the
// millisecond part; the fractional digits (if any, right-padded/truncated to
// 6) give the rest. Used so this fake's row-wise comparisons are faithful to
// how Postgres actually compares `timestamptz` values — at full precision,
// never silently rounded to milliseconds the way `Date#getTime()` would.
function preciseMicros(raw: string): number {
  const fractionMatch = raw.match(/\.(\d+)/);
  const fractionMicros = Number((fractionMatch?.[1] ?? "").padEnd(6, "0").slice(0, 6));
  const withoutFraction = raw.replace(/\.\d+/, "");
  return new Date(withoutFraction).getTime() * 1000 + fractionMicros;
}

function fakeDb(
  initialRows: FakeRow[],
): TraceQueryable & { rows: FakeRow[]; likes: Map<string, number> } {
  const rows = initialRows.map((r) => ({ ...r }));
  // Separate from `rows.likes` (a fixture convenience — see `FakeRow.likes`):
  // this is the fake's model of the actual `showcase_app_likes` table, kept
  // as its own map so `likeApp`'s increment/upsert has real state to act on
  // rather than mutating fixture rows. Seeded from any `FakeRow.likes` set on
  // construction so ordering/pagination tests can still just set `likes` on
  // a row.
  const likes = new Map<string, number>();
  for (const r of rows) {
    if (r.likes !== undefined) {
      likes.set(r.run_id, Math.max(likes.get(r.run_id) ?? 0, r.likes));
    }
  }

  async function query(sql: string, params: unknown[] = []) {
    if (sql.includes("INSERT INTO showcase_app_likes")) {
      if (
        !sql.includes(
          "ON CONFLICT (run_id) DO UPDATE",
        ) ||
        !sql.includes("SET likes = showcase_app_likes.likes + $2")
      ) {
        throw new Error(`unrecognized query (likeApp upsert shape changed): ${sql}`);
      }
      const [runId, count] = params as [string, number];
      const total = (likes.get(runId) ?? 0) + count;
      likes.set(runId, total);
      return { rows: [{ likes: String(total) }] };
    }

    if (sql.includes("SELECT 1 FROM showcase_screens WHERE run_id = $1 AND published = true")) {
      const [runId] = params as [string];
      const found = rows.some((r) => r.run_id === runId && r.published);
      return { rows: found ? [{ "?column?": 1 }] : [] };
    }

    if (sql.includes("COUNT(DISTINCT run_id)")) {
      if (!sql.includes("ORDER BY apps DESC, theme ASC")) {
        throw new Error(`unrecognized query (listCategories ORDER BY changed): ${sql}`);
      }
      const runsByTheme = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!r.published) continue;
        if (!runsByTheme.has(r.theme)) runsByTheme.set(r.theme, new Set());
        runsByTheme.get(r.theme)!.add(r.run_id);
      }
      const result = [...runsByTheme.entries()]
        .map(([theme, runIds]) => ({ theme, apps: runIds.size }))
        .sort((a, b) => (b.apps !== a.apps ? b.apps - a.apps : a.theme < b.theme ? -1 : 1));
      return { rows: result.map((r) => ({ theme: r.theme, apps: String(r.apps) })) };
    }

    if (sql.includes("INSERT INTO showcase_screens")) {
      const [
        id,
        run_id,
        theme,
        title,
        prompt,
        model,
        image_url,
        image_url_1x,
        lqip,
        html_url,
        width,
        height,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        number,
        number,
      ];
      rows.push({
        id,
        run_id,
        theme,
        title,
        prompt,
        model,
        image_url,
        image_url_1x,
        lqip,
        html_url,
        width,
        height,
        created_at: new Date(),
        pinned_at: null,
        published: true,
      });
      return { rows: [] };
    }

    if (sql.includes("SELECT run_id FROM showcase_screens WHERE id = $1")) {
      const [id] = params as [string];
      const found = rows.find((r) => r.id === id);
      return { rows: found ? [{ run_id: found.run_id }] : [] };
    }

    if (sql.includes("SET pinned_at = now()")) {
      // The set half of pinScreen. It clears the app's old pin in a separate,
      // earlier statement (handled by the `SET pinned_at = NULL ... run_id =
      // $1` branch below) — see store.ts for why that split is load-bearing.
      // Refuse to interpret this unless the run-scoping fragment is present
      // verbatim: otherwise a regression that drops `run_id = $2` from the
      // production SQL would silently keep being "understood" by this fake as
      // scoped, and no behavioral test would ever see the bug.
      if (!sql.includes("WHERE id = $1 AND run_id = $2")) {
        throw new Error(
          `unrecognized query (pinScreen scoping fragment missing/changed): ${sql}`,
        );
      }
      const [id, runId] = params as [string, string];
      for (const r of rows) {
        if (r.run_id === runId && r.id === id) r.pinned_at = new Date();
      }
      return { rows: [] };
    }

    if (sql.includes("SET pinned_at = NULL") && sql.includes("run_id = $1")) {
      const [runId] = params as [string];
      for (const r of rows) {
        if (r.run_id === runId) r.pinned_at = null;
      }
      return { rows: [] };
    }

    if (sql.includes("SET pinned_at = NULL")) {
      for (const r of rows) r.pinned_at = null;
      return { rows: [] };
    }

    if (sql.includes("GROUP BY showcase_screens.run_id")) {
      // Same refusal as above: only interpret this as the store's real
      // listApps query if its load-bearing ORDER BYs match one of the two
      // known-good shapes exactly. A flipped sort direction, a reordered
      // column, or a dropped tiebreaker in the real SQL must make this fake
      // stop understanding the query, not silently keep sorting/filtering in
      // JS against a query shape that no longer exists.
      const isPopular = sql.includes("run_likes DESC, run_sort DESC, run_id DESC");
      const isLatest = sql.includes("ORDER BY run_sort DESC, run_id DESC");
      if (isPopular === isLatest) {
        throw new Error(`unrecognized query (runs ORDER BY not recognized as exactly one sort): ${sql}`);
      }
      const screenOrderBy = isPopular
        ? "ORDER BY runs.run_likes DESC, runs.run_sort DESC, s.run_id DESC, (s.pinned_at IS NOT NULL) DESC, s.created_at DESC, s.id DESC"
        : "ORDER BY runs.run_sort DESC, s.run_id DESC, (s.pinned_at IS NOT NULL) DESC, s.created_at DESC, s.id DESC";
      if (!sql.includes(screenOrderBy)) {
        throw new Error(`unrecognized query (outer ORDER BY changed): ${sql}`);
      }
      if (!sql.includes("LEFT JOIN showcase_app_likes l ON l.run_id = showcase_screens.run_id")) {
        throw new Error(`unrecognized query (likes join missing): ${sql}`);
      }
      // The app-level LIMIT must sit inside the subselect that picks runs —
      // if it ever moved out to the screen level, pages would go back to
      // cutting an app in half and this fake must not paper over that.
      // False positive below: `.test(sql)` is RegExp.prototype.test on a SQL
      // string, not a vitest `test()` call — the rule matches on method name.
      // eslint-disable-next-line vitest/no-conditional-tests
      if (!/LIMIT \$\d+\s*\n?\s*\) runs/.test(sql)) {
        throw new Error(`unrecognized query (LIMIT is not app-level): ${sql}`);
      }

      const limit = params[params.length - 1] as number;

      // Category filter: `AND theme = $n` inside the runs subquery's WHERE.
      const themeMatch = sql.match(/AND theme = \$(\d+)/);
      const category = themeMatch ? (params[Number(themeMatch[1]) - 1] as string) : null;

      // Read the cursor bounds out of `params` by the placeholder numbers
      // that actually appear in the row-wise predicate, rather than assuming
      // a fixed position — so a reordered/renumbered $n in the real SQL shows
      // up as a wrong cursor value here instead of being invisible.
      const latestPredicate = sql.match(
        /\(MAX\(created_at\), showcase_screens\.run_id\) < \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/,
      );
      const popularPredicate = sql.match(
        /\(COALESCE\(MAX\(l\.likes\), 0\), MAX\(created_at\), showcase_screens\.run_id\) < \(\$(\d+)::bigint, \$(\d+)::timestamptz, \$(\d+)::uuid\)/,
      );
      if (sql.includes("HAVING") && !latestPredicate && !popularPredicate) {
        throw new Error(`unrecognized query (cursor predicate shape changed): ${sql}`);
      }
      if (isPopular && latestPredicate) {
        throw new Error(`unrecognized query (latest predicate on a popular-sorted query): ${sql}`);
      }
      if (isLatest && popularPredicate) {
        throw new Error(`unrecognized query (popular predicate on a latest-sorted query): ${sql}`);
      }
      // Cursor timestamp params are the full-precision `::text` form (e.g.
      // "2026-07-28 13:30:57.663475+00"), not the millisecond-precision ISO
      // `toIso()` produces — so they're compared via `preciseMicros` below,
      // same as every row, rather than through a `Date` that would silently
      // re-truncate them back to milliseconds.
      const cursor = latestPredicate
        ? {
            likes: null as number | null,
            runSort: preciseMicros(params[Number(latestPredicate[1]) - 1] as string),
            runId: params[Number(latestPredicate[2]) - 1] as string,
          }
        : popularPredicate
          ? {
              likes: params[Number(popularPredicate[1]) - 1] as number,
              runSort: preciseMicros(params[Number(popularPredicate[2]) - 1] as string),
              runId: params[Number(popularPredicate[3]) - 1] as string,
            }
          : null;

      // Full-precision raw text per row (defaults to the millisecond-only
      // ISO string when a test fixture doesn't set `created_at_raw`), and
      // the per-run MAX(created_at) computed — like Postgres — at that same
      // full precision, not at `Date#getTime()`'s millisecond resolution.
      function rawOf(r: FakeRow): string {
        return r.created_at_raw ?? r.created_at.toISOString();
      }

      const runSortMicrosByRun = new Map<string, number>();
      const runSortRawByRun = new Map<string, string>();
      const runThemeByRun = new Map<string, string>();
      for (const r of rows) {
        if (!r.published) continue;
        if (category && r.theme !== category) continue;
        const raw = rawOf(r);
        const micros = preciseMicros(raw);
        runThemeByRun.set(r.run_id, r.theme);
        if (micros > (runSortMicrosByRun.get(r.run_id) ?? -Infinity)) {
          runSortMicrosByRun.set(r.run_id, micros);
          runSortRawByRun.set(r.run_id, raw);
        }
      }
      const likesByRun = (runId: string): number => likes.get(runId) ?? 0;

      // Stage 1 — pick `limit` apps by the requested sort, after the keyset
      // predicate (row-wise on (likes, run_sort, run_id) for popular, on
      // (run_sort, run_id) for latest — never ANDed columns, so a tie at the
      // leading key can't repeat or skip a row across the boundary).
      const runsSorted = [...runSortMicrosByRun.keys()]
        .map((runId) => ({
          runId,
          runSortMicros: runSortMicrosByRun.get(runId)!,
          runLikes: likesByRun(runId),
        }))
        .sort((a, b) => {
          if (isPopular && a.runLikes !== b.runLikes) return b.runLikes - a.runLikes;
          if (a.runSortMicros !== b.runSortMicros) return b.runSortMicros - a.runSortMicros;
          return a.runId < b.runId ? 1 : -1;
        });
      const runsPage = (
        cursor
          ? runsSorted.filter((x) => {
              if (isPopular) {
                const key = (v: { runLikes: number; runSortMicros: number; runId: string }) =>
                  [v.runLikes, v.runSortMicros, v.runId] as const;
                const [aLikes, aSort, aId] = key(x);
                const [bLikes, bSort, bId] = [cursor.likes!, cursor.runSort, cursor.runId] as const;
                if (aLikes !== bLikes) return aLikes < bLikes;
                if (aSort !== bSort) return aSort < bSort;
                return aId < bId;
              }
              return (
                x.runSortMicros < cursor.runSort ||
                (x.runSortMicros === cursor.runSort && x.runId < cursor.runId)
              );
            })
          : runsSorted
      ).slice(0, limit);
      const runRank = new Map(runsPage.map((x, i) => [x.runId, i]));

      // Stage 2 — every screen of those apps, ordered app-wise then
      // pinned-first / newest-first within each app.
      const page = rows
        .filter((r) => r.published && runRank.has(r.run_id))
        .map((r) => ({ r, createdMicros: preciseMicros(rawOf(r)) }))
        .sort((a, b) => {
          const rankDiff = runRank.get(a.r.run_id)! - runRank.get(b.r.run_id)!;
          if (rankDiff !== 0) return rankDiff;
          const aPinned = a.r.pinned_at !== null;
          const bPinned = b.r.pinned_at !== null;
          if (aPinned !== bPinned) return aPinned ? -1 : 1;
          if (a.createdMicros !== b.createdMicros) return b.createdMicros - a.createdMicros;
          return a.r.id < b.r.id ? 1 : -1;
        });

      return {
        rows: page.map(({ r }) => ({
          id: r.id,
          run_id: r.run_id,
          theme: r.theme,
          title: r.title,
          prompt: r.prompt,
          model: r.model,
          image_url: r.image_url,
          image_url_1x: r.image_url_1x ?? null,
          lqip: r.lqip ?? null,
          html_url: r.html_url,
          width: r.width,
          height: r.height,
          created_at: r.created_at,
          pinned_at: r.pinned_at,
          run_sort: new Date(runSortRawByRun.get(r.run_id)!),
          run_likes: String(likesByRun(r.run_id)),
          created_at_text: rawOf(r),
          run_sort_text: runSortRawByRun.get(r.run_id)!,
        })),
      };
    }

    throw new Error(`unrecognized query — no branch of the fake matched: ${sql}`);
  }

  return { rows, likes, query: vi.fn(query), end: vi.fn(async () => {}) };
}

function makeRow(overrides: Partial<FakeRow> & { id: string; run_id: string }): FakeRow {
  return {
    theme: "fitness",
    title: "Screen",
    prompt: "a screen",
    model: "google/gemini-2.5-flash",
    image_url: "https://cdn.example.test/x.png",
    image_url_1x: null,
    lqip: null,
    html_url: "https://cdn.example.test/x.html",
    width: 390,
    height: 844,
    created_at: new Date(),
    pinned_at: null,
    published: true,
    ...overrides,
  };
}

describe("createShowcaseStore", () => {
  it("returns null when TRACE_DATABASE_URL is not set", () => {
    expect(createShowcaseStore(makeConfig())).toBeNull();
  });

  it("inserts a showcase_screens row", async () => {
    const pool = fakePool();
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.insertScreen(row);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toContain("INSERT INTO showcase_screens");
    expect(pool.calls[0].params?.[0]).toBe(row.id);
    // `row` has no derivatives set, so both new columns go in as NULL rather
    // than `undefined` (which node-postgres would reject as a bind param).
    expect(pool.calls[0].params).toContain(null);
  });

  it("passes imageUrl1x/lqip through to the INSERT when present", async () => {
    const pool = fakePool();
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.insertScreen({
      ...row,
      imageUrl1x: "https://cdn.example.test/1@1x.webp",
      lqip: "data:image/webp;base64,AAAA",
    });
    expect(pool.calls[0].params).toEqual(
      expect.arrayContaining([
        "https://cdn.example.test/1@1x.webp",
        "data:image/webp;base64,AAAA",
      ]),
    );
  });

  function dbRow(
    overrides: Partial<{
      pinned_at: Date | null;
      created_at_text: string;
      run_sort_text: string;
      image_url_1x: string | null;
      lqip: string | null;
      run_likes: string;
      platform: string;
    }> = {},
  ) {
    const { created_at_text, run_sort_text, ...rest } = overrides;
    return {
      id: row.id,
      run_id: row.runId,
      theme: row.theme,
      title: row.title,
      prompt: row.prompt,
      model: row.model,
      image_url: row.imageUrl,
      image_url_1x: null,
      lqip: null,
      html_url: row.htmlUrl,
      width: row.width,
      height: row.height,
      platform: "mobile",
      created_at: new Date("2026-07-27T10:00:00.000Z"),
      pinned_at: null,
      run_sort: new Date("2026-07-27T10:00:00.000Z"),
      run_likes: "0",
      // Defaults match the millisecond-precision fixture above — real
      // Postgres `::text` output would differ only when the underlying
      // column actually carries sub-millisecond digits, which the dedicated
      // microsecond-precision tests below exercise explicitly.
      created_at_text: created_at_text ?? "2026-07-27T10:00:00.000Z",
      run_sort_text: run_sort_text ?? "2026-07-27T10:00:00.000Z",
      ...rest,
    };
  }

  it("groups screens into apps, with no next cursor when under limit", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { apps, nextCursor } = await store!.listApps({ limit: 12 });
    expect(apps).toHaveLength(1);
    expect(apps[0].runId).toBe(row.runId);
    expect(apps[0].theme).toBe(row.theme);
    expect(apps[0].model).toBe(row.model);
    expect(apps[0].platform).toBe("mobile");
    expect(apps[0].createdAt).toBe("2026-07-27T10:00:00.000Z");
    expect(apps[0].screens).toHaveLength(1);
    expect(apps[0].screens[0].createdAt).toBe("2026-07-27T10:00:00.000Z");
    expect(apps[0].screens[0].pinned).toBe(false);
    expect(apps[0].likes).toBe(0);
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].sql).toContain("published = true");
    expect(pool.calls[0].sql).toContain("GROUP BY showcase_screens.run_id");
    // Default sort is "popular".
    expect(pool.calls[0].sql).toContain("ORDER BY run_likes DESC, run_sort DESC, run_id DESC");
    expect(pool.calls[0].sql).toContain(
      "ORDER BY runs.run_likes DESC, runs.run_sort DESC, s.run_id DESC, (s.pinned_at IS NOT NULL) DESC, s.created_at DESC, s.id DESC",
    );
  });

  it("uses the latest-sort ORDER BY when sort='latest' is requested", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.listApps({ limit: 12, sort: "latest" });
    expect(pool.calls[0].sql).toContain("ORDER BY run_sort DESC, run_id DESC");
    expect(pool.calls[0].sql).toContain(
      "ORDER BY runs.run_sort DESC, s.run_id DESC, (s.pinned_at IS NOT NULL) DESC, s.created_at DESC, s.id DESC",
    );
    expect(pool.calls[0].sql).not.toContain("run_likes DESC, run_sort DESC, run_id DESC");
  });

  it("filters the runs subquery by theme when category is given", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.listApps({ limit: 12, category: "fitness tracker" });
    expect(pool.calls[0].sql).toMatch(/WHERE published = true AND platform = \$\d+ AND theme = \$\d+/);
    expect(pool.calls[0].params).toContain("fitness tracker");
  });

  it("filters the runs subquery by model when model is given", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.listApps({ limit: 12, model: "deepseek/deepseek-v4-pro" });
    expect(pool.calls[0].sql).toMatch(/WHERE published = true AND platform = \$\d+ AND model = \$\d+/);
    expect(pool.calls[0].params).toContain("deepseek/deepseek-v4-pro");
  });

  // Each filter above is only exercised in isolation — this is the case a
  // shifted `$N` placeholder (e.g. `model` landing on `$2` instead of `$3`
  // after `category`) would slip through: the substring assertions above
  // ("AND model = $\d+") would still match even with the numbering wrong.
  // Asserting the placeholder numbers explicitly, and the params array in
  // the exact matching order, is what would actually catch that regression.
  it("uses sequential, correctly-ordered placeholders when category, model, and platform are all given", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.listApps({
      limit: 12,
      category: "fitness tracker",
      model: "deepseek/deepseek-v4-pro",
      platform: "desktop",
    });
    expect(pool.calls[0].sql).toMatch(
      /WHERE published = true AND platform = \$1 AND theme = \$2 AND model = \$3/,
    );
    // platform ($1), category ($2), model ($3), then the (cursor-less) LIMIT
    // ($4) — in exactly this order.
    expect(pool.calls[0].params).toEqual([
      "desktop",
      "fitness tracker",
      "deepseek/deepseek-v4-pro",
      12,
    ]);
  });

  it("always filters the runs subquery by platform, defaulting to mobile", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.listApps({ limit: 12 });
    expect(pool.calls[0].sql).toMatch(/WHERE published = true AND platform = \$1/);
    expect(pool.calls[0].params).toContain("mobile");
  });

  it("filters the runs subquery by an explicit platform", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.listApps({ limit: 12, platform: "desktop" });
    expect(pool.calls[0].params).toContain("desktop");
  });

  it("maps NULL image_url_1x/lqip columns to undefined, not null", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { apps } = await store!.listApps({ limit: 12 });
    expect(apps[0].screens[0].imageUrl1x).toBeUndefined();
    expect(apps[0].screens[0].lqip).toBeUndefined();
  });

  it("maps present image_url_1x/lqip columns through unchanged", async () => {
    const pool = fakePool([
      dbRow({
        image_url_1x: "https://cdn.example.test/1@1x.webp",
        lqip: "data:image/webp;base64,AAAA",
      }),
    ]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { apps } = await store!.listApps({ limit: 12 });
    expect(apps[0].screens[0].imageUrl1x).toBe("https://cdn.example.test/1@1x.webp");
    expect(apps[0].screens[0].lqip).toBe("data:image/webp;base64,AAAA");
  });

  it("marks a screen with pinned_at set as pinned", async () => {
    const pool = fakePool([dbRow({ pinned_at: new Date("2026-07-28T09:00:00.000Z") })]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { apps } = await store!.listApps({ limit: 12 });
    expect(apps[0].screens[0].pinned).toBe(true);
  });

  it("returns an app-addressing nextCursor when the page is full (default popular sort)", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { nextCursor } = await store!.listApps({ limit: 1 });
    expect(nextCursor).not.toBeNull();

    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    // Only the app keys — no screen id, since a page boundary never falls
    // inside an app any more. `l1` tag carries likes ahead of run_sort/run_id.
    expect(decoded).toBe(`l1|0|2026-07-27T10:00:00.000Z|${row.runId}`);
  });

  it("returns an a1 nextCursor for sort=latest", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { nextCursor } = await store!.listApps({ limit: 1, sort: "latest" });
    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe(`a1|2026-07-27T10:00:00.000Z|${row.runId}`);
  });

  // Regression for the pagination bug rooted in timestamp precision:
  // Postgres stores `created_at` (and the `run_sort` aggregate derived from
  // it) with microsecond precision, but `toIso()`/the pg driver's `Date`
  // truncate to milliseconds. Building the cursor from the truncated value
  // made it compare as smaller than the true column value, so the keyset
  // predicate handed back an app the previous page had already shown. This
  // asserts the cursor is built from the full-precision `::text` column.
  it("preserves microsecond precision in the emitted nextCursor", async () => {
    const pool = fakePool([
      dbRow({
        created_at_text: "2026-07-28 13:30:57.663475+00",
        run_sort_text: "2026-07-28 13:30:57.663475+00",
      }),
    ]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { nextCursor } = await store!.listApps({ limit: 1, sort: "latest" });
    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe(`a1|2026-07-28 13:30:57.663475+00|${row.runId}`);
  });

  it("throws a 400 error for an undecodable cursor", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await expect(
      store!.listApps({ limit: 10, cursor: "!!!not-base64url!!!" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a single-field cursor (no separators at all)", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from("2026-07-27T10:00:00.000Z").toString("base64url");
    await expect(store!.listApps({ limit: 10, cursor })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it.each([
    [
      "wrong tag",
      "a0|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222",
    ],
    ["an empty run id", "a1|2026-07-27T10:00:00.000Z|"],
    ["an unparseable run_sort", "a1|not-a-date|22222222-2222-2222-2222-222222222222"],
    [
      "too many fields",
      "a1|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222|extra",
    ],
    // A hand-crafted or truncated runId (not a UUID at all) must 400 here,
    // not reach `$N::uuid` in the HAVING clause and blow up as a Postgres
    // 22P02 — that would surface as an uncaught 500 instead of a client
    // error. `not-even-uuid-shaped` covers "no dashes"; the digit-count case
    // below covers "right shape, wrong length".
    ["a non-UUID run id", "a1|2026-07-27T10:00:00.000Z|not-even-uuid-shaped"],
    [
      "a truncated run id",
      "a1|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-22222222222",
    ],
  ])("rejects a malformed a1 cursor with %s", async (_label, decoded) => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(decoded).toString("base64url");
    await expect(store!.listApps({ limit: 10, cursor })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it.each([
    [
      "a non-UUID run id",
      "l1|3|2026-07-27T10:00:00.000Z|not-even-uuid-shaped",
    ],
    [
      "a truncated run id",
      "l1|3|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-22222222222",
    ],
  ])("rejects a malformed l1 (popular) cursor with %s", async (_label, decoded) => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(decoded).toString("base64url");
    await expect(store!.listApps({ limit: 10, cursor, sort: "popular" })).rejects.toMatchObject(
      { statusCode: 400 },
    );
  });

  it("applies a valid a1 cursor as a row-wise keyset predicate on the app keys (sort=latest)", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(
      "a1|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222",
    ).toString("base64url");
    const { apps, nextCursor } = await store!.listApps({ limit: 10, cursor, sort: "latest" });

    expect(apps).toEqual([]);
    expect(nextCursor).toBeNull();
    // HAVING, not WHERE: run_sort is the MAX aggregate the query computes.
    expect(pool.calls[0].sql).toContain(
      "HAVING (MAX(created_at), showcase_screens.run_id) <",
    );
    expect(pool.calls[0].params).toEqual([
      "mobile",
      "2026-07-27T10:00:00.000Z",
      "22222222-2222-2222-2222-222222222222",
      10,
    ]);
  });

  it("applies a valid l1 cursor as a row-wise keyset predicate on (likes, run_sort, run_id) (sort=popular)", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(
      "l1|3|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222",
    ).toString("base64url");
    const { apps, nextCursor } = await store!.listApps({ limit: 10, cursor, sort: "popular" });

    expect(apps).toEqual([]);
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].sql).toContain(
      "HAVING (COALESCE(MAX(l.likes), 0), MAX(created_at), showcase_screens.run_id) <",
    );
    expect(pool.calls[0].params).toEqual([
      "mobile",
      3,
      "2026-07-27T10:00:00.000Z",
      "22222222-2222-2222-2222-222222222222",
      10,
    ]);
  });

  it("ignores a cursor whose tag disagrees with the requested sort and serves the page from the top", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    // An `a1` (latest) cursor against a `sort=popular` request — e.g. a tab
    // left open across a tab switch. Must not 400, and must not apply the
    // stale predicate.
    const cursor = Buffer.from(
      "a1|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222",
    ).toString("base64url");
    const { apps, nextCursor } = await store!.listApps({ limit: 10, cursor, sort: "popular" });

    expect(apps).toEqual([]);
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].sql).not.toContain("HAVING");
    expect(pool.calls[0].params).toEqual(["mobile", 10]);
  });

  it.each([
    [
      "the old two-field format (createdAt|id)",
      "2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ],
    [
      "the old three-field pinned-aware format (p1|createdAt|id)",
      "p1|2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ],
    [
      "the screen-addressing r2 format",
      "r2|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222|p1|2026-07-27T09:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ],
    ["a garbled old two-field cursor (empty timestamp, still 2 fields)", "|some-id"],
  ])("treats %s as legacy and restarts from the top of the feed", async (_label, decoded) => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(decoded).toString("base64url");
    const { apps, nextCursor } = await store!.listApps({ limit: 10, cursor });

    expect(apps).toEqual([]);
    expect(nextCursor).toBeNull();
    // No cursor predicate applied — only platform (always) and the limit made
    // it into params, same as an unpaginated first-page request.
    expect(pool.calls[0].params).toEqual(["mobile", 10]);
    expect(pool.calls[0].sql).not.toContain("HAVING");
  });

  describe("ordering and pagination against an in-memory feed", () => {
    it("orders screens within one app pinned-first, then newest-first", async () => {
      const runId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const db = fakeDb([
        makeRow({
          id: "s1",
          run_id: runId,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        }),
        makeRow({
          id: "s2",
          run_id: runId,
          created_at: new Date("2026-07-02T00:00:00.000Z"),
        }),
        makeRow({
          id: "s3",
          run_id: runId,
          created_at: new Date("2026-07-03T00:00:00.000Z"),
          pinned_at: new Date("2026-07-27T00:00:00.000Z"),
        }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const { apps } = await store!.listApps({ limit: 10 });
      expect(apps).toHaveLength(1);
      // s3 is pinned so it leads despite being newest anyway; s2 then s1
      // follow by created_at descending.
      expect(apps[0].screens.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
    });

    it("orders apps by recency of their most recent screen", async () => {
      const runOld = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runNew = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        // runOld's newest screen is older than runNew's oldest screen, so
        // runNew must come first even though it has a screen created earlier
        // than runOld's newest.
        makeRow({ id: "old-1", run_id: runOld, created_at: new Date("2026-07-01T00:00:00.000Z") }),
        makeRow({ id: "old-2", run_id: runOld, created_at: new Date("2026-07-02T00:00:00.000Z") }),
        makeRow({ id: "new-1", run_id: runNew, created_at: new Date("2026-07-10T00:00:00.000Z") }),
        makeRow({ id: "new-2", run_id: runNew, created_at: new Date("2026-07-15T00:00:00.000Z") }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const { apps } = await store!.listApps({ limit: 10 });
      expect(apps.map((a) => a.runId)).toEqual([runNew, runOld]);
      expect(apps[0].screens.map((s) => s.id)).toEqual(["new-2", "new-1"]);
      expect(apps[1].screens.map((s) => s.id)).toEqual(["old-2", "old-1"]);
      // An app's createdAt is its most recent screen's — what the feed sorts on.
      expect(apps[0].createdAt).toBe("2026-07-15T00:00:00.000Z");
    });

    // The bug this whole design replaces: with `limit` counting screens, a
    // page boundary could land inside an app, so the gallery — one card per
    // app — rendered a carousel missing screens until "Show more" was
    // clicked. Now `limit` counts apps, and every app arrives whole.
    it("never splits an app across a page boundary", async () => {
      const runA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({ id: "b-1", run_id: runB, created_at: new Date("2026-07-20T00:00:00.000Z") }),
        makeRow({ id: "a-1", run_id: runA, created_at: new Date("2026-07-10T00:00:00.000Z") }),
        makeRow({ id: "a-2", run_id: runA, created_at: new Date("2026-07-11T00:00:00.000Z") }),
        makeRow({ id: "a-3", run_id: runA, created_at: new Date("2026-07-12T00:00:00.000Z") }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );

      const page1 = await store!.listApps({ limit: 1 });
      expect(page1.apps.map((a) => a.runId)).toEqual([runB]);
      expect(page1.apps[0].screens.map((s) => s.id)).toEqual(["b-1"]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await store!.listApps({ limit: 1, cursor: page1.nextCursor! });
      expect(page2.apps.map((a) => a.runId)).toEqual([runA]);
      // All three of runA's screens, not just the ones that would have fit a
      // screen-counted page.
      expect(page2.apps[0].screens.map((s) => s.id)).toEqual(["a-3", "a-2", "a-1"]);

      // Page 2 exactly filled the limit, so a nextCursor is still handed
      // back (the store cannot know there's nothing left without another
      // round trip) — the real end of the feed only shows up as an empty
      // page 3.
      const page3 = await store!.listApps({ limit: 1, cursor: page2.nextCursor! });
      expect(page3.apps).toEqual([]);
      expect(page3.nextCursor).toBeNull();
    });

    // Regression: `run_sort` is the MAX(created_at) of an app's screens, and
    // Postgres compares it at microsecond precision. If the cursor were built
    // from the millisecond-truncated value, the app the page ended on would
    // compare as *greater than* its own cursor and come back again on the
    // next page — an infinite "Show more" that keeps re-showing one app.
    it("does not repeat the boundary app when its run_sort has sub-millisecond digits", async () => {
      const runA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({
          id: "b-1",
          run_id: runB,
          created_at: new Date("2026-07-20T00:00:00.500Z"),
          created_at_raw: "2026-07-20T00:00:00.500123Z",
        }),
        makeRow({ id: "a-1", run_id: runA, created_at: new Date("2026-07-10T00:00:00.000Z") }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );

      const page1 = await store!.listApps({ limit: 1 });
      expect(page1.apps.map((a) => a.runId)).toEqual([runB]);

      const page2 = await store!.listApps({ limit: 1, cursor: page1.nextCursor! });
      // Before the precision fix this would have been runB a second time.
      expect(page2.apps.map((a) => a.runId)).toEqual([runA]);
    });
  });

  describe("popular sort, likes, and category filtering", () => {
    it("orders apps by likes descending, ignoring recency", async () => {
      const runOld = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // fewer likes, newer
      const runNew = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // more likes, older
      const db = fakeDb([
        makeRow({ id: "old-1", run_id: runOld, created_at: new Date("2026-07-20T00:00:00.000Z"), likes: 1 }),
        makeRow({ id: "new-1", run_id: runNew, created_at: new Date("2026-07-01T00:00:00.000Z"), likes: 5 }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const { apps } = await store!.listApps({ limit: 10, sort: "popular" });
      expect(apps.map((a) => a.runId)).toEqual([runNew, runOld]);
      expect(apps[0].likes).toBe(5);
      expect(apps[1].likes).toBe(1);
    });

    it("breaks a like-count tie by recency, same as the latest sort would", async () => {
      const runOlder = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runNewer = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({ id: "older-1", run_id: runOlder, created_at: new Date("2026-07-01T00:00:00.000Z"), likes: 2 }),
        makeRow({ id: "newer-1", run_id: runNewer, created_at: new Date("2026-07-20T00:00:00.000Z"), likes: 2 }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const { apps } = await store!.listApps({ limit: 10, sort: "popular" });
      expect(apps.map((a) => a.runId)).toEqual([runNewer, runOlder]);
    });

    // The row-wise-tuple-comparison bug this design deliberately avoids: with
    // ANDed columns, a cursor crossing the boundary between two apps that
    // tie on likes would either repeat or drop whichever one sits exactly at
    // the page edge. Three apps tie on likes; page size 2 puts the boundary
    // between the 2nd and 3rd.
    it("does not duplicate or drop an app when the cursor crosses a like-count tie", async () => {
      const runA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // newest of the tied three
      const runB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const runC = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // oldest of the tied three
      const db = fakeDb([
        makeRow({ id: "a-1", run_id: runA, created_at: new Date("2026-07-20T00:00:00.000Z"), likes: 3 }),
        makeRow({ id: "b-1", run_id: runB, created_at: new Date("2026-07-10T00:00:00.000Z"), likes: 3 }),
        makeRow({ id: "c-1", run_id: runC, created_at: new Date("2026-07-01T00:00:00.000Z"), likes: 3 }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );

      const page1 = await store!.listApps({ limit: 2, sort: "popular" });
      expect(page1.apps.map((a) => a.runId)).toEqual([runA, runB]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await store!.listApps({
        limit: 2,
        sort: "popular",
        cursor: page1.nextCursor!,
      });
      // Exactly runC — neither a repeat of runB nor a skip past runC.
      expect(page2.apps.map((a) => a.runId)).toEqual([runC]);
      expect(page2.nextCursor).toBeNull();
    });

    it("filters to one theme, in either sort", async () => {
      const runFitness = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runFinance = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({ id: "f-1", run_id: runFitness, theme: "fitness", created_at: new Date("2026-07-01T00:00:00.000Z"), likes: 1 }),
        makeRow({ id: "m-1", run_id: runFinance, theme: "finance", created_at: new Date("2026-07-20T00:00:00.000Z"), likes: 9 }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );

      const popular = await store!.listApps({ limit: 10, sort: "popular", category: "fitness" });
      expect(popular.apps.map((a) => a.runId)).toEqual([runFitness]);

      const latest = await store!.listApps({ limit: 10, sort: "latest", category: "fitness" });
      expect(latest.apps.map((a) => a.runId)).toEqual([runFitness]);
    });

    it("never returns an app from a different theme, even when it would otherwise sort first", async () => {
      const runFitness = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runFinance = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({ id: "f-1", run_id: runFitness, theme: "fitness", likes: 100 }),
        makeRow({ id: "m-1", run_id: runFinance, theme: "finance", likes: 1 }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const { apps } = await store!.listApps({ limit: 10, sort: "popular", category: "finance" });
      expect(apps.map((a) => a.runId)).toEqual([runFinance]);
    });
  });

  describe("listCategories", () => {
    it("counts distinct apps per theme, ordered by count then theme", async () => {
      const db = fakeDb([
        makeRow({ id: "a-1", run_id: "run-a", theme: "fitness" }),
        makeRow({ id: "a-2", run_id: "run-a", theme: "fitness" }), // same run — must not double count
        makeRow({ id: "b-1", run_id: "run-b", theme: "fitness" }),
        makeRow({ id: "c-1", run_id: "run-c", theme: "finance" }),
        makeRow({ id: "d-1", run_id: "run-d", theme: "art", published: false }), // unpublished — excluded
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const categories = await store!.listCategories();
      expect(categories).toEqual([
        { theme: "fitness", apps: 2 },
        { theme: "finance", apps: 1 },
      ]);
    });

    it("orders ties alphabetically by theme", async () => {
      const db = fakeDb([
        makeRow({ id: "z-1", run_id: "run-z", theme: "zebra" }),
        makeRow({ id: "a-1", run_id: "run-a", theme: "apple" }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const categories = await store!.listCategories();
      expect(categories.map((c) => c.theme)).toEqual(["apple", "zebra"]);
    });
  });

  describe("listModels", () => {
    it("issues COUNT(DISTINCT run_id) GROUP BY model ORDER BY apps DESC, model ASC", async () => {
      const pool = fakePool([{ model: "deepseek/deepseek-v4-pro", apps: "2" }]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const models = await store!.listModels();
      expect(pool.calls[0].sql).toContain("COUNT(DISTINCT run_id)");
      expect(pool.calls[0].sql).toContain("GROUP BY model");
      expect(pool.calls[0].sql).toContain("ORDER BY apps DESC, model ASC");
      expect(pool.calls[0].sql).toMatch(/WHERE published = true AND platform = \$1/);
      expect(pool.calls[0].params).toEqual(["mobile"]);
      expect(models).toEqual([{ model: "deepseek/deepseek-v4-pro", apps: 2 }]);
    });

    it("defaults platform to mobile and passes an explicit platform through", async () => {
      const pool = fakePool([]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.listModels("desktop");
      expect(pool.calls[0].params).toEqual(["desktop"]);
    });
  });

  describe("likeApp", () => {
    it("returns null for a run_id with no published screens", async () => {
      const db = fakeDb([]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const result = await store!.likeApp("does-not-exist", 3);
      expect(result).toBeNull();
    });

    it("upsert-increments and returns the new total", async () => {
      const runId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const db = fakeDb([makeRow({ id: "a-1", run_id: runId, likes: 2 })]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      const first = await store!.likeApp(runId, 3);
      expect(first).toBe(5);
      const second = await store!.likeApp(runId, 1);
      expect(second).toBe(6);
    });

    it("returns null for a run_id whose screens all got deleted (delete is rows-only)", async () => {
      const runId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      // No showcase_screens row for this run_id at all, even though a like
      // row could in principle still exist from before the delete.
      const db = fakeDb([]);
      db.likes.set(runId, 4);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );
      expect(await store!.likeApp(runId, 1)).toBeNull();
    });
  });

  describe("pinScreen", () => {
    it("returns false and issues no update for an unknown id", async () => {
      const pool = fakePool([]); // existence check finds nothing
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const ok = await store!.pinScreen("does-not-exist");
      expect(ok).toBe(false);
      expect(pool.calls).toHaveLength(1); // only the existence check ran
      expect(pool.calls[0].sql).toContain("SELECT run_id FROM showcase_screens");
    });

    it("clears the run's pin BEFORE setting the new one, both scoped to that run", async () => {
      const pool = fakePool([{ run_id: row.runId }]); // existence check finds the row
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const ok = await store!.pinScreen(row.id);
      expect(ok).toBe(true);
      expect(pool.calls).toHaveLength(3);
      // Order is the whole point: the partial unique index on (run_id) WHERE
      // pinned_at IS NOT NULL is enforced per row, so setting before clearing
      // — or doing both in one UPDATE, as this used to — raises 23505 on any
      // app that already has a cover.
      expect(pool.calls[1].sql).toContain("SET pinned_at = NULL");
      expect(pool.calls[1].sql).toContain("run_id = $1");
      expect(pool.calls[1].params).toEqual([row.runId]);
      expect(pool.calls[2].sql).toContain("SET pinned_at = now()");
      expect(pool.calls[2].sql).toContain("WHERE id = $1 AND run_id = $2");
      expect(pool.calls[2].params).toEqual([row.id, row.runId]);
    });

    it("leaves another run's pin intact when pinning a screen in a different run", async () => {
      const runA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({ id: "a-1", run_id: runA, pinned_at: new Date("2026-07-01T00:00:00.000Z") }),
        makeRow({ id: "b-1", run_id: runB }),
        makeRow({ id: "b-2", run_id: runB }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );

      const ok = await store!.pinScreen("b-2");
      expect(ok).toBe(true);
      const a1 = db.rows.find((r) => r.id === "a-1")!;
      const b1 = db.rows.find((r) => r.id === "b-1")!;
      const b2 = db.rows.find((r) => r.id === "b-2")!;
      expect(a1.pinned_at).not.toBeNull(); // untouched by a pin in a different run
      expect(b1.pinned_at).toBeNull();
      expect(b2.pinned_at).not.toBeNull();
    });
  });

  describe("clearPin", () => {
    it("unsets pinned_at on whatever is currently pinned, across every run", async () => {
      const pool = fakePool([]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.clearPin();
      expect(pool.calls).toHaveLength(1);
      expect(pool.calls[0].sql).toContain("SET pinned_at = NULL");
      expect(pool.calls[0].sql).toContain("WHERE pinned_at IS NOT NULL");
      expect(pool.calls[0].sql).not.toContain("run_id");
      expect(pool.calls[0].params).toEqual([]);
    });

    it("clears only the given run's pin, leaving other runs alone", async () => {
      const runA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({ id: "a-1", run_id: runA, pinned_at: new Date("2026-07-01T00:00:00.000Z") }),
        makeRow({ id: "b-1", run_id: runB, pinned_at: new Date("2026-07-02T00:00:00.000Z") }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );

      await store!.clearPin(runA);

      expect(db.rows.find((r) => r.id === "a-1")!.pinned_at).toBeNull();
      expect(db.rows.find((r) => r.id === "b-1")!.pinned_at).not.toBeNull();
    });
  });

  it("recentThemes returns distinct themes, freshest first", async () => {
    const pool = fakePool([{ theme: "fitness" }, { theme: "finance" }]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const themes = await store!.recentThemes(5);
    expect(themes).toEqual(["fitness", "finance"]);
    expect(pool.calls[0].sql).toContain("GROUP BY theme");
  });

  it("recentRunHtmlUrls returns one screen per run, freshest first", async () => {
    const pool = fakePool([
      { html_url: "https://cdn.test/b.html" },
      { html_url: "https://cdn.test/a.html" },
    ]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const urls = await store!.recentRunHtmlUrls(6);
    expect(urls).toEqual(["https://cdn.test/b.html", "https://cdn.test/a.html"]);
    expect(pool.calls[0].sql).toContain("DISTINCT ON (run_id)");
    expect(pool.calls[0].params).toEqual([6]);
  });

  describe("updateScreenDerivatives", () => {
    it("writes image_url/image_url_1x/lqip/width/height for the given id", async () => {
      const pool = fakePool();
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.updateScreenDerivatives({
        id: row.id,
        imageUrl: "https://cdn.example.test/1-abcd1234.webp",
        imageUrl1x: "https://cdn.example.test/1-abcd1234@1x.webp",
        lqip: "data:image/webp;base64,AAAA",
        width: 750,
        height: 1960,
      });
      expect(pool.calls).toHaveLength(1);
      expect(pool.calls[0].sql).toContain(
        "SET image_url = $2, image_url_1x = $3, lqip = $4, width = $5, height = $6",
      );
      expect(pool.calls[0].params).toEqual([
        row.id,
        "https://cdn.example.test/1-abcd1234.webp",
        "https://cdn.example.test/1-abcd1234@1x.webp",
        "data:image/webp;base64,AAAA",
        750,
        1960,
      ]);
    });
  });

  describe("listScreenImages", () => {
    it("maps rows for backfilling, NULL image_url_1x becoming undefined", async () => {
      const pool = fakePool([
        {
          id: "a",
          title: "Screen A",
          image_url: "https://cdn.example.test/a.png",
          image_url_1x: null,
        },
        {
          id: "b",
          title: "Screen B",
          image_url: "https://cdn.example.test/b-abcd1234.webp",
          image_url_1x: "https://cdn.example.test/b-abcd1234@1x.webp",
        },
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const screens = await store!.listScreenImages();
      expect(screens).toEqual([
        { id: "a", title: "Screen A", imageUrl: "https://cdn.example.test/a.png", imageUrl1x: undefined },
        {
          id: "b",
          title: "Screen B",
          imageUrl: "https://cdn.example.test/b-abcd1234.webp",
          imageUrl1x: "https://cdn.example.test/b-abcd1234@1x.webp",
        },
      ]);
    });
  });

  describe("deleteScreens", () => {
    it("resolves an app target through run_id or screen id and returns the rows", async () => {
      const pool = fakePool([{ id: "a", run_id: "r1", title: "Home" }]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const deleted = await store!.deleteScreens({ appOf: "a" });
      expect(deleted).toEqual([{ id: "a", runId: "r1", title: "Home" }]);
      expect(pool.calls[0].sql).toContain("DELETE FROM showcase_screens");
      // The same COALESCE(screen -> run) resolution `listScreenSources` uses,
      // so `--app <screen-id>` takes that screen's whole run.
      expect(pool.calls[0].sql).toContain(
        "WHERE run_id = COALESCE((SELECT run_id FROM showcase_screens WHERE id = $1::uuid), $1::uuid)",
      );
      expect(pool.calls[0].sql).toContain("RETURNING id, run_id, title");
      expect(pool.calls[0].params).toEqual(["a"]);
    });

    it("deletes a single screen by id, without widening to its run", async () => {
      const pool = fakePool([]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const deleted = await store!.deleteScreens({ screen: "a" });
      expect(deleted).toEqual([]);
      expect(pool.calls[0].sql).toContain("WHERE id = $1::uuid");
      expect(pool.calls[0].sql).not.toContain("run_id = COALESCE");
    });

    // A programmable fake, unlike `fakePool` above (which returns the same
    // fixed rows for every call): these tests need the DELETE and the
    // follow-up likes cleanup to see different results in sequence.
    function sequencedPool(
      responses: Array<{ rows: unknown[] }>,
    ): TraceQueryable & { calls: Array<{ sql: string; params?: unknown[] }> } {
      const calls: Array<{ sql: string; params?: unknown[] }> = [];
      let i = 0;
      return {
        calls,
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params });
          const response = responses[Math.min(i, responses.length - 1)];
          i += 1;
          return response;
        }),
        end: vi.fn(async () => {}),
      };
    }

    it("deletes the app's likes row when a whole app is removed", async () => {
      const pool = sequencedPool([
        { rows: [{ id: "a", run_id: "r1", title: "Home" }] },
        { rows: [] },
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.deleteScreens({ appOf: "a" });
      expect(pool.calls).toHaveLength(2);
      expect(pool.calls[1].sql).toContain("DELETE FROM showcase_app_likes");
      expect(pool.calls[1].sql).toContain("run_id = ANY($1::uuid[])");
      expect(pool.calls[1].params).toEqual([["r1"]]);
    });

    it("does not touch showcase_app_likes when the app target matched nothing", async () => {
      const pool = sequencedPool([{ rows: [] }]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.deleteScreens({ appOf: "missing" });
      expect(pool.calls).toHaveLength(1);
    });

    it("deletes the likes row when a single screen was its run's last published screen", async () => {
      const pool = sequencedPool([
        { rows: [{ id: "s2", run_id: "r1", title: "Last screen" }] },
        // The "any published screens left?" existence check comes back empty.
        { rows: [] },
        { rows: [] },
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.deleteScreens({ screen: "s2" });
      expect(pool.calls).toHaveLength(3);
      expect(pool.calls[1].sql).toContain(
        "SELECT 1 FROM showcase_screens WHERE run_id = $1 AND published = true",
      );
      expect(pool.calls[2].sql).toContain("DELETE FROM showcase_app_likes");
      expect(pool.calls[2].sql).not.toContain("ANY");
      expect(pool.calls[2].params).toEqual(["r1"]);
    });

    it("keeps the likes row when the run still has other published screens", async () => {
      const pool = sequencedPool([
        { rows: [{ id: "s2", run_id: "r1", title: "One of several" }] },
        // The existence check finds a surviving published screen.
        { rows: [{}] },
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.deleteScreens({ screen: "s2" });
      expect(pool.calls).toHaveLength(2);
      expect(pool.calls[1].sql).toContain("SELECT 1 FROM showcase_screens");
    });
  });
});
