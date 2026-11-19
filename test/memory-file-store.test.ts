import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryStore } from "../src/ai/memory/fileStore.js";
import { assert } from "./helpers.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memory-file-store-"));
  file = join(dir, "nested", "agent-memory.json");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const add = (content: string) => [{ action: "add" as const, content }];
const write = (store: ReturnType<typeof createFileMemoryStore>, content: string, target: "memory" | "user" = "user", userId = "u1") =>
  store.applyOperations({ userId, target, operations: add(content), origin: "foreground" });

describe("createFileMemoryStore", () => {
  it("starts empty when the file is missing, and writes nothing on a read", async () => {
    const store = createFileMemoryStore(file);
    expect(await store.loadSnapshot("u1")).toEqual({ memory: [], user: [] });
    expect(await store.getMemoryEnabled("u1")).toBe(true);
    await expect(stat(file)).rejects.toThrow();
  });

  it("applies operations atomically, like the pg store", async () => {
    const store = createFileMemoryStore(file);
    const saved = await write(store, "likes short answers");
    expect(saved.ok).toBe(true);
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "replace", old_text: "short", content: "likes very short answers" }, ...add("name is Ana")],
      origin: "foreground",
    });
    expect((await store.loadSnapshot("u1")).user).toEqual(["likes very short answers", "name is Ana"]);

    // One failing operation leaves everything untouched and writes no audit row.
    const failed = await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [...add("x"), { action: "remove", old_text: "does not exist" }],
      origin: "foreground",
    });
    expect(failed.ok).toBe(false);
    assert(!failed.ok);
    expect(failed.kind).toBe("no_match");
    expect((await store.loadSnapshot("u1")).user).toEqual(["likes very short answers", "name is Ana"]);
    expect((await store.listAuditActivity({ userId: "u1", sinceId: 0 })).events).toHaveLength(2);
  });

  it("rejects an add over the char limit", async () => {
    const store = createFileMemoryStore(file);
    const over = await write(store, "x".repeat(1400), "user");
    expect(over.ok).toBe(false);
    expect((await store.loadSnapshot("u1")).user).toEqual([]);
  });

  it("keeps users apart; a key like constructor is an ordinary id and __proto__ is refused", async () => {
    const store = createFileMemoryStore(file);
    await write(store, "for a", "memory", "a");
    await write(store, "for ctor", "memory", "constructor");
    expect((await store.loadSnapshot("a")).memory).toEqual(["for a"]);
    expect((await store.loadSnapshot("b")).memory).toEqual([]);
    expect((await store.loadSnapshot("toString")).memory).toEqual([]);
    expect((await createFileMemoryStore(file).loadSnapshot("constructor")).memory).toEqual(["for ctor"]);
    await expect(write(store, "x", "memory", "__proto__")).rejects.toThrow(/invalid user id/);
    expect((await store.loadSnapshot("a")).memory).toEqual(["for a"]);
  });

  it("persists across a new store on the same file, with the documented shape", async () => {
    const store = createFileMemoryStore(file);
    await write(store, "persisted fact", "memory");
    await store.setMemoryEnabled("u1", false);
    const reopened = createFileMemoryStore(file);
    expect(await reopened.loadSnapshot("u1")).toEqual({ memory: ["persisted fact"], user: [] });
    expect(await reopened.getMemoryEnabled("u1")).toBe(false);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(["audit", "nextAuditId", "users", "version"]);
    expect(onDisk.version).toBe(1);
    expect((onDisk.users as Record<string, unknown>).u1).toMatchObject({
      memory: ["persisted fact"],
      user: [],
      enabled: false,
      turnsSinceMemory: 0,
      stepsSinceSkill: 0,
    });
  });

  it("writes the file with mode 0600 and leaves no temp file", async () => {
    const store = createFileMemoryStore(file);
    await write(store, "secret-ish");
    await write(store, "second");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "nested"))).toEqual(["agent-memory.json"]);
  });

  it("serializes concurrent writes: none is lost", async () => {
    const store = createFileMemoryStore(file);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => write(store, `fact ${i}`, "memory")));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await store.loadSnapshot("u1")).memory).toHaveLength(12);
    expect((await createFileMemoryStore(file).loadSnapshot("u1")).memory).toHaveLength(12);
  });

  it("keeps the old state when a write fails, and recovers on the next call", async () => {
    const store = createFileMemoryStore(file);
    await write(store, "first");
    // The target path becomes a directory: the rename fails.
    await rm(file);
    await mkdir(file);
    await expect(write(store, "second")).rejects.toThrow();
    expect((await store.loadSnapshot("u1")).user).toEqual(["first"]);
    expect((await readdir(join(dir, "nested"))).filter((n) => n.includes(".tmp-"))).toEqual([]);
    await rm(file, { recursive: true });
    expect((await write(store, "third")).ok).toBe(true);
    expect((await createFileMemoryStore(file).loadSnapshot("u1")).user).toEqual(["first", "third"]);
  });

  it("moves an unparsable or invalid file aside and starts empty, without logging contents", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["{ not json SECRET-CONTENT", JSON.stringify({ version: 2, users: {} }), JSON.stringify([]), JSON.stringify({ version: 1, audit: [] }), JSON.stringify({ version: 1, users: [] })]) {
      await writeFile(file, bad);
      const store = createFileMemoryStore(file);
      expect(await store.loadSnapshot("u1")).toEqual({ memory: [], user: [] });
      await write(store, "fresh");
      expect((await createFileMemoryStore(file).loadSnapshot("u1")).user).toEqual(["fresh"]);
    }
    const names = await readdir(join(dir, "nested"));
    expect(names.filter((n) => n.startsWith("agent-memory.json.corrupt-"))).not.toHaveLength(0);
    const kept = await Promise.all(
      names.filter((n) => n.includes(".corrupt-")).map((n) => readFile(join(dir, "nested", n), "utf8")),
    );
    expect(kept.some((c) => c.includes("SECRET-CONTENT"))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-CONTENT");
  });

  it("is tolerant: drops only invalid users and audit rows, keeps the rest and a sane nextAuditId", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const goodUser = { memory: ["m1"], user: ["u-ok"], enabled: true, turnsSinceMemory: 0, stepsSinceSkill: 0, updatedAt: null };
    const row = (id: number, over: Record<string, unknown> = {}) => ({
      id, userId: "u1", origin: "foreground", subsystem: "memory", action: "add", payload: { target: "user" }, createdAt: "2026-01-01T00:00:00.000Z", ...over,
    });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        nextAuditId: 2, // stale: below the max kept id
        users: { u1: goodUser, bad: { memory: [1] }, alsoBad: "x" },
        audit: [row(5), row(6, { origin: "from-the-future" }), row(7, { subsystem: "newthing" }), row(8, { payload: "nope" }), "junk", row(9, { subsystem: "skill", action: "create" })],
      }),
    );
    const store = createFileMemoryStore(file);
    expect((await store.loadSnapshot("u1")).user).toEqual(["u-ok"]);
    expect(await store.loadSnapshot("bad")).toEqual({ memory: [], user: [] });
    const feed = await store.listAuditActivity({ userId: "u1", sinceId: 0 });
    expect(feed.events.map((e) => e.id)).toEqual([5, 9]);
    await write(store, "new");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { audit: Array<{ id: number }>; nextAuditId: number; users: Record<string, unknown> };
    expect(Object.keys(onDisk.users)).toEqual(["u1"]);
    expect(onDisk.audit.map((r) => r.id)).toEqual([5, 9, 10]);
    expect(onDisk.nextAuditId).toBe(11);
    expect((await readdir(join(dir, "nested"))).filter((n) => n.includes(".corrupt-"))).toEqual([]);
  });

  it("keeps only the last 500 audit rows, with ids that keep growing", async () => {
    const store = createFileMemoryStore(file);
    for (let i = 0; i < 510; i++) {
      await store.writeAudit({ userId: "u1", origin: "background_review", subsystem: "memory", action: "add", payload: { target: "user", operations: [{ action: "add", content: `c${i}` }] } });
    }
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { audit: Array<{ id: number }>; nextAuditId: number };
    expect(onDisk.audit).toHaveLength(500);
    expect(onDisk.audit[0].id).toBe(11);
    expect(onDisk.nextAuditId).toBe(511);
    expect((await store.listAuditActivity({ userId: "u1" })).latestId).toBe(510);
  });

  describe("activity feed", () => {
    it("baseline mode returns no events, only the latest id; review rows are excluded", async () => {
      const store = createFileMemoryStore(file);
      expect(await store.listAuditActivity({ userId: "u1" })).toEqual({ events: [], latestId: null });
      await store.applyOperations({ userId: "u1", target: "user", operations: add("a fact"), origin: "background_review", attribution: { chatId: "chat-1", messageId: "msg-1" } });
      await store.writeAudit({ userId: "u1", origin: "background_review", subsystem: "review", action: "saved", payload: { steps: 2 } });
      await write(store, "other user's", "user", "u2");

      expect(await store.listAuditActivity({ userId: "u1" })).toEqual({ events: [], latestId: 1 });

      const { events, latestId } = await store.listAuditActivity({ userId: "u1", sinceId: 0 });
      expect(latestId).toBe(1);
      expect(events).toEqual([
        {
          id: 1,
          subsystem: "memory",
          action: "add",
          origin: "background_review",
          createdAt: expect.any(String),
          chatId: "chat-1",
          messageId: "msg-1",
          detail: { kind: "memory", target: "user", operations: [{ action: "add", content: "a fact" }] },
        },
      ]);
      expect((await store.listAuditActivity({ userId: "u1", sinceId: 1 })).events).toEqual([]);
    });

    it("limits a page, and still reports the real tail", async () => {
      const store = createFileMemoryStore(file);
      for (let i = 0; i < 5; i++) await store.writeAudit({ userId: "u1", origin: "user", subsystem: "memory", action: "clear", payload: { counts: { memory: 0, user: 0 } } });
      const page = await store.listAuditActivity({ userId: "u1", sinceId: 0, limit: 2 });
      expect(page.events.map((e) => e.id)).toEqual([1, 2]);
      expect(page.latestId).toBe(5);
    });

    it("never carries the usage or entryCount in an event", async () => {
      const store = createFileMemoryStore(file);
      await write(store, "fact");
      const { events } = await store.listAuditActivity({ userId: "u1", sinceId: 0 });
      expect(JSON.stringify(events)).not.toContain("entryCount");
      expect(JSON.stringify(events)).not.toContain("usage");
    });
  });

  describe("bumpCounters", () => {
    it("resets turns when due and reports skillReviewDue only when asked", async () => {
      const store = createFileMemoryStore(file);
      expect(await store.bumpCounters({ userId: "u1", turns: 1, steps: 3, memoryInterval: 3 })).toEqual({ turnsSinceMemory: 1, stepsSinceSkill: 3, memoryReviewDue: false });
      await store.bumpCounters({ userId: "u1", turns: 1, steps: 0, memoryInterval: 3 });
      const due = await store.bumpCounters({ userId: "u1", turns: 1, steps: 0, memoryInterval: 3 });
      expect(due).toEqual({ turnsSinceMemory: 3, stepsSinceSkill: 3, memoryReviewDue: true });
      // Reset after the due report; the skill counter was not touched.
      expect(await store.bumpCounters({ userId: "u1", turns: 0, steps: 0, memoryInterval: 3 })).toEqual({ turnsSinceMemory: 0, stepsSinceSkill: 3, memoryReviewDue: false });
    });

    it("resets the skill counter independently when its interval passed", async () => {
      const store = createFileMemoryStore(file);
      const r = await store.bumpCounters({ userId: "u1", turns: 1, steps: 15, memoryInterval: 10, skillInterval: 15 });
      expect(r).toEqual({ turnsSinceMemory: 1, stepsSinceSkill: 15, memoryReviewDue: false, skillReviewDue: true });
      expect(await store.bumpCounters({ userId: "u1", turns: 0, steps: 1, memoryInterval: 10, skillInterval: 15 })).toMatchObject({ turnsSinceMemory: 1, stepsSinceSkill: 1, skillReviewDue: false });
    });

    it("keeps counters across a re-created store", async () => {
      await createFileMemoryStore(file).bumpCounters({ userId: "u1", turns: 2, steps: 4, memoryInterval: 10 });
      expect(await createFileMemoryStore(file).bumpCounters({ userId: "u1", turns: 1, steps: 1, memoryInterval: 10 })).toMatchObject({ turnsSinceMemory: 3, stepsSinceSkill: 5 });
    });
  });

  it("removeEntry matches the exact text only, and audits a removal", async () => {
    const store = createFileMemoryStore(file);
    await write(store, "likes tea");
    await write(store, "likes tea and cake");
    expect(await store.removeEntry("u1", "user", "likes", "user")).toBe(false);
    expect(await store.removeEntry("u1", "memory", "likes tea", "user")).toBe(false);
    expect(await store.removeEntry("u1", "user", "likes tea", "user")).toBe(true);
    expect((await store.loadSnapshot("u1")).user).toEqual(["likes tea and cake"]);
    const { events } = await store.listAuditActivity({ userId: "u1", sinceId: 2 });
    expect(events).toMatchObject([{ action: "remove_entry", origin: "user" }]);
  });

  it("clearUser wipes both targets, counts them and audits once; an unknown user is fine", async () => {
    const store = createFileMemoryStore(file);
    await write(store, "u fact", "user");
    await write(store, "m fact", "memory");
    await write(store, "kept", "user", "u2");
    expect(await store.clearUser("u1", "user")).toEqual({ memory: 1, user: 1 });
    expect(await store.loadSnapshot("u1")).toEqual({ memory: [], user: [] });
    expect((await store.loadSnapshot("u2")).user).toEqual(["kept"]);
    expect(await store.clearUser("nobody", "user")).toEqual({ memory: 0, user: 0 });
  });

  it("the enabled switch is per user and survives a re-created store", async () => {
    await createFileMemoryStore(file).setMemoryEnabled("off-user", false);
    const reopened = createFileMemoryStore(file);
    expect(await reopened.getMemoryEnabled("off-user")).toBe(false);
    expect(await reopened.getMemoryEnabled("never-seen")).toBe(true);
    await reopened.setMemoryEnabled("off-user", true);
    expect(await createFileMemoryStore(file).getMemoryEnabled("off-user")).toBe(true);
  });

  it("listUsers lists users with stored memory, most recently updated first", async () => {
    const store = createFileMemoryStore(file);
    await store.setMemoryEnabled("only-prefs", false);
    await write(store, "a", "user", "old");
    await new Promise((r) => setTimeout(r, 5));
    await write(store, "b", "user", "new");
    expect((await store.listUsers(10)).map((u) => u.userId)).toEqual(["new", "old"]);
    expect(await store.listUsers(1)).toHaveLength(1);
  });
});
