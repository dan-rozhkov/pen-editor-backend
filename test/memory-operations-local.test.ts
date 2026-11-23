import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalMemoryApp } from "./localMemoryApp.js";

const TOKEN = "local-ops-token";
const USER = "3b241101-e2bb-4255-8caf-4136c566a962";

describe("local app POST /api/memory/operations", () => {
  let url: string;
  let close: () => Promise<void>;
  const headers = { "x-sideform-local-token": TOKEN, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}userId=${USER}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const write = (target: string, operations: unknown[]) =>
    call("POST", "/api/memory/operations", { target, operations });

  beforeAll(async () => {
    ({ url, close } = await startLocalMemoryApp(TOKEN, "memory-ops-"));
  });
  afterAll(() => close());

  it("needs the token", async () => {
    const res = await fetch(`${url}/api/memory/operations?userId=${USER}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("adds, replaces and removes with the tool's semantics, and reports activity", async () => {
    const base = (await call("GET", "/api/memory/activity")).body.latestId ?? 0;

    const added = await write("user", [{ action: "add", content: "likes tea" }, { action: "add", content: "lives in Oslo" }]);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ ok: true, user: ["likes tea", "lives in Oslo"], memory: [], limits: { memory: 2200, user: 1375 } });

    const replaced = await write("user", [{ action: "replace", old_text: "Oslo", content: "lives in Bergen" }]);
    expect(replaced.body.user).toEqual(["likes tea", "lives in Bergen"]);

    const removed = await write("user", [{ action: "remove", old_text: "tea" }]);
    expect(removed.body.user).toEqual(["lives in Bergen"]);

    const activity = await call("GET", `/api/memory/activity?sinceId=${base}`);
    expect(activity.body.events).toHaveLength(3);
    expect(activity.body.events[0]).toMatchObject({ subsystem: "memory", origin: "user", detail: { kind: "memory", target: "user" } });
  });

  it("rejects an ambiguous old_text with memory_rejected and changes nothing", async () => {
    await write("memory", [{ action: "add", content: "note one" }, { action: "add", content: "note two" }]);
    const res = await write("memory", [{ action: "remove", old_text: "note" }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("memory_rejected");
    expect(typeof res.body.error).toBe("string");
    expect((await call("GET", "/api/memory")).body.memory).toEqual(["note one", "note two"]);
  });

  it("rejects an over-limit batch and changes nothing", async () => {
    const res = await write("user", [{ action: "add", content: "x".repeat(1500) }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("memory_rejected");
    expect((await call("GET", "/api/memory")).body.user).toEqual(["lives in Bergen"]);
  });

  it("400s on an invalid body", async () => {
    expect((await write("nope", [{ action: "add", content: "a" }])).body).toEqual({ error: "Invalid body" });
    expect((await write("user", [])).status).toBe(400);
  });

  it("409s while memory is turned off", async () => {
    await call("PUT", "/api/memory/settings", { enabled: false });
    const res = await write("user", [{ action: "add", content: "hidden" }]);
    expect(res).toEqual({ status: 409, body: { error: "Memory is turned off in Settings > Memory.", code: "memory_disabled" } });
    await call("PUT", "/api/memory/settings", { enabled: true });
    expect((await call("GET", "/api/memory")).body.user).toEqual(["lives in Bergen"]);
  });
});
