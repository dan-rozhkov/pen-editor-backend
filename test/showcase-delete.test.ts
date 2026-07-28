import { describe, expect, it, vi } from "vitest";
import {
  resolveDeleteAction,
  runDeleteAction,
  type DeleteDeps,
} from "../src/showcase/delete.js";
import type { ShowcaseDeletedScreen, ShowcaseScreenSource } from "../src/showcase/store.js";

describe("resolveDeleteAction", () => {
  it("resolves --app to an app action", () => {
    expect(resolveDeleteAction({ app: "run-1", dryRun: false })).toEqual({
      kind: "app",
      id: "run-1",
      dryRun: false,
    });
  });

  it("resolves --screen to a screen action", () => {
    expect(resolveDeleteAction({ screen: "screen-1", dryRun: true })).toEqual({
      kind: "screen",
      id: "screen-1",
      dryRun: true,
    });
  });

  it("refuses to act with no target", () => {
    expect(() => resolveDeleteAction({ dryRun: false })).toThrow(/nothing to delete/);
  });

  it("rejects combining --app and --screen", () => {
    expect(() =>
      resolveDeleteAction({ app: "run-1", screen: "screen-1", dryRun: false }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects an empty --app value", () => {
    expect(() => resolveDeleteAction({ app: "", dryRun: false })).toThrow(
      /requires a run id or screen id/,
    );
  });

  it("rejects an empty --screen value", () => {
    expect(() => resolveDeleteAction({ screen: "", dryRun: false })).toThrow(
      /requires a screen id/,
    );
  });
});

function source(id: string, title: string): ShowcaseScreenSource {
  return { id, title, htmlUrl: `https://cdn.test/${id}.html`, width: 390, height: 844 };
}

function deleted(id: string, title: string): ShowcaseDeletedScreen {
  return { id, runId: "run-1", title };
}

function makeDeps(overrides: Partial<DeleteDeps["store"]> = {}): {
  deps: DeleteDeps;
  logs: string[];
} {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      log: (m) => logs.push(m),
      store: {
        deleteScreens: vi.fn(async () => []),
        listScreenSources: vi.fn(async () => []),
        getScreenSource: vi.fn(async () => null),
        ...overrides,
      },
    },
  };
}

describe("runDeleteAction", () => {
  it("deletes a whole app by run or screen id", async () => {
    const deleteScreens = vi.fn(async () => [deleted("s1", "Home"), deleted("s2", "Cart")]);
    const { deps, logs } = makeDeps({ deleteScreens });
    await runDeleteAction(deps, { kind: "app", id: "s1", dryRun: false });
    expect(deleteScreens).toHaveBeenCalledWith({ appOf: "s1" });
    expect(logs.join("\n")).toContain("deleted 2 screen(s) from run run-1");
    expect(logs.join("\n")).toContain("Home");
  });

  it("deletes a single screen without touching its run", async () => {
    const deleteScreens = vi.fn(async () => [deleted("s1", "Home")]);
    const { deps } = makeDeps({ deleteScreens });
    await runDeleteAction(deps, { kind: "screen", id: "s1", dryRun: false });
    expect(deleteScreens).toHaveBeenCalledWith({ screen: "s1" });
  });

  it("throws when nothing matched", async () => {
    const { deps } = makeDeps();
    await expect(
      runDeleteAction(deps, { kind: "app", id: "nope", dryRun: false }),
    ).rejects.toThrow(/no showcase screens for run or screen id nope/);
  });

  it("lists without deleting on --dry-run", async () => {
    const deleteScreens = vi.fn(async () => []);
    const listScreenSources = vi.fn(async () => [source("s1", "Home")]);
    const { deps, logs } = makeDeps({ deleteScreens, listScreenSources });
    await runDeleteAction(deps, { kind: "app", id: "run-1", dryRun: true });
    expect(deleteScreens).not.toHaveBeenCalled();
    expect(listScreenSources).toHaveBeenCalledWith({ appOf: "run-1" });
    expect(logs.join("\n")).toContain("would delete 1 screen(s)");
    expect(logs.join("\n")).toContain("s1  Home");
  });

  it("dry-runs a single screen through getScreenSource", async () => {
    const getScreenSource = vi.fn(async () => source("s1", "Home"));
    const { deps, logs } = makeDeps({ getScreenSource });
    await runDeleteAction(deps, { kind: "screen", id: "s1", dryRun: true });
    expect(getScreenSource).toHaveBeenCalledWith("s1");
    expect(logs.join("\n")).toContain("would delete 1 screen(s)");
  });

  it("throws on a dry run that matches nothing", async () => {
    const { deps } = makeDeps();
    await expect(
      runDeleteAction(deps, { kind: "screen", id: "nope", dryRun: true }),
    ).rejects.toThrow(/no showcase screen with id nope/);
  });
});
