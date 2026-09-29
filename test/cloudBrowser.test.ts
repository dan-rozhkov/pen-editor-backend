import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import { signHandle, verifyHandle, createCloudSessions, type CommandRunner, type ConnectedBrowser } from "../src/browser/cloudSessions.js";
import type { SteelClient } from "../src/services/steel.js";

const USER = "11111111-1111-4111-8111-111111111111";
const USER2 = "22222222-2222-4222-8222-222222222222";

function fakes() {
  let n = 0;
  const live = new Set<string>();
  const steel: SteelClient = {
    createSession: vi.fn(async () => {
      const id = `sess-${++n}`;
      live.add(id);
      return { id, liveViewUrl: `https://debug.steel/${id}`, websocketUrl: "wss://x" };
    }),
    getSession: vi.fn(async (id: string) => (live.has(id) ? { id, status: "live" } : null)),
    releaseSession: vi.fn(async (id: string) => { live.delete(id); }),
    cdpUrl: (id: string) => `wss://connect/${id}`,
  };
  const closed: string[] = [];
  const disconnects: (() => void)[] = [];
  const controller: CommandRunner = {
    open: vi.fn(async (a) => ({ url: "https://x", args: a })),
    act: vi.fn(async () => ({ ok: true })),
    findImages: vi.fn(async () => ({})),
    read: vi.fn(async () => ({})),
    snapshot: vi.fn(async () => ({ elements: [] })),
    screenshot: vi.fn(async () => ({})),
    tabs: vi.fn(async () => ({ tabs: [] })),
    perform: vi.fn(async () => ({ error: "stale snapshotId" })),
  };
  const connect = vi.fn(async (url: string): Promise<ConnectedBrowser> => ({
    controller,
    close: async () => { closed.push(url); },
    onDisconnected: (cb) => { disconnects.push(cb); },
  }));
  return { steel, connect, controller, live, closed, disconnects };
}

