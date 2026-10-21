import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import { signHandle, verifyHandle, createCloudSessions, type CommandRunner, type ConnectedBrowser, type ResolveOutcome } from "../src/browser/cloudSessions.js";
import type { SteelClient } from "../src/services/steel.js";
import { toCommandRunner } from "../src/browser/connect.js";
import type { BrowserController } from "@sideform/browser-agent/controller";

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
    capture: vi.fn(async () => ({ html: "<p>x</p>" })),
    tabs: vi.fn(async () => ({ tabs: [] })),
    perform: vi.fn(async () => ({ error: "stale snapshotId" })),
    assert: vi.fn(async () => ({ ok: true, passed: true, results: [] })),
    applyFixture: vi.fn(async () => ({ ok: true, summary: "applied", fixtureToken: "tok" })),
    releaseFixture: vi.fn(async () => ({ ok: true })),
    startJournal: vi.fn(async () => ({ ok: true, token: "jt" })),
    stopJournal: vi.fn(async () => ({ ok: true })),
    captureCheckpoint: vi.fn(async () => ({ ok: true, complete: true, summary: "s", fixture: {} })),
    clearActEmulation: vi.fn(async () => ({ ok: true })),
    requests: vi.fn(async () => ({ requests: [] })),
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

  it("refuses to open a desktop app and starts no cloud session", async () => {
    const { cmd, f } = await start();
    const res = (await cmd("open", { userId: USER, chatId: "c", args: { app: "/Applications/Orca.app" } })).json();
    expect(res).toEqual({ result: { error: "Desktop apps need Sideform Desktop." }, handle: null, liveViewUrl: null, expiresAt: null });
    expect(f.steel.createSession).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("errors on a non-open command with no handle", async () => {
    const { cmd } = await start();
    const res = (await cmd("snapshot", { userId: USER, chatId: "c" })).json();
    expect(res.result).toEqual({ error: "No cloud browser session — call browse_open first." });
    expect(res.handle).toBeNull();
  });

  it("routes capture to the controller's capture", async () => {
    const f = fakes();
    const { cmd } = await start({}, f);
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    const res = (await cmd("capture", { userId: USER, chatId: "c", handle, args: { index: 2 } })).json();
    expect(f.controller.capture).toHaveBeenCalledTimes(1);
    expect(res.result).toEqual({ html: "<p>x</p>" });
  });

  it("creates a session on applyFixture and forwards the fixture args", async () => {
    const f = fakes();
    const { cmd } = await start({}, f);
    const fixture = { version: 1, url: "https://a.com", network: [{ url: "https://a.com/api*", status: 500 }] };
    const res = (await cmd("applyFixture", { userId: USER, chatId: "c", args: { fixture } })).json();
    expect(f.steel.createSession).toHaveBeenCalledTimes(1);
    expect(res.handle).toBeTruthy();
    expect(res.result).toEqual({ ok: true, summary: "applied", fixtureToken: "tok" });
    expect(f.controller.applyFixture).toHaveBeenCalledWith({ fixture });
  });

  it("forwards releaseFixture's token to the session's controller", async () => {
    const f = fakes();
    const { cmd } = await start({}, f);
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    const res = (await cmd("releaseFixture", { userId: USER, chatId: "c", handle, args: { token: "tok" } })).json();
    expect(f.controller.releaseFixture).toHaveBeenCalledWith({ token: "tok" });
    expect(res.result).toEqual({ ok: true });
    const noSession = (await cmd("releaseFixture", { userId: USER, chatId: "other", args: { token: "tok" } })).json();
    expect(noSession.handle).toBeNull();
  });

  it("forwards clearActEmulation to the session's controller", async () => {
    const f = fakes();
    const { cmd } = await start({}, f);
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    const res = (await cmd("clearActEmulation", { userId: USER, chatId: "c", handle })).json();
    expect(f.controller.clearActEmulation).toHaveBeenCalled();
    expect(res.result).toEqual({ ok: true });
  });

  it("toCommandRunner maps clearActEmulation to controller.clearActEmulation()", async () => {
    const bc = { clearActEmulation: vi.fn(async () => undefined) };
    const runner = toCommandRunner(bc as unknown as BrowserController);
    expect(await runner.clearActEmulation(undefined)).toEqual({ ok: true });
    expect(bc.clearActEmulation).toHaveBeenCalledTimes(1);
  });

  it("forwards requests to the session's controller and returns its object", async () => {
    const f = fakes();
    const { cmd } = await start({}, f);
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    const res = (await cmd("requests", { userId: USER, chatId: "c", handle })).json();
    expect(f.controller.requests).toHaveBeenCalled();
    expect(res.result).toEqual({ requests: [] });
  });

  it("toCommandRunner maps requests to controller.requests() unchanged", async () => {
    const out = { requests: [{ url: "https://a.test/" }], dropped: 2 };
    const bc = { requests: vi.fn(async () => out) };
    const runner = toCommandRunner(bc as unknown as BrowserController);
    expect(await runner.requests(undefined)).toEqual(out);
    expect(bc.requests).toHaveBeenCalledTimes(1);
  });

  describe("checkpoint journal (through the real toCommandRunner)", () => {
    function journalFakes() {
      const f = fakes();
      const order: string[] = [];
      const bc = {
        open: vi.fn(async () => { order.push("open"); return { url: "https://x" }; }),
        startJournal: vi.fn(() => { order.push("startJournal"); return "ctl-1"; }),
        stopJournal: vi.fn((t?: string) => t === "ctl-1"),
        captureCheckpoint: vi.fn(async (t?: string) =>
          t === "ctl-1" ? { ok: true, complete: true, summary: "s", fixture: {} } : { ok: false, error: "unknown checkpoint token" }),
      };
      const runner = toCommandRunner(bc as unknown as BrowserController);
      f.connect.mockImplementation(async (url: string): Promise<ConnectedBrowser> => ({
        controller: runner, close: async () => { f.closed.push(url); }, onDisconnected: (cb) => { f.disconnects.push(cb); },
      }));
      return { f, bc, order };
    }

    type CmdResponse = { result: { ok?: boolean; token?: string; error?: string; [k: string]: unknown }; handle: string | null; [k: string]: unknown };
    type Cmd = (name: string, body: unknown) => Promise<{ json(): CmdResponse }>;
    const call = (cmd: Cmd, name: string, args?: unknown, handle?: string, chatId = "c") =>
      cmd(name, { userId: USER, chatId, handle, args }).then((r) => r.json());

    it("a live session: startJournal maps a backend token to the controller token", async () => {
      const { f, bc } = journalFakes();
      const { cmd } = await start({}, f);
      const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
      const res = (await call(cmd, "startJournal", { origins: ["https://a.com"] }, handle, "c"));
      expect(res.result.ok).toBe(true);
      expect(res.result.token).toMatch(/^cj_/);
      expect(res.handle).toBe(handle);
      expect(bc.startJournal).toHaveBeenCalledWith({ origins: ["https://a.com"] });
      const token = res.result.token;
      const cp = (await call(cmd, "captureCheckpoint", { token }, handle, "c"));
      expect(cp.result).toMatchObject({ ok: true, complete: true });
      expect(bc.captureCheckpoint).toHaveBeenCalledWith("ctl-1");
      expect((await call(cmd, "stopJournal", { token }, handle, "c")).result).toEqual({ ok: true });
      expect(bc.stopJournal).toHaveBeenCalledWith("ctl-1");
      // after stop the mapping is gone: the raw token reaches the controller and its stale shape passes through
      expect((await call(cmd, "stopJournal", { token }, handle, "c")).result).toEqual({ ok: false });
      expect((await call(cmd, "captureCheckpoint", { token }, handle, "c")).result).toEqual({ ok: false, error: "unknown checkpoint token" });
    });

    it("no session: startJournal creates nothing and stays pending until open", async () => {
      const { f, bc, order } = journalFakes();
      const { cmd } = await start({}, f);
      const res = (await cmd("startJournal", { userId: USER, chatId: "c", args: { origins: ["https://a.com"] } })).json();
      expect(res).toMatchObject({ handle: null, liveViewUrl: null, expiresAt: null });
      expect(res.result.token).toMatch(/^cj_/);
      expect(f.steel.createSession).not.toHaveBeenCalled();
      expect(bc.startJournal).not.toHaveBeenCalled();
      const token = res.result.token;

      const opened = (await cmd("open", { userId: USER, chatId: "c" })).json();
      expect(f.steel.createSession).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["startJournal", "open"]);
      expect(bc.startJournal).toHaveBeenCalledWith({ origins: ["https://a.com"] });
      const cp = (await call(cmd, "captureCheckpoint", { token }, opened.handle, "c"));
      expect(cp.result).toMatchObject({ ok: true, complete: true });
      expect(bc.captureCheckpoint).toHaveBeenCalledWith("ctl-1");
    });

    it("pending journal: stop drops it, capture says no page was opened, neither creates a session", async () => {
      const { f, bc } = journalFakes();
      const { cmd } = await start({}, f);
      const t1 = (await cmd("startJournal", { userId: USER, chatId: "c" })).json().result.token;
      const cap = (await cmd("captureCheckpoint", { userId: USER, chatId: "c", args: { token: t1 } })).json();
      expect(cap).toMatchObject({ result: { ok: false, error: "no page was opened" }, handle: null });
      const stop = (await cmd("stopJournal", { userId: USER, chatId: "c", args: { token: t1 } })).json();
      expect(stop.result).toEqual({ ok: true });
      // dropped: a later open starts no journal
      await cmd("open", { userId: USER, chatId: "c" });
      expect(bc.startJournal).not.toHaveBeenCalled();
      expect(f.steel.createSession).toHaveBeenCalledTimes(1);
    });

    it("a new startJournal replaces the pending one; another chat cannot use the token", async () => {
      const { f, bc } = journalFakes();
      const { cmd } = await start({}, f);
      const t1 = (await cmd("startJournal", { userId: USER, chatId: "c" })).json().result.token;
      const t2 = (await cmd("startJournal", { userId: USER, chatId: "c" })).json().result.token;
      expect(t2).not.toBe(t1);
      const other = (await cmd("captureCheckpoint", { userId: USER, chatId: "other", args: { token: t2 } })).json();
      expect(other.result).toHaveProperty("error");
      expect(other.result.error).not.toBe("no page was opened");
      // t1 is gone: not pending any more
      expect((await cmd("captureCheckpoint", { userId: USER, chatId: "c", args: { token: t1 } })).json().result.error).not.toBe("no page was opened");
      await cmd("open", { userId: USER, chatId: "c" });
      expect(bc.startJournal).toHaveBeenCalledTimes(1);
    });

    it("pending journals expire after the idle time", async () => {
      const f = fakes();
      let t = 1_000_000;
      const sessions = createCloudSessions({
        steel: f.steel, connect: f.connect, secret: "k", maxSessions: 5, sessionTimeoutMs: 600_000, idleMs: 60_000, dailySessions: 10, now: () => t,
      });
      const base = { userId: USER, chatId: "c", ip: "1.1.1.1" };
      const out = await sessions.resolve({ ...base, command: "startJournal", args: {} });
      const token = (out as { result: { token: string } }).result.token;
      t += 61_000;
      const cap = await sessions.resolve({ ...base, command: "captureCheckpoint", args: { token } });
      expect(cap.kind).toBe("no-session");
      expect(f.steel.createSession).not.toHaveBeenCalled();
    });

    it("an expired handle makes startJournal pending without a session; open reports the expiry", async () => {
      const { f, bc } = journalFakes();
      const { cmd } = await start({}, f);
      const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
      f.live.clear(); // Steel forgot the session
      f.disconnects.forEach((cb) => cb()); // and the registry lost it
      const res = (await cmd("startJournal", { userId: USER, chatId: "c", handle })).json();
      expect(res.result.ok).toBe(true);
      expect(res.result).not.toHaveProperty("sessionExpired");
      expect(f.steel.createSession).toHaveBeenCalledTimes(1); // only the first open
      expect(bc.startJournal).not.toHaveBeenCalled();
      await cmd("open", { userId: USER, chatId: "c", handle });
      expect(f.steel.createSession).toHaveBeenCalledTimes(2);
      expect(bc.startJournal).toHaveBeenCalledTimes(1);
    });

    it.each(["stopJournal", "captureCheckpoint"])("%s requires a token and never reaches the controller", async (name) => {
      const { f, bc } = journalFakes();
      const { cmd } = await start({}, f);
      const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
      for (const args of [undefined, {}, { token: "" }]) {
        const r = (await cmd(name, { userId: USER, chatId: "c", handle, args })).json();
        expect(r.result).toEqual({ ok: false, error: "token is required" });
      }
      expect(bc.stopJournal).not.toHaveBeenCalled();
      expect(bc.captureCheckpoint).not.toHaveBeenCalled();
    });

    it("rejects bad origins before any session or pending journal", async () => {
      const { f } = journalFakes();
      const { cmd } = await start({}, f);
      for (const origins of [["ftp://a.com"], ["https://a.com/path"], ["nope"], "https://a.com"]) {
        const r = (await cmd("startJournal", { userId: USER, chatId: "c", args: { origins } })).json();
        expect(r.result).toMatchObject({ ok: false });
        expect(r.result.error).toBeTruthy();
      }
      expect((await cmd("startJournal", { userId: USER, chatId: "c", args: { origins: [] } })).json().result.ok).toBe(true);
      expect(f.steel.createSession).not.toHaveBeenCalled();
    });

    it("passes the controller's stale-token shape through for an unknown token", async () => {
      const { f } = journalFakes();
      const { cmd } = await start({}, f);
      const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
      expect((await call(cmd, "stopJournal", { token: "zzz" }, handle, "c")).result).toEqual({ ok: false });
      expect((await call(cmd, "captureCheckpoint", { token: "zzz" }, handle, "c")).result).toEqual({ ok: false, error: "unknown checkpoint token" });
    });

    it("stopJournal and captureCheckpoint with an unknown token and no session never create one", async () => {
      const { f } = journalFakes();
      const { cmd } = await start({}, f);
      for (const name of ["stopJournal", "captureCheckpoint"]) {
        const none = (await cmd(name, { userId: USER, chatId: "c", args: { token: "jt" } })).json();
        expect(none.handle).toBeNull();
        expect(none.result).toHaveProperty("error");
      }
      expect(f.steel.createSession).not.toHaveBeenCalled();
    });
  });

  describe("journal registry bookkeeping", () => {
    const base = { userId: USER, chatId: "c", ip: "1.1.1.1" };
    const tokenOf = (o: unknown) => (o as { result: { token: string } }).result.token;
    function okOutcome(o: ResolveOutcome): asserts o is Extract<ResolveOutcome, { kind: "ok" }> {
      expect(o.kind).toBe("ok");
    }
    function setup(over: Partial<Parameters<typeof createCloudSessions>[0]> = {}) {
      const f = fakes();
      let n = 0;
      (f.controller.startJournal as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: true, token: `ctl-${++n}` }));
      let t = 1_000_000;
      const clock = { advance: (ms: number) => { t += ms; } };
      const sessions = sessionsWith(f, { idleMs: 60_000, now: () => t, ...over });
      return { f, sessions, clock };
    }

    it("starting a live journal drops the chat's pending one, so a later open does not replace it", async () => {
      const { f, sessions } = setup();
      const other = sessionsWith(f, { idleMs: 60_000 }); // same Steel + secret: models a registry that lost the entry
      const o = await open(other);
      okOutcome(o);
      await sessions.resolve({ ...base, command: "startJournal", args: {} }); // no byChat here -> pending
      const live = await sessions.resolve({ ...base, handle: o.handle, command: "startJournal", args: {} }); // reconnects
      okOutcome(live);
      const liveToken = (await sessions.run(live.entry, "startJournal", {})).token as string;
      await sessions.resolve({ ...base, command: "tabs", handle: o.handle, args: { action: "new" } });
      expect(f.controller.startJournal).toHaveBeenCalledTimes(1); // the pending one never started
      await sessions.run(live.entry, "captureCheckpoint", { token: liveToken });
      expect(f.controller.captureCheckpoint).toHaveBeenLastCalledWith({ token: "ctl-1" });
    });

    it("an expired pending journal is not started", async () => {
      const { f, sessions, clock } = setup();
      await sessions.resolve({ ...base, command: "startJournal", args: {} });
      clock.advance(61_000);
      const o = await open(sessions);
      expect(o.kind).toBe("ok");
      expect(f.controller.startJournal).not.toHaveBeenCalled();
    });

    it("a stop that lands while the controller journal starts undoes it", async () => {
      const { f, sessions } = setup();
      let release!: () => void;
      (f.controller.startJournal as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise((res) => { release = () => res({ ok: true, token: "ctl-x" }); }),
      );
      const token = tokenOf(await sessions.resolve({ ...base, command: "startJournal", args: {} }));
      const opening = open(sessions);
      await vi.waitFor(() => expect(f.controller.startJournal).toHaveBeenCalled());
      const stop = await sessions.resolve({ ...base, command: "stopJournal", args: { token } });
      expect(stop).toEqual({ kind: "local", result: { ok: true } });
      release();
      const o = await opening;
      expect(o.kind).toBe("ok");
      expect(f.controller.stopJournal).toHaveBeenCalledWith({ token: "ctl-x" });
      // nothing registered: capture does not map to the controller journal
      okOutcome(o);
      await sessions.run(o.entry, "captureCheckpoint", { token });
      expect(f.controller.captureCheckpoint).toHaveBeenCalledWith({ token });
    });

    it("replaced live journals leave one record; a stale stop deletes its record", async () => {
      const { f, sessions } = setup();
      const o = await open(sessions);
      okOutcome(o);
      const t1 = (await sessions.run(o.entry, "startJournal", {})).token as string;
      const t2 = (await sessions.run(o.entry, "startJournal", {})).token as string;
      // t1 was retired when t2 started: it reaches the controller as is
      await sessions.run(o.entry, "captureCheckpoint", { token: t1 });
      expect(f.controller.captureCheckpoint).toHaveBeenLastCalledWith({ token: t1 });
      await sessions.run(o.entry, "captureCheckpoint", { token: t2 });
      expect(f.controller.captureCheckpoint).toHaveBeenLastCalledWith({ token: "ctl-2" });
      (f.controller.stopJournal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });
      await sessions.run(o.entry, "stopJournal", { token: t2 });
      await sessions.run(o.entry, "captureCheckpoint", { token: t2 });
      expect(f.controller.captureCheckpoint).toHaveBeenLastCalledWith({ token: t2 }); // record gone
    });

    it("caps pending journals globally, evicting the oldest, one per chat", async () => {
      const { f, sessions } = setup();
      const first = tokenOf(await sessions.resolve({ ...base, chatId: "c0", command: "startJournal", args: {} }));
      for (let i = 1; i <= 1000; i++) await sessions.resolve({ ...base, chatId: `c${i}`, command: "startJournal", args: {} });
      const evicted = await sessions.resolve({ ...base, chatId: "c0", command: "captureCheckpoint", args: { token: first } });
      expect(evicted.kind).toBe("no-session");
      const kept = await sessions.resolve({ ...base, chatId: "c1000", command: "captureCheckpoint", args: { token: "x" } });
      expect(kept.kind).toBe("no-session");
      // c1 is the oldest survivor
      await sessions.resolve({ ...base, chatId: "c1", command: "open" });
      expect(f.controller.startJournal).toHaveBeenCalledTimes(1);
    });

    it("startJournal without a handle uses the chat's live session and returns its handle", async () => {
      const { f, sessions } = setup();
      const o = await open(sessions);
      okOutcome(o);
      const r = await sessions.resolve({ ...base, command: "startJournal", args: {} });
      expect(r).toMatchObject({ kind: "ok", handle: o.handle });
      expect(f.steel.createSession).toHaveBeenCalledTimes(1);
      // another chat has no live session: stays pending
      const other = await sessions.resolve({ ...base, chatId: "d", command: "startJournal", args: {} });
      expect(other.kind).toBe("local");
    });

    it("the route returns the handle for a handle-less startJournal on a live chat", async () => {
      const f = fakes();
      const { cmd } = await start({}, f);
      const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
      const res = (await cmd("startJournal", { userId: USER, chatId: "c" })).json();
      expect(res.handle).toBe(handle);
      expect(res.result.token).toMatch(/^cj_/);
    });
  });

  it("403s a handle presented by another user or chat", async () => {
    const { cmd } = await start();
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    expect((await cmd("snapshot", { userId: USER2, chatId: "c", handle })).statusCode).toBe(403);
    expect((await cmd("snapshot", { userId: USER, chatId: "d", handle })).statusCode).toBe(403);
  });

  it("runs the assert command on the controller", async () => {
    const f = fakes();
    const { cmd } = await start({}, f);
    const { handle } = (await cmd("open", { userId: USER, chatId: "c" })).json();
    const checks = [{ type: "text", text: "Welcome" }];
    const res = (await cmd("assert", { userId: USER, chatId: "c", handle, args: { checks } })).json();
    expect(f.controller.assert).toHaveBeenCalledWith({ checks });
    expect(res.result).toEqual({ ok: true, passed: true, results: [] });
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
