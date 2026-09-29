// Session registry for the cloud browser (spec §3.4/§5): signed handles, an
// in-memory map of live Steel sessions with a vendored BrowserController each,
// reconnect-after-restart, quotas and an idle sweeper. Nothing here touches the
// network directly — Steel and the CDP connector are injected.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SteelClient } from "../services/steel.js";
import { redactedError } from "./redact.js";

export const COMMAND_NAMES = ["open", "act", "findImages", "read", "snapshot", "screenshot", "tabs", "perform"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export type CommandResult = Record<string, unknown>;
export type CommandRunner = Record<CommandName, (args?: unknown) => Promise<CommandResult>>;

export interface ConnectedBrowser {
  controller: CommandRunner;
  close(): Promise<void>;
  /** Fires when the remote browser goes away (Steel timeout, crash, network). */
  onDisconnected(cb: () => void): void;
}
export type BrowserConnector = (cdpUrl: string) => Promise<ConnectedBrowser>;

export interface CloudSessionsOptions {
  steel: SteelClient;
  connect: BrowserConnector;
  /** HMAC key for handles (STEEL_API_KEY). */
  secret: string;
  maxSessions: number;
  sessionTimeoutMs: number;
  idleMs: number;
  dailySessions: number;
  now?: () => number;
}

export interface SessionEntry {
  id: string;
  controller: CommandRunner;
  browser: ConnectedBrowser;
  userId: string;
  chatId: string;
  lastUsedAt: number;
  expiresAt: number;
  liveViewUrl: string;
  /** Commands currently running on this entry; the idle sweeper never disposes while > 0. */
  inFlight: number;
}

export type ResolveOutcome =
  | { kind: "ok"; entry: SessionEntry; handle: string }
  | { kind: "no-session"; error: string; sessionExpired?: true }
  | { kind: "forbidden" }
  | { kind: "quota"; status: 429 | 503; error: string };

export const MSG_NO_SESSION = "No cloud browser session — call browse_open first.";
export const MSG_EXPIRED = "Cloud browser session expired — call browse_open again.";
export const MSG_BUSY = "All cloud browsers are busy — try again in a few minutes.";
export const MSG_DAILY = "Daily cloud browser limit reached — try again tomorrow.";

const VIEWPORT = { width: 1280, height: 800 };

export function signHandle(secret: string, userId: string, chatId: string, sessionId: string): string {
  const sig = createHmac("sha256", secret).update(`${userId}:${chatId}:${sessionId}`).digest("base64url");
  return `${sessionId}.${sig}`;
}

/** Returns the Steel session id when the handle's signature matches this user+chat, else null. */
export function verifyHandle(secret: string, userId: string, chatId: string, handle: string): string | null {
  const dot = handle.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = handle.slice(0, dot);
  const expected = Buffer.from(signHandle(secret, userId, chatId, sessionId));
  const given = Buffer.from(handle);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return sessionId;
}

function createsSession(command: CommandName, args: unknown): boolean {
  if (command === "open") return true;
  if (command !== "tabs" || typeof args !== "object" || args === null) return false;
  return (args as { action?: unknown }).action === "new";
}

export function createCloudSessions(opts: CloudSessionsOptions) {
  const now = opts.now ?? Date.now;
  const registry = new Map<string, SessionEntry>();
  const reconnecting = new Map<string, Promise<SessionEntry | "busy" | null>>();
  // One live session per user+chat: lets a handle-less (parallel / retried) open reuse
  // instead of orphaning a second Steel session.
  const byChat = new Map<string, string>();
  const creating = new Map<string, Promise<ResolveOutcome>>();
  const chatKey = (userId: string, chatId: string) => `${userId}:${chatId}`;
  const daily = new Map<string, number>();
  let pendingCreates = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const dayKey = () => new Date(now()).toISOString().slice(0, 10);

  function dailyCount(kind: string, id: string): number {
    return daily.get(`${dayKey()}|${kind}|${id}`) ?? 0;
  }
  /** Returns an undo for exactly the counter it bumped (the day may roll over meanwhile). */
  function bumpDaily(kind: string, id: string): () => void {
    const day = dayKey();
    for (const k of daily.keys()) if (!k.startsWith(day)) daily.delete(k);
    const key = `${day}|${kind}|${id}`;
    daily.set(key, (daily.get(key) ?? 0) + 1);
    return () => {
      const n = daily.get(key);
      if (n !== undefined) daily.set(key, Math.max(0, n - 1));
    };
  }

  function unregister(entry: SessionEntry) {
    if (registry.get(entry.id) === entry) registry.delete(entry.id);
    const k = chatKey(entry.userId, entry.chatId);
    if (byChat.get(k) === entry.id) byChat.delete(k);
  }

  function register(entry: SessionEntry) {
    registry.set(entry.id, entry);
    byChat.set(chatKey(entry.userId, entry.chatId), entry.id);
    // A dead session must not linger in the registry: the next command then takes the
    // "expired" path instead of driving a closed browser.
    entry.browser.onDisconnected(() => {
      if (registry.get(entry.id) !== entry) return;
      unregister(entry);
      void opts.steel.releaseSession(entry.id).catch(() => {});
    });
  }

  async function dispose(entry: SessionEntry) {
    unregister(entry);
    await entry.browser.close().catch(() => {});
    await opts.steel.releaseSession(entry.id).catch(() => {});
  }

  async function connectSafely(url: string): Promise<ConnectedBrowser> {
    try {
      return await opts.connect(url);
    } catch (e) {
      throw redactedError(e, url); // the CDP URL carries the Steel API key
    }
  }

  async function reconnect(id: string, userId: string, chatId: string): Promise<SessionEntry | "busy" | null> {
    const status = await opts.steel.getSession(id);
    if (!status || status.status !== "live") return null;
    if (registry.size + pendingCreates >= opts.maxSessions) return "busy";
    // Reserve a slot while connecting, so concurrent creates/reconnects cannot overshoot the cap.
    pendingCreates++;
    try {
      const browser = await connectSafely(opts.steel.cdpUrl(id));
      const created = status.createdAt ? Date.parse(status.createdAt) : NaN;
      const expiresAt =
        Number.isFinite(created) && status.timeoutMs ? created + status.timeoutMs : now() + opts.sessionTimeoutMs;
      const entry: SessionEntry = {
        id, controller: browser.controller, browser, userId, chatId,
        lastUsedAt: now(), expiresAt, liveViewUrl: status.liveViewUrl ?? "", inFlight: 0,
      };
      register(entry);
      return entry;
    } finally {
      pendingCreates--;
    }
  }

  async function create(userId: string, chatId: string, ip: string): Promise<ResolveOutcome> {
    if (registry.size + pendingCreates >= opts.maxSessions) return { kind: "quota", status: 503, error: MSG_BUSY };
    if (dailyCount("u", userId) >= opts.dailySessions || dailyCount("ip", ip) >= opts.dailySessions) {
      return { kind: "quota", status: 429, error: MSG_DAILY };
    }
    // Counted before the await so concurrent creates cannot overshoot; undone on failure.
    pendingCreates++;
    const undoUser = bumpDaily("u", userId);
    const undoIp = bumpDaily("ip", ip);
    const startedAt = now();
    try {
      const session = await opts.steel.createSession({ timeoutMs: opts.sessionTimeoutMs, dimensions: VIEWPORT });
      let browser: ConnectedBrowser;
      try {
        browser = await connectSafely(opts.steel.cdpUrl(session.id));
      } catch (e) {
        await opts.steel.releaseSession(session.id).catch(() => {});
        throw e;
      }
      const created = session.createdAt ? Date.parse(session.createdAt) : NaN;
      const expiresAt = Number.isFinite(created)
        ? created + (session.timeoutMs ?? opts.sessionTimeoutMs)
        : startedAt + opts.sessionTimeoutMs;
      const entry: SessionEntry = {
        id: session.id, controller: browser.controller, browser, userId, chatId,
        lastUsedAt: now(), expiresAt, liveViewUrl: session.liveViewUrl, inFlight: 0,
      };
      register(entry);
      return { kind: "ok", entry, handle: signHandle(opts.secret, userId, chatId, entry.id) };
    } catch (e) {
      undoUser();
      undoIp();
      throw e;
    } finally {
      pendingCreates--;
    }
  }

  /** Creates, unless this user+chat already has a live session or a create in flight. */
  async function createOrReuse(userId: string, chatId: string, ip: string): Promise<ResolveOutcome> {
    const key = chatKey(userId, chatId);
    const inflight = creating.get(key);
    if (inflight) return inflight;
    const existingId = byChat.get(key);
    const existing = existingId ? registry.get(existingId) : undefined;
    if (existing) {
      if (existing.expiresAt > now()) {
        existing.lastUsedAt = now();
        return { kind: "ok", entry: existing, handle: signHandle(opts.secret, userId, chatId, existing.id) };
      }
      await dispose(existing);
    }
    const again = creating.get(key); // a racer may have started while we disposed
    if (again) return again;
    const p = create(userId, chatId, ip).finally(() => creating.delete(key));
    creating.set(key, p);
    return p;
  }

  return {
    async resolve(p: { userId: string; chatId: string; ip: string; handle?: string; command: CommandName; args?: unknown }): Promise<ResolveOutcome> {
      const { userId, chatId, handle, command } = p;
      let expired = false;
      if (handle) {
        const id = verifyHandle(opts.secret, userId, chatId, handle);
        if (!id) return { kind: "forbidden" };
        let entry = registry.get(id) ?? null;
        if (entry && entry.expiresAt <= now()) {
          await dispose(entry);
          entry = null;
        } else if (!entry) {
          let inflight = reconnecting.get(id);
          if (!inflight) {
            inflight = reconnect(id, userId, chatId).finally(() => reconnecting.delete(id));
            reconnecting.set(id, inflight);
          }
          const got = await inflight;
          if (got === "busy") return { kind: "quota", status: 503, error: MSG_BUSY };
          entry = got;
        }
        if (entry) {
          entry.lastUsedAt = now();
          return { kind: "ok", entry, handle };
        }
        expired = true;
      }
      if (createsSession(command, p.args)) return createOrReuse(userId, chatId, p.ip);
      return expired
        ? { kind: "no-session", error: MSG_EXPIRED, sessionExpired: true }
        : { kind: "no-session", error: MSG_NO_SESSION };
    },

    /** Runs a command; `inFlight` keeps the idle sweeper off the entry meanwhile, and lastUsedAt is stamped after. */
    async run(entry: SessionEntry, command: CommandName, args: unknown): Promise<CommandResult> {
      entry.inFlight++;
      try {
        return await entry.controller[command](args);
      } finally {
        entry.inFlight--;
        entry.lastUsedAt = now();
      }
    },

    async release(userId: string, chatId: string, handle: string): Promise<{ released: boolean } | { forbidden: true }> {
      const id = verifyHandle(opts.secret, userId, chatId, handle);
      if (!id) return { forbidden: true };
      const entry = registry.get(id);
      if (entry) {
        await dispose(entry);
        return { released: true };
      }
      // Not in memory (restart): still ask Steel to stop billing for it.
      try {
        await opts.steel.releaseSession(id);
        return { released: true };
      } catch {
        return { released: false };
      }
    },

    async sweep(): Promise<number> {
      const t = now();
      const stale = [...registry.values()].filter((e) => (e.inFlight === 0 && t - e.lastUsedAt > opts.idleMs) || t >= e.expiresAt);
      await Promise.all(stale.map(dispose));
      return stale.length;
    },

    startSweeper(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => { void this.sweep(); }, intervalMs);
      timer.unref();
    },

    /** Stops the sweeper and releases everything (best effort) — app close / SIGTERM. */
    async shutdown() {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...registry.values()].map(dispose));
    },

    size: () => registry.size,
  };
}

export type CloudSessions = ReturnType<typeof createCloudSessions>;
