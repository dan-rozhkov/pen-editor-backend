import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { buildActivityDetail } from "./activityDetail.js";
import { applyMemoryOperations, usageOf } from "./apply.js";
import type {
  AuditActivityEvent,
  AuditEntry,
  AuditOrigin,
  MemoryStore,
  ReviewCounters,
} from "./store.js";
import type { MemorySnapshot, MemoryTarget } from "./types.js";

// File-backed MemoryStore for the local backend (Sideform Light): the same
// semantics as the Postgres store in store.ts, kept in ONE JSON file in the
// app's data dir, so the memory lives on the user's own device. One process
// owns the file; every call goes through an in-process promise queue, which
// plays the role of the row locks / transactions there.
//
// Never log entry contents (they are personal data): only paths and errors.

const AUDIT_KEEP = 500;
const AUDIT_ACTIVITY_LIMIT = 50;
const MAX_STRING = 2000;

const auditRowSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  origin: z.enum(["foreground", "background_review", "curator", "user"]),
  subsystem: z.enum(["memory", "skill", "review"]),
  action: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const userSchema = z.object({
  memory: z.array(z.string()),
  user: z.array(z.string()),
  enabled: z.boolean(),
  turnsSinceMemory: z.number().int().min(0),
  stepsSinceSkill: z.number().int().min(0),
  /** Last memory write (ISO), null when the user has never had a memory row. */
  updatedAt: z.string().nullable(),
});

// Only the envelope is strict. `users` and `audit` are parsed entry by entry
// (parseFileState), so one bad record never costs the rest of the file.
const envelopeSchema = z.object({
  version: z.literal(1),
  users: z.record(z.string(), z.unknown()),
});

type UserState = z.infer<typeof userSchema>;
type AuditRow = z.infer<typeof auditRowSchema>;
interface FileState {
  version: 1;
  nextAuditId: number;
  users: Record<string, UserState>;
  audit: AuditRow[];
}

// null = the file is unusable as a whole (not an object, wrong version, `users`
// missing/not an object). Otherwise invalid users / audit rows are dropped one
// by one (e.g. rows written by a newer backend with an unknown origin) and
// nextAuditId stays above every kept id.
function parseFileState(json: unknown): FileState | null {
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  const top = json as Record<string, unknown>;
  const users: Record<string, UserState> = {};
  let dropped = 0;
  for (const [id, value] of Object.entries(envelope.data.users)) {
    const parsed = userSchema.safeParse(value);
    if (parsed.success && id !== "__proto__") users[id] = parsed.data;
    else dropped++;
  }
  const audit: AuditRow[] = [];
  const rawAudit = Array.isArray(top.audit) ? top.audit : [];
  for (const value of rawAudit) {
    const parsed = auditRowSchema.safeParse(value);
    if (parsed.success) audit.push(parsed.data);
    else dropped++;
  }
  if (!Array.isArray(top.audit) && top.audit !== undefined) dropped++;
  if (dropped > 0) console.warn(`[memory] memory file: skipped ${dropped} invalid record(s)`);
  const stored = typeof top.nextAuditId === "number" && Number.isInteger(top.nextAuditId) ? top.nextAuditId : 1;
  const maxId = audit.reduce((m, r) => Math.max(m, r.id), 0);
  return { version: 1, nextAuditId: Math.max(stored, maxId + 1, 1), users, audit };
}

const emptyState = (): FileState => ({ version: 1, nextAuditId: 1, users: {}, audit: [] });
const emptyUser = (): UserState => ({
  memory: [],
  user: [],
  enabled: true,
  turnsSinceMemory: 0,
  stepsSinceSkill: 0,
  updatedAt: null,
});

// Lookups use hasOwn, so an id like "constructor" is just a key. "__proto__"
// cannot round-trip through JSON.parse/zod as a key, so it is refused (real ids
// are UUIDs, see lib/userId.ts).
function getUser(state: FileState, userId: string): UserState | undefined {
  return Object.hasOwn(state.users, userId) ? state.users[userId] : undefined;
}
function ensureUser(state: FileState, userId: string): UserState {
  const existing = getUser(state, userId);
  if (existing) return existing;
  if (userId === "__proto__") throw new Error("invalid user id");
  const created = emptyUser();
  state.users[userId] = created;
  return created;
}

