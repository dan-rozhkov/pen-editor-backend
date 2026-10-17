import { describe, expect, it, vi } from "vitest";
import { penTools, browseAgentToolQaIsolated } from "../src/ai/tools.js";
import { toCommandRunner } from "../src/browser/connect.js";
import { COMMAND_NAMES } from "../src/browser/cloudSessions.js";
import type { BrowserController } from "@sideform/browser-agent/controller";

const schema = penTools.browse_agent.inputSchema as import("zod").ZodType;
const goal = "Check the cart page";

const fullSetup = {
  tabs: ["https://a.test/help"],
  storage: {
    cookies: [{ name: "sid", value: "abc", domain: "a.test", path: "/", httpOnly: true, secure: true, sameSite: "Lax", expires: 1_900_000_000 }],
    origins: [{ origin: "https://a.test", localStorage: { k: "v" }, sessionStorage: { s: "1" } }],
  },
  steps: [
    { action: "goto", url: "https://a.test/login" },
    { action: "click", selector: "#go" },
    { action: "type", selector: "#q", text: "shoes" },
    { action: "press", key: "Enter", selector: "#q" },
    { action: "waitFor", selector: ".ready", timeoutMs: 3000 },
    { action: "wait", ms: 500 },
  ],
  expect: { selector: ".cart", text: "Cart", url: "https://a.test/cart*", timeoutMs: 5000 },
  network: [
    { url: "https://a.test/api/cart*", method: "get", status: 500, headers: { "x-t": "1" }, body: { error: "boom" }, delayMs: 100, times: 2 },
    { url: "https://a.test/api/pay*", abort: true },
  ],
  fresh: true,
};

describe("browse_agent setup schema", () => {
  it("accepts a call without setup and with a full setup", () => {
    expect(schema.safeParse({ goal }).success).toBe(true);
    expect(schema.safeParse({ goal, url: "https://a.test", setup: fullSetup }).success).toBe(true);
  });

  it.each([
    ["21 steps", { steps: Array.from({ length: 21 }, () => ({ action: "wait", ms: 1 })) }],
    ["21 network rules", { network: Array.from({ length: 21 }, () => ({ url: "https://a.test/*" })) }],
    ["11 tabs", { tabs: Array.from({ length: 11 }, () => "https://a.test") }],
    ["21 cookies", { storage: { cookies: Array.from({ length: 21 }, () => ({ name: "a", value: "b", domain: "a.test" })) } }],
    ["11 origins", { storage: { origins: Array.from({ length: 11 }, () => ({ origin: "https://a.test" })) } }],
    ["unknown step action", { steps: [{ action: "hover", selector: "a" }] }],
    ["wait over 30s", { steps: [{ action: "wait", ms: 30_001 }] }],
    ["status out of range", { network: [{ url: "https://a.test/*", status: 99 }] }],
    ["times 0", { network: [{ url: "https://a.test/*", times: 0 }] }],
    ["cookie without url or domain", { storage: { cookies: [{ name: "a", value: "b" }] } }],
    ["empty expect", { expect: {} }],
    ["unknown top-level key", { version: 1 }],
    ["unknown rule key", { network: [{ url: "https://a.test/*", foo: 1 }] }],
  ])("rejects %s", (_name, setup) => {
    expect(schema.safeParse({ goal, setup }).success).toBe(false);
  });
});

describe("browse_agent resume schema", () => {
  it("accepts a checkpoint id up to 64 characters and rejects empty or longer", () => {
    expect(schema.safeParse({ goal, resume: "cp_1" }).success).toBe(true);
    expect(schema.safeParse({ goal, resume: "x".repeat(64) }).success).toBe(true);
    expect(schema.safeParse({ goal, resume: "x".repeat(65) }).success).toBe(false);
    expect(schema.safeParse({ goal, resume: "" }).success).toBe(false);
    expect(schema.safeParse({ goal, resume: "   " }).success).toBe(false);
    expect(schema.parse({ goal, resume: " cp_1 " }).resume).toBe("cp_1");
  });

  it("rejects resume together with url or setup", () => {
    expect(schema.safeParse({ goal, resume: "cp_1", url: "https://a.test" }).success).toBe(false);
    expect(schema.safeParse({ goal, resume: "cp_1", setup: { version: 1 } }).success).toBe(false);
    expect(schema.safeParse({ goal, url: "https://a.test" }).success).toBe(true);
  });
});

describe("browse_agent QA resume schema", () => {
  const isolated = browseAgentToolQaIsolated.inputSchema as import("zod").ZodType;

  it("isolated QA variant accepts resume with qa: true", () => {
    expect(isolated.safeParse({ goal, qa: true, resume: "cp_1" }).success).toBe(true);
  });

  it("isolated QA variant still rejects resume with url or setup", () => {
    expect(isolated.safeParse({ goal, qa: true, resume: "cp_1", url: "https://a.test" }).success).toBe(false);
    expect(isolated.safeParse({ goal, qa: true, resume: "cp_1", setup: { version: 1 } }).success).toBe(false);
  });

  it("non-isolated QA variant rejects resume with qa: true", () => {
    expect(schema.safeParse({ goal, qa: true, resume: "cp_1" }).success).toBe(false);
  });
});

