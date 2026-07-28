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
    });
  });

  it("honors an explicit --limit for listing", () => {
    expect(resolvePinAction({ clear: false, list: false, limit: 5 })).toEqual({
      kind: "list",
      limit: 5,
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
});

function fakeStore(overrides: Partial<PinDeps["store"]> = {}): PinDeps["store"] {
  return {
    listScreens: vi.fn().mockResolvedValue({ screens: [], nextCursor: null }),
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

  it("clears the pin and logs it", async () => {
    const store = fakeStore();
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "clear" });
    expect(store.clearPin).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cleared"));
  });

  it("lists screens, marking the pinned one", async () => {
    const screens = [makeScreen({ pinned: true }), makeScreen({ id: "other", pinned: false })];
    const store = fakeStore({
      listScreens: vi.fn().mockResolvedValue({ screens, nextCursor: null }),
    });
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "list", limit: 24 });
    expect(store.listScreens).toHaveBeenCalledWith({ limit: 24 });
    const lines = log.mock.calls.map((call) => call[0] as string);
    expect(lines[0]).toMatch(/^\[pinned\] /);
    expect(lines[1]).not.toMatch(/^\[pinned\] /);
  });

  it("reports no screens instead of printing an empty list", async () => {
    const store = fakeStore();
    const log = vi.fn();
    await runPinAction({ store, log }, { kind: "list", limit: 24 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no published screens"));
  });
});

// The interface subset PinDeps needs must stay assignable from the real
// ShowcaseStore — a compile-time check that the two never drift apart.
function _typeCheck(store: ShowcaseStore): PinDeps["store"] {
  return store;
}
void _typeCheck;