function pushAudit(state: FileState, entry: AuditEntry): void {
  state.audit.push({
    id: state.nextAuditId++,
    userId: entry.userId,
    origin: entry.origin,
    subsystem: entry.subsystem,
    action: entry.action,
    // JSON round trip: the same normalisation jsonb gives the pg payload.
    payload: JSON.parse(JSON.stringify(entry.payload)) as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  });
  if (state.audit.length > AUDIT_KEEP) state.audit.splice(0, state.audit.length - AUDIT_KEEP);
}

const left = (value: unknown): string | undefined =>
  typeof value === "string" ? value.slice(0, MAX_STRING) : undefined;

export function createFileMemoryStore(filePath: string): MemoryStore {
  let state: FileState | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  // Serializes every call. A rejected call must not poison the queue.
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    tail = result.catch(() => undefined);
    return result;
  }

  async function load(): Promise<FileState> {
    if (state) return state;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        state = emptyState();
        return state;
      }
      throw err;
    }
    let parsed: FileState | null = null;
    try {
      parsed = parseFileState(JSON.parse(raw));
    } catch {
      // Unparsable: handled below.
    }
    if (!parsed) {
      const aside = `${filePath}.corrupt-${Date.now()}`;
      try {
        await rename(filePath, aside);
        console.warn(`[memory] memory file is unreadable; moved it to ${aside} and starting empty`);
      } catch {
        console.warn(`[memory] memory file is unreadable and could not be moved aside (${filePath}); starting empty`);
      }
      state = emptyState();
      return state;
    }
    state = parsed;
    return state;
  }

  async function persist(next: FileState): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const fh = await open(tmp, "w", 0o600);
      try {
        await fh.writeFile(JSON.stringify(next));
        await fh.chmod(0o600);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, filePath);
      // Best effort: make the rename itself durable.
      try {
        const dh = await open(dirname(filePath), "r");
        try {
          await dh.sync();
        } finally {
          await dh.close();
        }
      } catch {
        // Not supported everywhere (e.g. Windows): the file is already in place.
      }
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  // Read-modify-write on a copy: when the write fails, the cached state is
  // still the last one that reached the disk.
  function mutate<T>(fn: (draft: FileState) => T): Promise<T> {
    return run(async () => {
      const draft = structuredClone(await load());
      const result = fn(draft);
      await persist(draft);
      state = draft;
      return result;
    });
  }

  function read<T>(fn: (current: FileState) => T): Promise<T> {
    return run(async () => fn(await load()));
  }

  return {
    loadSnapshot: (userId) =>
      read((s): MemorySnapshot => {
        const u = getUser(s, userId);
        return { memory: [...(u?.memory ?? [])], user: [...(u?.user ?? [])] };
      }),

    applyOperations: ({ userId, target, operations, origin, attribution, requireEnabled, skipNoopAudit }) =>
      run(async () => {
        const draft = structuredClone(await load());
        if (requireEnabled && getUser(draft, userId)?.enabled === false) {
          return {
            ok: false as const,
            kind: "disabled" as const,
            message: "Memory is turned off in Settings > Memory.",
            usage: usageOf([], target),
            currentEntries: [],
          };
        }
        const user = ensureUser(draft, userId);
        const outcome = applyMemoryOperations(user[target], operations, target);
        // A failed batch changes nothing and writes no audit row (pg ROLLBACK).
        if (!outcome.ok) return outcome;
        if (skipNoopAudit && JSON.stringify(outcome.entries) === JSON.stringify(user[target])) {
          return outcome;
        }
        user[target] = outcome.entries;
        user.updatedAt = new Date().toISOString();
        pushAudit(draft, {
          userId,
          origin,
          subsystem: "memory",
          action: operations.map((op) => op.action).join("+"),
          payload: {
            ...attribution,
            target,
            operations,
            entryCount: outcome.entries.length,
            usage: outcome.usage,
          },
        });
        await persist(draft);
        state = draft;
        return outcome;
      }),

    bumpCounters: ({ userId, turns, steps, memoryInterval, skillInterval }) =>
      mutate((draft): ReviewCounters => {
        const user = ensureUser(draft, userId);
        user.turnsSinceMemory += turns;
        user.stepsSinceSkill += steps;
        const { turnsSinceMemory, stepsSinceSkill } = user;
        const memoryReviewDue = turnsSinceMemory >= memoryInterval;
        const result: ReviewCounters = { turnsSinceMemory, stepsSinceSkill, memoryReviewDue };
        if (skillInterval !== undefined) result.skillReviewDue = stepsSinceSkill >= skillInterval;
        // Independent resets, after the values to report were taken.
        if (memoryReviewDue) user.turnsSinceMemory = 0;
        if (result.skillReviewDue) user.stepsSinceSkill = 0;
        return result;
      }),

    writeAudit: (entry) => mutate((draft) => pushAudit(draft, entry)),

    listAuditActivity: ({ userId, sinceId, limit = AUDIT_ACTIVITY_LIMIT }) =>
      read((s) => {
        // `review` rows are observations, not writes: out of the feed and out
        // of the anchor id (see the pg store).
        const rows = s.audit.filter((r) => r.userId === userId && r.subsystem !== "review");
        const latestId = rows.length > 0 ? Math.max(...rows.map((r) => r.id)) : null;
        if (sinceId === undefined) return { events: [], latestId };
        const events = rows
          .filter((r) => r.id > sinceId)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((row): AuditActivityEvent => {
            const subsystem = row.subsystem as "memory" | "skill";
            const p = row.payload;
            const detail = buildActivityDetail(subsystem, row.action, {
              target: p.target,
              operations: p.operations,
              name: left(p.name),
              description: left(p.description),
              oldString: left(p.oldString),
              newString: left(p.newString),
              absorbedInto: left(p.absorbedInto),
            });
            return {
              id: row.id,
              subsystem,
              action: row.action,
              origin: row.origin,
              createdAt: row.createdAt,
              ...(typeof p.chatId === "string" && p.chatId ? { chatId: p.chatId } : {}),
              ...(typeof p.messageId === "string" && p.messageId ? { messageId: p.messageId } : {}),
              ...(detail ? { detail } : {}),
            };
          });
        return { events, latestId };
      }),

    listUsers: (limit) =>
      read((s) =>
        Object.entries(s.users)
          .filter((entry): entry is [string, UserState & { updatedAt: string }] => entry[1].updatedAt !== null)
          .sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? 1 : a[1].updatedAt > b[1].updatedAt ? -1 : 0))
          .slice(0, limit)
          .map(([userId, u]) => ({ userId, updatedAt: u.updatedAt })),
      ),

    clearUser: (userId, origin: AuditOrigin) =>
      mutate((draft) => {
        const user = getUser(draft, userId);
        const counts = { memory: user?.memory.length ?? 0, user: user?.user.length ?? 0 };
        if (user) {
          user.memory = [];
          user.user = [];
          if (user.updatedAt !== null) user.updatedAt = new Date().toISOString();
        }
        pushAudit(draft, { userId, origin, subsystem: "memory", action: "clear", payload: { counts } });
        return counts;
      }),

    removeEntry: (userId, target: MemoryTarget, text, origin) =>
      run(async () => {
        const draft = structuredClone(await load());
        const user = getUser(draft, userId);
        const index = user ? user[target].indexOf(text) : -1;
        if (!user || index === -1) return false;
        user[target] = user[target].filter((_, i) => i !== index);
        user.updatedAt = new Date().toISOString();
        pushAudit(draft, {
          userId,
          origin,
          subsystem: "memory",
          action: "remove_entry",
          payload: { target, entryCount: user[target].length },
        });
        await persist(draft);
        state = draft;
        return true;
      }),

    getMemoryEnabled: (userId) => read((s) => getUser(s, userId)?.enabled !== false),

    setMemoryEnabled: (userId, enabled) =>
      mutate((draft) => {
        ensureUser(draft, userId).enabled = enabled;
      }),

    // Waits for in-flight writes; there is no handle to release.
    close: () => run(async () => undefined),
  };
}