describe("cloud command runner for the checkpoint journal", () => {
  it("lists the journal commands", () => {
    for (const name of ["startJournal", "stopJournal", "captureCheckpoint"]) expect(COMMAND_NAMES).toContain(name);
  });

  function runner() {
    const controller = {
      startJournal: vi.fn(() => "owner-tok"),
      stopJournal: vi.fn(() => true),
      captureCheckpoint: vi.fn(async () => ({ ok: true, complete: true, summary: "s", fixture: { version: 1 } })),
    };
    return { controller, run: toCommandRunner(controller as unknown as BrowserController) };
  }

  it("startJournal forwards origins and returns the token", async () => {
    const { controller, run } = runner();
    expect(await run.startJournal({ origins: ["https://a.test"] })).toEqual({ ok: true, token: "owner-tok" });
    expect(controller.startJournal).toHaveBeenCalledWith({ origins: ["https://a.test"] });
    await run.startJournal();
    expect(controller.startJournal).toHaveBeenLastCalledWith(undefined);
    expect(await run.startJournal({ origins: [] })).toMatchObject({ ok: true });
    expect(controller.startJournal).toHaveBeenLastCalledWith({ origins: [] });
  });

  it.each([
    ["a string", "https://a.test"],
    ["21 origins", Array.from({ length: 21 }, () => "https://a.test")],
    ["a long origin", ["x".repeat(513)]],
    ["a non-string entry", [1]],
    ["a non-http scheme", ["ftp://a.test"]],
    ["an origin with a path", ["https://a.test/x"]],
    ["a non-URL", ["not a url"]],
  ])("startJournal rejects origins as %s", async (_n, origins) => {
    const { controller, run } = runner();
    expect(await run.startJournal({ origins })).toMatchObject({ ok: false });
    expect(controller.startJournal).not.toHaveBeenCalled();
  });

  it("stopJournal and captureCheckpoint forward and validate the token", async () => {
    const { controller, run } = runner();
    expect(await run.stopJournal({ token: "t" })).toEqual({ ok: true });
    expect(controller.stopJournal).toHaveBeenCalledWith("t");
    expect(await run.captureCheckpoint({ token: "t" })).toMatchObject({ ok: true, complete: true });
    expect(controller.captureCheckpoint).toHaveBeenCalledWith("t");
    expect(await run.stopJournal({})).toEqual({ ok: false, error: "token is required" });
    expect(await run.captureCheckpoint()).toEqual({ ok: false, error: "token is required" });
    const long = { token: "x".repeat(513) };
    expect(await run.stopJournal(long)).toMatchObject({ ok: false });
    expect(await run.captureCheckpoint(long)).toMatchObject({ ok: false });
    expect(controller.stopJournal).toHaveBeenCalledTimes(1);
    expect(controller.captureCheckpoint).toHaveBeenCalledTimes(1);
  });
});

describe("cloud command runner for fixtures", () => {
  it("lists the new commands", () => {
    expect(COMMAND_NAMES).toContain("applyFixture");
    expect(COMMAND_NAMES).toContain("releaseFixture");
  });

  function runner() {
    const controller = {
      applyFixture: vi.fn(async () => ({ ok: true, summary: "s" })),
      releaseFixture: vi.fn(async () => undefined),
    };
    return { controller, run: toCommandRunner(controller as unknown as BrowserController) };
  }

  it("applyFixture passes allowNetworkMocks: true", async () => {
    const { controller, run } = runner();
    const fixture = { version: 1, url: "https://a.test" };
    expect(await run.applyFixture({ fixture })).toEqual({ ok: true, summary: "s" });
    expect(controller.applyFixture).toHaveBeenCalledWith(fixture, { allowNetworkMocks: true });
  });

  it("applyFixture refuses a missing fixture without calling the controller", async () => {
    const { controller, run } = runner();
    expect(await run.applyFixture({})).toMatchObject({ ok: false, stage: "validate" });
    expect(controller.applyFixture).not.toHaveBeenCalled();
  });

  it("releaseFixture forwards the token and validates it", async () => {
    const { controller, run } = runner();
    expect(await run.releaseFixture({ token: "tok" })).toEqual({ ok: true });
    expect(controller.releaseFixture).toHaveBeenCalledWith("tok");
    expect(await run.releaseFixture()).toEqual({ ok: true });
    expect(controller.releaseFixture).toHaveBeenLastCalledWith(undefined);
    expect(await run.releaseFixture({ token: "x".repeat(513) })).toMatchObject({ ok: false });
    expect(controller.releaseFixture).toHaveBeenCalledTimes(2);
  });
});
