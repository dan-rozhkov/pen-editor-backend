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

function fakeDb(initialRows: FakeRow[]): TraceQueryable & { rows: FakeRow[] } {
  const rows = initialRows.map((r) => ({ ...r }));

  async function query(sql: string, params: unknown[] = []) {
    if (sql.includes("INSERT INTO showcase_screens")) {
      const [id, run_id, theme, title, prompt, model, image_url, html_url, width, height] =
        params as [string, string, string, string, string, string, string, string, number, number];
      rows.push({
        id,
        run_id,
        theme,
        title,
        prompt,
        model,
        image_url,
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

    if (sql.includes("SET pinned_at = CASE WHEN id = $1")) {
      // Refuse to interpret this as the store's real pinScreen update unless
      // the run-scoping fragment is present verbatim — otherwise a regression
      // that drops `run_id = $2` from the production SQL would silently keep
      // being "understood" by this fake as scoped, and no behavioral test
      // would ever see the bug.
      if (!sql.includes("run_id = $2 AND (pinned_at IS NOT NULL OR id = $1)")) {
        throw new Error(
          `unrecognized query (pinScreen scoping fragment missing/changed): ${sql}`,
        );
      }
      const [id, runId] = params as [string, string];
      for (const r of rows) {
        if (r.run_id === runId && (r.pinned_at !== null || r.id === id)) {
          r.pinned_at = r.id === id ? new Date() : null;
        }
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

    if (sql.includes("MAX(created_at) OVER")) {
      // Same refusal as above: only interpret this as the store's real
      // listScreens query if its load-bearing ORDER BY matches exactly. A
      // flipped sort direction, a reordered column, or a dropped tiebreaker
      // in the real SQL must make this fake stop understanding the query,
      // not silently keep sorting/filtering in JS against a query shape that
      // no longer exists.
      const orderBy =
        "ORDER BY run_sort DESC, run_id DESC, (pinned_at IS NOT NULL) DESC, created_at DESC, id DESC";
      if (!sql.includes(orderBy)) {
        throw new Error(`unrecognized query (ORDER BY changed): ${sql}`);
      }

      const limit = params[params.length - 1] as number;

      // Read the cursor bounds out of `params` by the placeholder numbers
      // that actually appear in the row-wise predicate, rather than assuming
      // a fixed position — so a reordered/renumbered $n in the real SQL shows
      // up as a wrong cursor value here instead of being invisible.
      const predicateMatch = sql.match(
        /\(run_sort, run_id, \(pinned_at IS NOT NULL\), created_at, id\) < \(\$(\d+)::timestamptz, \$(\d+)::uuid, \$(\d+)::boolean, \$(\d+)::timestamptz, \$(\d+)::uuid\)/,
      );
      if (sql.includes("WHERE (run_sort") && !predicateMatch) {
        throw new Error(`unrecognized query (cursor predicate shape changed): ${sql}`);
      }
      // Cursor params are, post-fix, the full-precision `::text` form (e.g.
      // "2026-07-28 13:30:57.663475+00"), not the millisecond-precision ISO
      // `toIso()` used to produce — so they're compared via `preciseMicros`
      // below, same as every row, rather than through a `Date` that would
      // silently re-truncate them back to milliseconds.
      const cursor = predicateMatch
        ? {
            runSort: preciseMicros(params[Number(predicateMatch[1]) - 1] as string),
            runId: params[Number(predicateMatch[2]) - 1] as string,
            pinned: params[Number(predicateMatch[3]) - 1] as boolean,
            createdAt: preciseMicros(params[Number(predicateMatch[4]) - 1] as string),
            id: params[Number(predicateMatch[5]) - 1] as string,
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
      for (const r of rows) {
        if (!r.published) continue;
        const raw = rawOf(r);
        const micros = preciseMicros(raw);
        if (micros > (runSortMicrosByRun.get(r.run_id) ?? -Infinity)) {
          runSortMicrosByRun.set(r.run_id, micros);
          runSortRawByRun.set(r.run_id, raw);
        }
      }

      const withSort = rows
        .filter((r) => r.published)
        .map((r) => ({
          r,
          runSortMicros: runSortMicrosByRun.get(r.run_id)!,
          runSortRaw: runSortRawByRun.get(r.run_id)!,
          createdMicros: preciseMicros(rawOf(r)),
        }));

      withSort.sort((a, b) => {
        if (a.runSortMicros !== b.runSortMicros) return b.runSortMicros - a.runSortMicros;
        if (a.r.run_id !== b.r.run_id) return a.r.run_id < b.r.run_id ? 1 : -1;
        const aPinned = a.r.pinned_at !== null;
        const bPinned = b.r.pinned_at !== null;
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        if (a.createdMicros !== b.createdMicros) return b.createdMicros - a.createdMicros;
        return a.r.id < b.r.id ? 1 : -1;
      });

      function tuple(x: (typeof withSort)[number]) {
        return [
          x.runSortMicros,
          x.r.run_id,
          x.r.pinned_at !== null,
          x.createdMicros,
          x.r.id,
        ] as const;
      }
      function lessThan(a: ReturnType<typeof tuple>, b: ReturnType<typeof tuple>): boolean {
        for (let i = 0; i < a.length; i++) {
          if (a[i] === b[i]) continue;
          return a[i] < b[i];
        }
        return false;
      }

      const filtered = cursor
        ? withSort.filter((x) =>
            lessThan(tuple(x), [
              cursor.runSort,
              cursor.runId,
              cursor.pinned,
              cursor.createdAt,
              cursor.id,
            ]),
          )
        : withSort;

      const page = filtered.slice(0, limit);
      return {
        rows: page.map(({ r, runSortRaw }) => ({
          id: r.id,
          run_id: r.run_id,
          theme: r.theme,
          title: r.title,
          prompt: r.prompt,
          model: r.model,
          image_url: r.image_url,
          html_url: r.html_url,
          width: r.width,
          height: r.height,
          created_at: r.created_at,
          pinned_at: r.pinned_at,
          run_sort: new Date(runSortRaw),
          created_at_text: rawOf(r),
          run_sort_text: runSortRaw,
        })),
      };
    }

    throw new Error(`unrecognized query — no branch of the fake matched: ${sql}`);
  }

  return { rows, query: vi.fn(query), end: vi.fn(async () => {}) };
}

function makeRow(overrides: Partial<FakeRow> & { id: string; run_id: string }): FakeRow {
  return {
    theme: "fitness",
    title: "Screen",
    prompt: "a screen",
    model: "google/gemini-2.5-flash",
    image_url: "https://cdn.example.test/x.png",
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
  });

  function dbRow(
    overrides: Partial<{
      pinned_at: Date | null;
      created_at_text: string;
      run_sort_text: string;
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
      html_url: row.htmlUrl,
      width: row.width,
      height: row.height,
      created_at: new Date("2026-07-27T10:00:00.000Z"),
      pinned_at: null,
      run_sort: new Date("2026-07-27T10:00:00.000Z"),
      // Defaults match the millisecond-precision fixture above — real
      // Postgres `::text` output would differ only when the underlying
      // column actually carries sub-millisecond digits, which the dedicated
      // microsecond-precision tests below exercise explicitly.
      created_at_text: created_at_text ?? "2026-07-27T10:00:00.000Z",
      run_sort_text: run_sort_text ?? "2026-07-27T10:00:00.000Z",
      ...rest,
    };
  }

  it("lists published screens with keyset pagination and no next cursor when under limit", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { screens, nextCursor } = await store!.listScreens({ limit: 24 });
    expect(screens).toHaveLength(1);
    expect(screens[0].createdAt).toBe("2026-07-27T10:00:00.000Z");
    expect(screens[0].pinned).toBe(false);
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].sql).toContain("published = true");
    expect(pool.calls[0].sql).toContain("MAX(created_at) OVER (PARTITION BY run_id)");
    expect(pool.calls[0].sql).toContain(
      "ORDER BY run_sort DESC, run_id DESC, (pinned_at IS NOT NULL) DESC, created_at DESC, id DESC",
    );
  });

  it("marks a screen with pinned_at set as pinned", async () => {
    const pool = fakePool([dbRow({ pinned_at: new Date("2026-07-28T09:00:00.000Z") })]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { screens } = await store!.listScreens({ limit: 24 });
    expect(screens[0].pinned).toBe(true);
  });

  it("returns a nextCursor when the page is full", async () => {
    const pool = fakePool([dbRow()]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { nextCursor } = await store!.listScreens({ limit: 1 });
    expect(nextCursor).not.toBeNull();

    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe(
      `r2|2026-07-27T10:00:00.000Z|${row.runId}|p0|2026-07-27T10:00:00.000Z|${row.id}`,
    );
  });

  it("encodes the cursor as pinned when the last screen on the page is pinned", async () => {
    const pool = fakePool([dbRow({ pinned_at: new Date("2026-07-28T09:00:00.000Z") })]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { nextCursor } = await store!.listScreens({ limit: 1 });
    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe(
      `r2|2026-07-27T10:00:00.000Z|${row.runId}|p1|2026-07-27T10:00:00.000Z|${row.id}`,
    );
  });

  // Regression for the pagination bug rooted in timestamp precision:
  // Postgres stores `created_at` (and the `run_sort` window aggregate
  // derived from it) with microsecond precision, but `toIso()`/the pg
  // driver's `Date` truncate to milliseconds. Building the cursor from the
  // truncated value made it compare as smaller than the true column value,
  // so the keyset predicate (`run_sort` is its first key) dropped every
  // remaining row of the run the page ended in. This asserts the cursor is
  // now built from the full-precision `::text` columns, not the truncated
  // ones — before the fix, `nextCursor` would have decoded to
  // ".663Z"-truncated timestamps instead of the ".663475+00" below.
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
    const { nextCursor } = await store!.listScreens({ limit: 1 });
    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe(
      `r2|2026-07-28 13:30:57.663475+00|${row.runId}|p0|2026-07-28 13:30:57.663475+00|${row.id}`,
    );
  });

  it("throws a 400 error for an undecodable cursor", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await expect(
      store!.listScreens({ limit: 10, cursor: "!!!not-base64url!!!" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a single-field cursor (no separators at all)", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from("2026-07-27T10:00:00.000Z").toString("base64url");
    await expect(store!.listScreens({ limit: 10, cursor })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects a three-part cursor with an invalid pinned flag", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(
      "pX|2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ).toString("base64url");
    await expect(
      store!.listScreens({ limit: 10, cursor }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each([
    [
      "wrong tag",
      "r1|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222|p1|2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ],
    [
      "invalid pinned flag",
      "r2|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222|pX|2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ],
    [
      "an empty run id",
      "r2|2026-07-27T10:00:00.000Z||p1|2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ],
    [
      "an unparseable run_sort",
      "r2|not-a-date|22222222-2222-2222-2222-222222222222|p1|2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ],
    [
      "an unparseable created_at",
      "r2|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222|p1|not-a-date|11111111-1111-1111-1111-111111111111",
    ],
  ])("rejects a malformed r2 cursor with %s", async (_label, decoded) => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(decoded).toString("base64url");
    await expect(
      store!.listScreens({ limit: 10, cursor }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("applies a valid r2 cursor as a row-wise keyset predicate", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(
      "r2|2026-07-27T10:00:00.000Z|22222222-2222-2222-2222-222222222222|p1|2026-07-27T09:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ).toString("base64url");
    const { screens, nextCursor } = await store!.listScreens({ limit: 10, cursor });

    expect(screens).toEqual([]);
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].sql).toContain(
      "(run_sort, run_id, (pinned_at IS NOT NULL), created_at, id) <",
    );
    expect(pool.calls[0].params).toEqual([
      "2026-07-27T10:00:00.000Z",
      "22222222-2222-2222-2222-222222222222",
      true,
      "2026-07-27T09:00:00.000Z",
      "11111111-1111-1111-1111-111111111111",
      10,
    ]);
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
    ["a garbled old two-field cursor (empty timestamp, still 2 fields)", "|some-id"],
  ])("treats %s as legacy and restarts from the top of the feed", async (_label, decoded) => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(decoded).toString("base64url");
    const { screens, nextCursor } = await store!.listScreens({ limit: 10, cursor });

    expect(screens).toEqual([]);
    expect(nextCursor).toBeNull();
    // No cursor predicate applied — only the limit made it into params, same
    // as an unpaginated first-page request.
    expect(pool.calls[0].params).toEqual([10]);
    expect(pool.calls[0].sql).not.toContain("WHERE (run_sort");
  });

  describe("ordering and pagination against an in-memory feed", () => {
    it("orders screens within one run pinned-first, then newest-first", async () => {
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
      const { screens } = await store!.listScreens({ limit: 10 });
      // s3 is pinned so it leads despite being newest anyway; s2 then s1
      // follow by created_at descending.
      expect(screens.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
    });

    it("orders apps (runs) by recency of their most recent screen", async () => {
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
      const { screens } = await store!.listScreens({ limit: 10 });
      expect(screens.map((s) => s.id)).toEqual(["new-2", "new-1", "old-2", "old-1"]);
      // Screens of one run are contiguous, never interleaved.
      expect(screens.map((s) => s.runId)).toEqual([runNew, runNew, runOld, runOld]);
    });

    it("paginates across a page boundary that splits a run", async () => {
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

      const page1 = await store!.listScreens({ limit: 2 });
      expect(page1.screens.map((s) => s.id)).toEqual(["b-1", "a-3"]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await store!.listScreens({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.screens.map((s) => s.id)).toEqual(["a-2", "a-1"]);

      // Page 2 exactly filled the limit, so a nextCursor is still handed
      // back (the store cannot know there's nothing left without another
      // round trip) — the real end of the feed only shows up as an empty
      // page 3.
      const page3 = await store!.listScreens({ limit: 2, cursor: page2.nextCursor! });
      expect(page3.screens).toEqual([]);
      expect(page3.nextCursor).toBeNull();
    });

    // Regression: `run_sort` is the same value (MAX(created_at)) for every
    // screen of a run, so when the page boundary falls mid-run, the cursor's
    // `run_sort` must match the *other* remaining screens' `run_sort` at full
    // precision — not just the millisecond-truncated value `toIso()` would
    // have produced. runA's newest screen (a-3, which defines its run_sort)
    // carries real sub-millisecond digits (".500123"); if the cursor were
    // built from a millisecond-truncated ".500000" instead, a-2/a-1 (which
    // share that same true run_sort) would compare as *greater than* the
    // cursor's run_sort — the first of the five sort keys — and be dropped
    // for good, exactly the production bug this fix addresses.
    it("does not drop a run's remaining screens at a page boundary when timestamps differ only in sub-millisecond digits", async () => {
      const runA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const runB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const db = fakeDb([
        makeRow({ id: "b-1", run_id: runB, created_at: new Date("2026-07-20T00:00:00.000Z") }),
        makeRow({ id: "a-1", run_id: runA, created_at: new Date("2026-07-10T00:00:00.000Z") }),
        makeRow({ id: "a-2", run_id: runA, created_at: new Date("2026-07-11T00:00:00.000Z") }),
        makeRow({
          id: "a-3",
          run_id: runA,
          created_at: new Date("2026-07-12T00:00:00.500Z"),
          created_at_raw: "2026-07-12T00:00:00.500123Z",
        }),
      ]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        db,
      );

      const page1 = await store!.listScreens({ limit: 2 });
      expect(page1.screens.map((s) => s.id)).toEqual(["b-1", "a-3"]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await store!.listScreens({ limit: 2, cursor: page1.nextCursor! });
      // Before the fix, a-2 and a-1 (sharing runA's true, microsecond-precise
      // run_sort) would fail the `< cursor` predicate on the run_sort key
      // alone and this page would come back empty.
      expect(page2.screens.map((s) => s.id)).toEqual(["a-2", "a-1"]);

      const page3 = await store!.listScreens({ limit: 2, cursor: page2.nextCursor! });
      expect(page3.screens).toEqual([]);
      expect(page3.nextCursor).toBeNull();
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

    it("clears every other pin within the same run and sets the given id in one update", async () => {
      const pool = fakePool([{ run_id: row.runId }]); // existence check finds the row
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const ok = await store!.pinScreen(row.id);
      expect(ok).toBe(true);
      expect(pool.calls).toHaveLength(2);
      expect(pool.calls[1].sql).toContain("CASE WHEN id = $1 THEN now() ELSE NULL END");
      expect(pool.calls[1].sql).toContain("run_id = $2 AND (pinned_at IS NOT NULL OR id = $1)");
      expect(pool.calls[1].params).toEqual([row.id, row.runId]);
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
});
