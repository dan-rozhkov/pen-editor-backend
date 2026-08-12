import { describe, expect, it, vi } from "vitest";
import {
  resolveCuratorAction,
  runCuratorAction,
  type CuratorDeps,
} from "../src/ai/memory/curator.js";

describe("resolveCuratorAction", () => {
  it("defaults to 'show' when only --user is given", () => {
    expect(resolveCuratorAction({ user: "u1", clear: false, listUsers: false, dryRun: false })).toEqual(
      { kind: "show", userId: "u1" },
    );
  });

  it("requires --user for show/remove/clear", () => {
    expect(() =>
      resolveCuratorAction({ clear: false, listUsers: false, dryRun: false }),
    ).toThrow(/--user/);
  });

  it("builds a remove action from --entry and --target", () => {
    expect(
      resolveCuratorAction({
        user: "u1",
        target: "user",
        entry: "concise",
        clear: false,
        listUsers: false,
        dryRun: false,
      }),
    ).toEqual({ kind: "remove", userId: "u1", target: "user", entry: "concise", dryRun: false });
  });

  it("rejects --entry without a valid --target", () => {
    expect(() =>
      resolveCuratorAction({
        user: "u1",
        entry: "concise",
        clear: false,
        listUsers: false,
        dryRun: false,
      }),
    ).toThrow(/--target/);
  });

  it("builds a clear action", () => {
    expect(
      resolveCuratorAction({ user: "u1", clear: true, listUsers: false, dryRun: true }),
    ).toEqual({ kind: "clear", userId: "u1", dryRun: true });
  });

  it("builds a list-users action with the default limit", () => {
    expect(resolveCuratorAction({ clear: false, listUsers: true, dryRun: false })).toEqual({
      kind: "list-users",
      limit: 20,
    });
  });

  it("rejects --list-users combined with --user", () => {
    expect(() =>
      resolveCuratorAction({ user: "u1", clear: false, listUsers: true, dryRun: false }),
    ).toThrow(/--list-users/);
  });

  it("rejects combining --entry and --clear", () => {
    expect(() =>
      resolveCuratorAction({
        user: "u1",
        target: "user",
        entry: "x",
        clear: true,
        listUsers: false,
        dryRun: false,
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a non-positive --limit", () => {
    expect(() =>
      resolveCuratorAction({ clear: false, listUsers: true, limit: 0, dryRun: false }),
    ).toThrow(/--limit/);
  });
});

function fakeDeps(overrides: Partial<CuratorDeps["store"]> = {}) {
  const log = vi.fn();
  const store = {
    loadSnapshot: vi.fn(async () => ({ user: [], memory: [] })),
    applyOperations: vi.fn(async () => ({
      ok: true as const,
      entries: [],
      usage: { current: 0, limit: 1375 },
    })),
    clearUser: vi.fn(async () => ({ memory: 0, user: 0 })),
    listUsers: vi.fn(async () => []),
    ...overrides,
  };
  return { deps: { store, log } as unknown as CuratorDeps, store, log };
}

describe("runCuratorAction", () => {
  it("show: prints both targets", async () => {
    const { deps, store, log } = fakeDeps({
      loadSnapshot: vi.fn(async () => ({ user: ["A"], memory: ["B"] })),
    });
    await runCuratorAction(deps, { kind: "show", userId: "u1" });
    expect(store.loadSnapshot).toHaveBeenCalledWith("u1");
    expect(log.mock.calls.flat().join("\n")).toContain("A");
    expect(log.mock.calls.flat().join("\n")).toContain("B");
  });

  it("list-users: reports 'no users' when empty", async () => {
    const { deps, log } = fakeDeps();
    await runCuratorAction(deps, { kind: "list-users", limit: 20 });
    expect(log.mock.calls.flat().join("\n")).toMatch(/no users/);
  });

  it("list-users: prints each user id", async () => {
    const { deps, log } = fakeDeps({
      listUsers: vi.fn(async () => [{ userId: "u1", updatedAt: "2026-08-12T00:00:00.000Z" }]),
    });
    await runCuratorAction(deps, { kind: "list-users", limit: 20 });
    expect(log.mock.calls.flat().join("\n")).toContain("u1");
  });

  it("remove: calls applyOperations with origin 'curator' and a single remove op", async () => {
    const { deps, store } = fakeDeps({
      applyOperations: vi.fn(async () => ({
        ok: true as const,
        entries: ["kept"],
        usage: { current: 4, limit: 1375 },
      })),
    });
    await runCuratorAction(deps, {
      kind: "remove",
      userId: "u1",
      target: "user",
      entry: "concise",
      dryRun: false,
    });
    expect(store.applyOperations).toHaveBeenCalledWith({
      userId: "u1",
      target: "user",
      operations: [{ action: "remove", old_text: "concise" }],
      origin: "curator",
    });
  });

  it("remove: surfaces a failed match as a thrown error, without mutating anything", async () => {
    const { deps, store } = fakeDeps({
      applyOperations: vi.fn(async () => ({
        ok: false as const,
        kind: "no_match" as const,
        message: 'No memory entry contains "zzz". Nothing was changed.',
        usage: { current: 0, limit: 1375 },
        currentEntries: [],
      })),
    });
    await expect(
      runCuratorAction(deps, {
        kind: "remove",
        userId: "u1",
        target: "memory",
        entry: "zzz",
        dryRun: false,
      }),
    ).rejects.toThrow(/No memory entry contains/);
    expect(store.applyOperations).toHaveBeenCalled();
  });

  it("remove --dry-run: does not call applyOperations", async () => {
    const { deps, store } = fakeDeps({
      loadSnapshot: vi.fn(async () => ({ user: ["User likes concise replies"], memory: [] })),
    });
    await runCuratorAction(deps, {
      kind: "remove",
      userId: "u1",
      target: "user",
      entry: "concise",
      dryRun: true,
    });
    expect(store.applyOperations).not.toHaveBeenCalled();
  });

  it("remove --dry-run: throws on an ambiguous substring instead of guessing", async () => {
    const { deps } = fakeDeps({
      loadSnapshot: vi.fn(async () => ({
        user: ["User likes blue", "User likes blue buttons"],
        memory: [],
      })),
    });
    await expect(
      runCuratorAction(deps, {
        kind: "remove",
        userId: "u1",
        target: "user",
        entry: "likes blue",
        dryRun: true,
      }),
    ).rejects.toThrow(/matches 2 entries/);
  });

  it("clear: calls store.clearUser with origin 'curator'", async () => {
    const { deps, store } = fakeDeps({ clearUser: vi.fn(async () => ({ memory: 2, user: 1 })) });
    await runCuratorAction(deps, { kind: "clear", userId: "u1", dryRun: false });
    expect(store.clearUser).toHaveBeenCalledWith("u1", "curator");
  });

  it("clear --dry-run: does not call store.clearUser", async () => {
    const { deps, store } = fakeDeps({
      loadSnapshot: vi.fn(async () => ({ user: ["A"], memory: ["B", "C"] })),
    });
    await runCuratorAction(deps, { kind: "clear", userId: "u1", dryRun: true });
    expect(store.clearUser).not.toHaveBeenCalled();
  });
});
