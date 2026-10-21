// Session registry for the cloud browser (spec §3.4/§5): signed handles, an
// in-memory map of live Steel sessions with a BrowserController each,
// reconnect-after-restart, quotas and an idle sweeper. Nothing here touches the
// network directly — Steel and the CDP connector are injected.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SteelClient } from "../services/steel.js";
import { redactedError } from "@sideform/browser-agent/adapters/playwright";
import { originsArg, requiredTokenArg } from "./journalArgs.js";

export const COMMAND_NAMES = ["open", "act", "findImages", "read", "snapshot", "screenshot", "capture", "tabs", "perform", "assert", "applyFixture", "releaseFixture", "startJournal", "stopJournal", "captureCheckpoint", "clearActEmulation", "requests"] as const;
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
  /** Answered by the registry itself, no session involved (pending checkpoint journals, argument errors). */
  | { kind: "local"; result: CommandResult }
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
  if (command === "open" || command === "applyFixture") return true;
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
  // Checkpoint journals, keyed by an opaque backend token. A journal is PENDING
  // (sessionId null) until a session-creating command opens the browser: startJournal
  // must not bill a Steel session for a run that may never open a page. At most one
  // pending journal per user+chat (and at most MAX_PENDING_JOURNALS overall, oldest
  // evicted: the route is unauthenticated); pending ones expire after idleMs. Single-instance
  // memory like the registry itself: a restart forgets every journal (the controller's
  // own journal dies with the process too, so capture then returns its stale-token error).
  interface JournalRecord {
    key: string;
    sessionId: string | null;
    controllerToken: string | null;
    /** Pending records only: the validated origins to start the journal with. */
    origins?: string[];
    at: number;
  }
  const journals = new Map<string, JournalRecord>();
  const pendingByChat = new Map<string, string>();
  const newJournalToken = () => `cj_${randomBytes(16).toString("base64url")}`;

  const MAX_PENDING_JOURNALS = 1000;

  /** Removes a record by token; its pendingByChat entry goes only if it still points at that token. */
  function removeRecord(token: string) {
    const j = journals.get(token);
    if (!j) return;
    journals.delete(token);
    if (pendingByChat.get(j.key) === token) pendingByChat.delete(j.key);
  }
  function dropPending(key: string) {
    const t = pendingByChat.get(key);
    if (t) removeRecord(t);
  }
  /** The controller keeps one journal per session: a new one retires that session's earlier records. */
  function addLiveRecord(entry: SessionEntry, controllerToken: string, token: string) {
    for (const [t, j] of journals) if (j.sessionId === entry.id && t !== token) journals.delete(t);
    journals.set(token, { key: chatKey(entry.userId, entry.chatId), sessionId: entry.id, controllerToken, at: now() });
  }
  const isExpiredPending = (j: JournalRecord) => j.sessionId === null && now() - j.at > opts.idleMs;
  /** Looks a token up for this user+chat; expired pending journals are dropped on the way. */
  function findJournal(key: string, token: string): JournalRecord | null {
    const j = journals.get(token);
    if (!j || j.key !== key) return null;
    if (isExpiredPending(j)) {
      removeRecord(token);
      return null;
    }
    return j;
  }
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
    for (const [t, j] of journals) if (j.sessionId === entry.id) journals.delete(t);
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

  type ResolveParams = { userId: string; chatId: string; ip: string; handle?: string; command: CommandName; args?: unknown };

  async function resolveBase(p: ResolveParams): Promise<ResolveOutcome> {
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
  }

  /** Starts the journal that was waiting for this chat's first session, before the creating command runs. */
  async function startPendingJournal(entry: SessionEntry) {
    const key = chatKey(entry.userId, entry.chatId);
    const token = pendingByChat.get(key);
    const j = token ? journals.get(token) : undefined;
    if (!token || !j) return;
    pendingByChat.delete(key);
    if (isExpiredPending(j)) {
      removeRecord(token);
      return;
    }
    try {
      const r = await entry.controller.startJournal(j.origins === undefined ? undefined : { origins: j.origins });
      if (r.ok === true && typeof r.token === "string") {
        if (journals.get(token) !== j) {
          // stopped (or swept) while the controller was starting it: undo, register nothing
          await entry.controller.stopJournal({ token: r.token }).catch(() => {});
          return;
        }
        j.sessionId = entry.id;
        j.controllerToken = r.token;
        for (const [t, o] of journals) if (o.sessionId === entry.id && t !== token) journals.delete(t);
        return;
      }
    } catch {
      // fall through: the journal is lost, capture reports the stale token
    }
    if (journals.get(token) === j) removeRecord(token);
  }

  async function runStartJournal(entry: SessionEntry, args: unknown): Promise<CommandResult> {
    const result = await entry.controller.startJournal(args);
    if (result.ok !== true || typeof result.token !== "string") return result;
    const token = newJournalToken();
    addLiveRecord(entry, result.token, token);
    // a chat has at most one journal record that can still start
    dropPending(chatKey(entry.userId, entry.chatId));
    return { ...result, token };
  }

  /** Translates the backend token to the controller's. An unknown one goes through as is, so the controller answers its own stale-token shape. */
  async function runJournalCommand(entry: SessionEntry, command: "stopJournal" | "captureCheckpoint", args: unknown): Promise<CommandResult> {
    const given = (args as { token?: unknown } | undefined)?.token;
    const j = typeof given === "string" ? findJournal(chatKey(entry.userId, entry.chatId), given) : null;
    const mine = j && j.sessionId === entry.id && j.controllerToken !== null ? j : null;
    const result = await entry.controller[command]({ ...(args as object), token: mine ? mine.controllerToken : given });
    // ok:false for a mapped token means the controller no longer has it: the record is stale too
    if (command === "stopJournal" && mine && typeof given === "string" && typeof result.ok === "boolean") journals.delete(given);
    return result;
  }

  return {
    async resolve(p: ResolveParams): Promise<ResolveOutcome> {
      const { userId, chatId, command } = p;
      const key = chatKey(userId, chatId);
      if (command === "startJournal") {
        const o = originsArg(p.args);
        if ("error" in o) return { kind: "local", result: { ok: false, error: o.error } };
        if (!p.handle) {
          // A live session of this chat is used as is; startJournal never creates one.
          const liveId = byChat.get(key);
          const live = liveId ? registry.get(liveId) : undefined;
          if (live && live.expiresAt > now()) {
            live.lastUsedAt = now();
            return { kind: "ok", entry: live, handle: signHandle(opts.secret, userId, chatId, live.id) };
          }
        }
        const out = await resolveBase(p);
        if (out.kind !== "no-session") return out;
        // No live session (none yet, or an expired handle): wait for the command that opens one.
        // The expired-handle signal is that command's to report, not ours.
        dropPending(key);
        const token = newJournalToken();
        while (pendingByChat.size >= MAX_PENDING_JOURNALS) {
          const oldest = pendingByChat.values().next().value;
          if (oldest === undefined) break;
          removeRecord(oldest);
        }
        journals.set(token, { key, sessionId: null, controllerToken: null, origins: o.origins, at: now() });
        pendingByChat.set(key, token);
        return { kind: "local", result: { ok: true, token } };
      }
      if (command === "stopJournal" || command === "captureCheckpoint") {
        const t = requiredTokenArg(p.args);
        if ("error" in t) return { kind: "local", result: { ok: false, error: t.error } };
        const j = findJournal(key, t.token);
        if (j && j.sessionId === null) {
          if (command === "stopJournal") {
            removeRecord(t.token);
            return { kind: "local", result: { ok: true } };
          }
          return { kind: "local", result: { ok: false, error: "no page was opened" } };
        }
        return resolveBase(p);
      }
      const out = await resolveBase(p);
      if (out.kind === "ok" && createsSession(command, p.args)) await startPendingJournal(out.entry);
      return out;
    },

    /** Runs a command; `inFlight` keeps the idle sweeper off the entry meanwhile, and lastUsedAt is stamped after. */
    async run(entry: SessionEntry, command: CommandName, args: unknown): Promise<CommandResult> {
      entry.inFlight++;
      try {
        if (command === "startJournal") return await runStartJournal(entry, args);
        if (command === "stopJournal" || command === "captureCheckpoint") return await runJournalCommand(entry, command, args);
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
      for (const [tok, j] of journals) if (j.sessionId === null && t - j.at > opts.idleMs) removeRecord(tok);
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