const apps: { close(): Promise<unknown> }[] = [];
async function start(over: Parameters<typeof makeConfig>[0] = {}, f = fakes(), logger: NonNullable<Parameters<typeof buildApp>[1]>["logger"] = false) {
  const app = await buildApp(makeConfig({ STEEL_API_KEY: "steel-key", ...over }), {
    logger,
    cloudBrowser: { steel: f.steel, connect: f.connect },
  });
  apps.push(app);
  const cmd = (name: string, body: unknown) =>
    app.inject({ method: "POST", url: `/api/browser/cmd/${name}`, payload: body as object });
  return { app, f, cmd };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("handles", () => {
  it("verifies only for the same user+chat", () => {
    const h = signHandle("k", USER, "chat", "sess-1");
    expect(verifyHandle("k", USER, "chat", h)).toBe("sess-1");
    expect(verifyHandle("k", USER2, "chat", h)).toBeNull();
    expect(verifyHandle("k", USER, "other", h)).toBeNull();
    expect(verifyHandle("k2", USER, "chat", h)).toBeNull();
    expect(verifyHandle("k", USER, "chat", "garbage")).toBeNull();
  });
});

describe("cloud browser routes", () => {
  it("reports disabled and 503s without STEEL_API_KEY", async () => {
    const app = await buildApp(makeConfig({ STEEL_API_KEY: undefined }), { logger: false });
    apps.push(app);
    const cfg = await app.inject({ url: "/api/browser/config" });
    expect(cfg.json()).toEqual({ enabled: false });
    const res = await app.inject({ method: "POST", url: "/api/browser/cmd/open", payload: { userId: USER, chatId: "c" } });
    expect(res.statusCode).toBe(503);
  });

  it("reports enabled", async () => {
    const { app } = await start();
    expect((await app.inject({ url: "/api/browser/config" })).json()).toEqual({ enabled: true });
  });

  it("400s on an unknown command and on a bad userId", async () => {
    const { cmd } = await start();
    expect((await cmd("nope", { userId: USER, chatId: "c" })).statusCode).toBe(400);
    expect((await cmd("open", { userId: "test", chatId: "c" })).statusCode).toBe(400);
  });

  it("creates a session on open, reuses it, and returns the controller result verbatim", async () => {
    const { cmd, f } = await start();
    const first = (await cmd("open", { userId: USER, chatId: "c", args: { url: "https://a.com" } })).json();
    expect(first.result).toEqual({ url: "https://x", args: { url: "https://a.com" } });
    expect(first.liveViewUrl).toBe("https://debug.steel/sess-1");
    expect(first.expiresAt).toBeGreaterThan(Date.now());
    expect(first.idleMs).toBe(300_000);
    const snap = (await cmd("snapshot", { userId: USER, chatId: "c", handle: first.handle })).json();
    expect(snap.result).toEqual({ elements: [] });
    expect(snap.handle).toBe(first.handle);
    expect(f.steel.createSession).toHaveBeenCalledTimes(1);
  });

  it("errors on a non-open command with no handle", async () => {
    const { cmd } = await start();
    const res = (await cmd("snapshot", { userId: USER, chatId: "c" })).json();
    expect(res.result).toEqual({ error: "No cloud browser session — call browse_open first." });
    expect(res.handle).toBeNull();
  });

  it("403s a handle presented by another user or chat", async () => {
    const { cmd } = await start();
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    expect((await cmd("snapshot", { userId: USER2, chatId: "c", handle })).statusCode).toBe(403);
    expect((await cmd("snapshot", { userId: USER, chatId: "d", handle })).statusCode).toBe(403);
  });

  it("reconnects a live Steel session after the registry is lost", async () => {
    const f = fakes();
    const one = await start({}, f);
    const { handle } = (await one.cmd("open", { userId: USER, chatId: "c" })).json();
    // Fresh app = restarted process; the Steel session is still live.
    f.connect.mockClear();
    const two = await start({}, f);
    const res = (await two.cmd("perform", { userId: USER, chatId: "c", handle })).json();
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(res.result).toEqual({ error: "stale snapshotId" });
    expect(res.handle).toBe(handle);
  });

  it("reports an expired session, and open creates a fresh one", async () => {
    const f = fakes();
    const { cmd } = await start({}, f);
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    f.live.clear();
    const { app } = await start({}, f); // registry lost AND steel session gone
    const res = (await app.inject({ method: "POST", url: "/api/browser/cmd/snapshot", payload: { userId: USER, chatId: "c", handle } })).json();
    expect(res.result).toEqual({ error: "Cloud browser session expired — call browse_open again.", sessionExpired: true });
    const again = (await app.inject({ method: "POST", url: "/api/browser/cmd/tabs", payload: { userId: USER, chatId: "c", handle, args: { action: "new" } } })).json();
    expect(again.handle).not.toBe(handle);
  });

  it("enforces the global cap (503) and the per-user daily limit (429)", async () => {
    const { cmd } = await start({ CLOUD_BROWSER_MAX_SESSIONS: 1 });
    expect((await cmd("open", { userId: USER, chatId: "a" })).statusCode).toBe(200);
    const busy = await cmd("open", { userId: USER2, chatId: "b" });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error).toBe("All cloud browsers are busy — try again in a few minutes.");

    const daily = await start({ CLOUD_BROWSER_DAILY_SESSIONS: 1 });
    expect((await daily.cmd("open", { userId: USER, chatId: "a" })).statusCode).toBe(200);
    expect((await daily.cmd("open", { userId: USER, chatId: "b" })).statusCode).toBe(429);
  });

  it("releases via /release and 403s a foreign handle", async () => {
    const { app, cmd, f } = await start();
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    const bad = await app.inject({ method: "POST", url: "/api/browser/release", payload: { userId: USER2, chatId: "c", handle } });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/browser/release", payload: { userId: USER, chatId: "c", handle } });
    expect(ok.json()).toEqual({ released: true });
    expect(f.steel.releaseSession).toHaveBeenCalledWith("sess-1");
  });

  it("releases every session when the app closes", async () => {
    const { app, cmd, f } = await start();
    await cmd("open", { userId: USER, chatId: "c" });
    await app.close();
    expect(f.steel.releaseSession).toHaveBeenCalledWith("sess-1");
    expect(f.closed).toHaveLength(1);
  });
});

