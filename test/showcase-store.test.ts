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

  function dbRow(overrides: Partial<{ pinned_at: Date | null }> = {}) {
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
      ...overrides,
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
    expect(pool.calls[0].sql).toContain(
      "ORDER BY (pinned_at IS NOT NULL) DESC, created_at DESC, id DESC",
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
    expect(decoded).toBe(`p0|2026-07-27T10:00:00.000Z|${row.id}`);
  });

  it("encodes the cursor as pinned when the last screen on the page is pinned", async () => {
    const pool = fakePool([dbRow({ pinned_at: new Date("2026-07-28T09:00:00.000Z") })]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { nextCursor } = await store!.listScreens({ limit: 1 });
    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe(`p1|2026-07-27T10:00:00.000Z|${row.id}`);
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

  it.each([
    ["no separator", Buffer.from("2026-07-27T10:00:00.000Z").toString("base64url")],
    ["an empty timestamp", Buffer.from("|some-id").toString("base64url")],
    ["an empty id", Buffer.from("2026-07-27T10:00:00.000Z|").toString("base64url")],
    ["an unparseable timestamp", Buffer.from("not-a-date|some-id").toString("base64url")],
  ])("rejects a cursor with %s", async (_label, cursor) => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await expect(
      store!.listScreens({ limit: 10, cursor }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("applies a valid pinned-format cursor as a row-wise keyset predicate", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(
      "p1|2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ).toString("base64url");
    const { screens, nextCursor } = await store!.listScreens({ limit: 10, cursor });

    expect(screens).toEqual([]);
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].sql).toContain("((pinned_at IS NOT NULL), created_at, id) <");
    expect(pool.calls[0].params).toEqual([
      true,
      "2026-07-27T10:00:00.000Z",
      "11111111-1111-1111-1111-111111111111",
      10,
    ]);
  });

  it("accepts the old two-field cursor format as pinned=false", async () => {
    const pool = fakePool([]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const cursor = Buffer.from(
      "2026-07-27T10:00:00.000Z|11111111-1111-1111-1111-111111111111",
    ).toString("base64url");
    const { screens, nextCursor } = await store!.listScreens({ limit: 10, cursor });

    expect(screens).toEqual([]);
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].params).toEqual([
      false,
      "2026-07-27T10:00:00.000Z",
      "11111111-1111-1111-1111-111111111111",
      10,
    ]);
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

  describe("pinScreen", () => {
    it("returns false and issues no update for an unknown id", async () => {
      const pool = fakePool([]); // SELECT 1 ... finds nothing
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const ok = await store!.pinScreen("does-not-exist");
      expect(ok).toBe(false);
      expect(pool.calls).toHaveLength(1); // only the existence check ran
      expect(pool.calls[0].sql).toContain("SELECT 1 FROM showcase_screens");
    });

    it("clears every other pin and sets the given id in one update", async () => {
      const pool = fakePool([{ "?column?": 1 }]); // existence check finds the row
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      const ok = await store!.pinScreen(row.id);
      expect(ok).toBe(true);
      expect(pool.calls).toHaveLength(2);
      expect(pool.calls[1].sql).toContain("CASE WHEN id = $1 THEN now() ELSE NULL END");
      expect(pool.calls[1].sql).toContain("pinned_at IS NOT NULL OR id = $1");
      expect(pool.calls[1].params).toEqual([row.id]);
    });
  });

  describe("clearPin", () => {
    it("unsets pinned_at on whatever is currently pinned", async () => {
      const pool = fakePool([]);
      const store = createShowcaseStore(
        makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
        pool,
      );
      await store!.clearPin();
      expect(pool.calls).toHaveLength(1);
      expect(pool.calls[0].sql).toContain("SET pinned_at = NULL");
      expect(pool.calls[0].sql).toContain("WHERE pinned_at IS NOT NULL");
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
