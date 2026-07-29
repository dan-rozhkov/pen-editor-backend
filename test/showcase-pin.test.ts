import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PIN_LIST_LIMIT,
  resolvePinAction,
  runPinAction,
  type PinDeps,
} from "../src/showcase/pin.js";
import type { ShowcaseScreen, ShowcaseStore } from "../src/showcase/store.js";

describe("resolvePinAction", () => {
  it("defaults to listing when nothing is specified", () => {
    expect(resolvePinAction({ clear: false, list: false })).toEqual({
      kind: "list",
      limit: DEFAULT_PIN_LIST_LIMIT,
      platform: "mobile",
    });
  });

  it("honors an explicit --limit for listing", () => {
    expect(resolvePinAction({ clear: false, list: false, limit: 5 })).toEqual({
      kind: "list",
      limit: 5,
      platform: "mobile",
    });
  });

  it("honors an explicit --platform for listing", () => {
    expect(resolvePinAction({ clear: false, list: false, platform: "desktop" })).toEqual({
      kind: "list",
      limit: DEFAULT_PIN_LIST_LIMIT,
      platform: "desktop",
    });
  });

  it("resolves --screen to a pin action", () => {
    expect(resolvePinAction({ screen: "abc-123", clear: false, list: false })).toEqual({
      kind: "pin",
      screenId: "abc-123",
    });
  });

  it("resolves --clear to a clear action", () => {
    expect(resolvePinAction({ clear: true, list: false })).toEqual({ kind: "clear" });
  });

  it("rejects an empty --screen value", () => {
    expect(() => resolvePinAction({ screen: "", clear: false, list: false })).toThrow(
      /requires a screen id/,
    );
  });

  it("rejects combining --screen and --clear", () => {
    expect(() =>
      resolvePinAction({ screen: "abc-123", clear: true, list: false }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects combining --screen and --list", () => {
    expect(() =>
      resolvePinAction({ screen: "abc-123", clear: false, list: true }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects a non-positive --limit", () => {
    expect(() => resolvePinAction({ clear: false, list: false, limit: 0 })).toThrow(
      /positive integer/,
    );
  });

  it("rejects a fractional --limit", () => {
    expect(() => resolvePinAction({ clear: false, list: false, limit: 1.5 })).toThrow(
      /positive integer/,
    );
  });

  it("resolves --clear --run to a scoped clear action", () => {
    expect(
      resolvePinAction({ clear: true, list: false, run: "22222222-2222-2222-2222-222222222222" }),
    ).toEqual({ kind: "clear", runId: "22222222-2222-2222-2222-222222222222" });
  });

  it("rejects --run without --clear", () => {
    expect(() =>
      resolvePinAction({ clear: false, list: false, run: "22222222-2222-2222-2222-222222222222" }),
    ).toThrow(/--run is only valid together with --clear/);
  });

  it("rejects --run combined with --screen", () => {
    expect(() =>
      resolvePinAction({
        screen: "abc-123",
        clear: false,
        list: false,
        run: "22222222-2222-2222-2222-222222222222",
      }),
    ).toThrow(/--run is only valid together with --clear/);
  });

  it("rejects an empty --run value", () => {
    expect(() => resolvePinAction({ clear: true, list: false, run: "" })).toThrow(
      /--run requires a run id/,
    );
  });
});

function fakeStore(overrides: Partial<PinDeps["store"]> = {}): PinDeps["store"] {
  return {
    listApps: vi.fn().mockResolvedValue({ apps: [], nextCursor: null }),
    pinScreen: vi.fn().mockResolvedValue(true),
    clearPin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeScreen(overrides: Partial<ShowcaseScreen> = {}): ShowcaseScreen {
  return {
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
    createdAt: "2026-07-27T10:00:00.000Z",
    pinned: false,
    ...overrides,
  };
}

describe("runPinAction", () => {
  it("pins the given screen and logs success", async () => {
    const store = fakeStore();
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "pin", screenId: "abc-123" });
    expect(store.pinScreen).toHaveBeenCalledWith("abc-123");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pinned abc-123"));
  });

  it("throws when pinScreen reports the id does not exist", async () => {
    const store = fakeStore({ pinScreen: vi.fn().mockResolvedValue(false) });
    await expect(
      runPinAction({ store, log: vi.fn() }, { kind: "pin", screenId: "missing" }),
    ).rejects.toThrow(/no showcase screen with id missing/);
  });

  it("clears every pin and logs it", async () => {
    const store = fakeStore();
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "clear" });
    expect(store.clearPin).toHaveBeenCalledWith(undefined);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cleared every pinned screen"));
  });

  it("clears one run's pin and logs it by run id", async () => {
    const store = fakeStore();
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "clear", runId: "run-1" });
    expect(store.clearPin).toHaveBeenCalledWith("run-1");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("run run-1"));
  });

  it("lists screens grouped by app, marking the pinned one", async () => {
    const apps = [
      {
        runId: "run-a",
        theme: "fitness",
        model: "google/gemini-2.5-flash",
        platform: "mobile",
        createdAt: "2026-07-27T10:00:00.000Z",
        screens: [
          makeScreen({ id: "s1", runId: "run-a", pinned: true }),
          makeScreen({ id: "s2", runId: "run-a", pinned: false }),
        ],
      },
      {
        runId: "run-b",
        theme: "cooking",
        model: "google/gemini-2.5-flash",
        platform: "mobile",
        createdAt: "2026-07-26T10:00:00.000Z",
        screens: [makeScreen({ id: "s3", runId: "run-b", pinned: false })],
      },
    ];
    const store = fakeStore({
      listApps: vi.fn().mockResolvedValue({ apps, nextCursor: null }),
    });
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "list", limit: 8, platform: "mobile" });
    // Regression: `--list` must stay sorted by recency even though
    // `listApps`'s own default is "popular" (the feed's sort tab default) —
    // a freshly published app with 0 likes has to appear so its screen ids
    // are pinnable, not be pushed off the list by anything with a like.
    expect(store.listApps).toHaveBeenCalledWith({
      limit: 8,
      sort: "latest",
      platform: "mobile",
    });
    const lines = log.mock.calls.map((call) => call[0] as string);
    // One header per run, screens indented underneath it, pinned marked.
    expect(lines[0]).toContain("run-a");
    expect(lines[1]).toMatch(/^ {2}\[pinned\] /);
    expect(lines[2]).toMatch(/^ {2}(?!\[pinned\])/);
    expect(lines[3]).toContain("run-b");
    expect(lines[4]).toMatch(/^ {2}(?!\[pinned\])/);
  });

  it("reports no screens instead of printing an empty list", async () => {
    const store = fakeStore();
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "list", limit: 8, platform: "mobile" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no published screens"));
  });
});

// The interface subset PinDeps needs must stay assignable from the real
// ShowcaseStore — a compile-time check that the two never drift apart.
function _typeCheck(store: ShowcaseStore): PinDeps["store"] {
  return store;
}
void _typeCheck;