describe("idle sweeper", () => {
  it("releases idle and expired sessions", async () => {
    const f = fakes();
    let t = 1_000_000;
    const sessions = createCloudSessions({
      steel: f.steel, connect: f.connect, secret: "k", maxSessions: 5,
      sessionTimeoutMs: 900_000, idleMs: 300_000, dailySessions: 20, now: () => t,
    });
    await sessions.resolve({ userId: USER, chatId: "a", ip: "1.1.1.1", command: "open" });
    t += 200_000;
    await sessions.resolve({ userId: USER2, chatId: "b", ip: "1.1.1.2", command: "open" });
    expect(await sessions.sweep()).toBe(0);
    t += 150_000; // session a idle 350s, b idle 150s
    expect(await sessions.sweep()).toBe(1);
    expect(sessions.size()).toBe(1);
    t += 600_000; // b past its 15 min expiry
    expect(await sessions.sweep()).toBe(1);
    expect(sessions.size()).toBe(0);
    await sessions.shutdown();
  });
});

function sessionsWith(f: ReturnType<typeof fakes>, over: Partial<Parameters<typeof createCloudSessions>[0]> = {}) {
  return createCloudSessions({
    steel: f.steel, connect: f.connect, secret: "k", maxSessions: 5,
    sessionTimeoutMs: 900_000, idleMs: 300_000, dailySessions: 20, ...over,
  });
}
const open = (s: ReturnType<typeof sessionsWith>, over: Record<string, unknown> = {}) =>
  s.resolve({ userId: USER, chatId: "c", ip: "1.1.1.1", command: "open", ...over });

describe("orphan prevention", () => {
  it("shares one create between concurrent handle-less opens", async () => {
    const f = fakes();
    const s = sessionsWith(f);
    const outs = await Promise.all([open(s), open(s), open(s)]);
    expect(f.steel.createSession).toHaveBeenCalledTimes(1);
    expect(new Set(outs.map((o) => (o.kind === "ok" ? o.handle : null))).size).toBe(1);
    await s.shutdown();
  });

  it("reuses the live session for a handle-less open in the same chat", async () => {
    const f = fakes();
    const s = sessionsWith(f);
    const a = await open(s);
    const b = await open(s);
    expect(f.steel.createSession).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ kind: "ok", handle: (a as { handle: string }).handle });
    await s.shutdown();
  });
});

describe("dead sessions", () => {
  it("evicts on disconnect, releases best-effort, and open then creates anew", async () => {
    const f = fakes();
    const s = sessionsWith(f);
    const first = (await open(s)) as { handle: string };
    f.disconnects[0]!();
    expect(s.size()).toBe(0);
    expect(f.steel.releaseSession).toHaveBeenCalledWith("sess-1");
    const snap = await s.resolve({ userId: USER, chatId: "c", ip: "1.1.1.1", command: "snapshot", handle: first.handle });
    expect(snap).toMatchObject({ kind: "no-session", sessionExpired: true });
    const again = await open(s, { handle: first.handle });
    expect(again).toMatchObject({ kind: "ok" });
    expect((again as { handle: string }).handle).not.toBe(first.handle);
    await s.shutdown();
  });

  it("computes expiresAt from Steel's createdAt + timeout, else from before createSession", async () => {
    const f = fakes();
    const created = new Date(5_000_000).toISOString();
    f.steel.createSession = vi.fn(async () => ({ id: "s", liveViewUrl: "u", websocketUrl: "", createdAt: created, timeoutMs: 60_000 }));
    const a = await open(sessionsWith(f, { now: () => 9_000_000 }));
    expect(a).toMatchObject({ kind: "ok", entry: { expiresAt: 5_060_000 } });

    const g = fakes();
    let t = 1_000;
    const inner = g.steel.createSession;
    g.steel.createSession = vi.fn(async (o) => { t += 500; return inner(o); });
    const b = await open(sessionsWith(g, { now: () => t }));
    expect(b).toMatchObject({ kind: "ok", entry: { expiresAt: 1_000 + 900_000 } });
  });
});

