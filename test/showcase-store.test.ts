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

  it("lists published screens with keyset pagination and no next cursor when under limit", async () => {
    const dbRow = {
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
    };
    const pool = fakePool([dbRow]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { screens, nextCursor } = await store!.listScreens({ limit: 24 });
    expect(screens).toHaveLength(1);
    expect(screens[0].createdAt).toBe("2026-07-27T10:00:00.000Z");
    expect(nextCursor).toBeNull();
    expect(pool.calls[0].sql).toContain("published = true");
  });

  it("returns a nextCursor when the page is full", async () => {
    const dbRow = {
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
    };
    const pool = fakePool([dbRow]);
    const store = createShowcaseStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const { nextCursor } = await store!.listScreens({ limit: 1 });
    expect(nextCursor).not.toBeNull();

    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe(`2026-07-27T10:00:00.000Z|${row.id}`);
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

  it("applies a valid cursor as a keyset predicate", async () => {
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
    expect(pool.calls[0].sql).toContain("(created_at, id) <");
    expect(pool.calls[0].params).toEqual([
      "2026-07-27T10:00:00.000Z",
      "11111111-1111-1111-1111-111111111111",
      10,
    ]);
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