describe("quotas under concurrency", () => {
  it("does not overshoot the daily limit with concurrent creates, and rolls back failures", async () => {
    const f = fakes();
    const s = sessionsWith(f, { dailySessions: 1 });
    const outs = await Promise.all([
      open(s, { chatId: "a" }),
      open(s, { chatId: "b" }),
    ]);
    expect(f.steel.createSession).toHaveBeenCalledTimes(1);
    expect(outs.filter((o) => o.kind === "quota")).toHaveLength(1);
    await s.shutdown();

    const g = fakes();
    g.connect.mockRejectedValueOnce(new Error("boom"));
    const s2 = sessionsWith(g, { dailySessions: 1 });
    await expect(open(s2)).rejects.toThrow("boom");
    expect(await open(s2)).toMatchObject({ kind: "ok" }); // counter was rolled back
    await s2.shutdown();
  });

  it("reconnect answers busy when the registry is full", async () => {
    const f = fakes();
    const first = sessionsWith(f);
    const { handle } = (await open(first, { chatId: "x" })) as { handle: string };
    const s = sessionsWith(f, { maxSessions: 1 });
    await open(s, { userId: USER2, chatId: "y" });
    const out = await s.resolve({ userId: USER, chatId: "x", ip: "1.1.1.1", command: "snapshot", handle });
    expect(out).toMatchObject({ kind: "quota", status: 503 });
    await s.shutdown();
    await first.shutdown();
  });
});

describe("reconnect slot reservation and in-flight guard", () => {
  it("reserves a slot while a reconnect is connecting", async () => {
    const f = fakes();
    const first = sessionsWith(f);
    const { handle } = (await open(first, { chatId: "x" })) as { handle: string };
    const s = sessionsWith(f, { maxSessions: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = f.connect.getMockImplementation()!;
    f.connect.mockImplementationOnce(async (u: string) => { await gate; return inner(u); });
    const reconnecting = s.resolve({ userId: USER, chatId: "x", ip: "1.1.1.1", command: "snapshot", handle });
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(2));
    const other = await open(s, { userId: USER2, chatId: "y" });
    expect(other).toMatchObject({ kind: "quota", status: 503 });
    release();
    expect(await reconnecting).toMatchObject({ kind: "ok" });
    await s.shutdown();
    await first.shutdown();
  });

  it("does not sweep an idle entry while a command is in flight, but still on hard expiry", async () => {
    const f = fakes();
    let t = 1_000_000;
    const s = sessionsWith(f, { now: () => t });
    const out = (await open(s)) as { entry: { inFlight: number } } & { kind: "ok" };
    let finish!: () => void;
    f.controller.snapshot = vi.fn(() => new Promise((r) => { finish = () => r({ elements: [] }); }));
    const running = s.run(out.entry as never, "snapshot", undefined);
    t += 400_000; // idle > 300s but a command is running
    expect(await s.sweep()).toBe(0);
    expect(s.size()).toBe(1);
    finish();
    await running;
    expect(out.entry.inFlight).toBe(0);
    t += 400_000; // idle again after the command
    expect(await s.sweep()).toBe(1);

    const s2 = sessionsWith(f, { now: () => t });
    const o2 = (await open(s2, { chatId: "z" })) as { entry: unknown } & { kind: "ok" };
    f.controller.snapshot = vi.fn(() => new Promise(() => {}));
    void s2.run(o2.entry as never, "snapshot", undefined);
    t += 1_000_000; // past expiresAt
    expect(await s2.sweep()).toBe(1);
  });
});

describe("api key redaction", () => {
  it("keeps the Steel key out of the response and the logs when connect fails", async () => {
    const f = fakes();
    const key = "steel-key";
    f.steel.cdpUrl = (id: string) => `wss://connect.steel.dev?apiKey=${key}&sessionId=${id}`;
    f.connect.mockRejectedValue(new Error(`connect ECONNREFUSED wss://connect.steel.dev?apiKey=${key}&sessionId=sess-1`));
    const lines: string[] = [];
    const stream = { write: (l: string) => { lines.push(l); } };
    const { cmd } = await start({}, f, { level: "warn", stream });
    const res = await cmd("open", { userId: USER, chatId: "c" });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(key);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain(key);
  });
});
