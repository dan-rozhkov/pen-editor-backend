import { usageOf } from "./apply.js";
import type { AuditOrigin, MemoryStore } from "./store.js";
import type { MemoryTarget } from "./types.js";

// The repair path for persistent memory (Phase 1 spec, "no way to fix
// memory" gap): entries land in the SYSTEM PROMPT and live forever with no
// TTL, and until this existed there was no route/script/UI to read or delete
// one. Same pure-function-over-injected-deps shape as showcase/pin.ts and
// showcase/delete.ts — flag parsing and the store call are each testable
// without Postgres, and the CLI entrypoint (curatorRun.ts) is a thin wire-up.
//
// Every delete here is a curator action on someone else's memory, so every
// one of them writes an audit row with origin "curator" — the spec's
// audit-from-day-one requirement is not optional for this path, unlike a
// dry run which by definition changes nothing and audits nothing.
const CURATOR_ORIGIN: AuditOrigin = "curator";

export interface CuratorDeps {
  store: Pick<MemoryStore, "loadSnapshot" | "applyOperations" | "clearUser" | "listUsers">;
  log(message: string): void;
}

export type CuratorAction =
  | { kind: "list-users"; limit: number }
  | { kind: "show"; userId: string }
  | { kind: "remove"; userId: string; target: MemoryTarget; entry: string; dryRun: boolean }
  | { kind: "clear"; userId: string; dryRun: boolean };

export interface CuratorArgs {
  user?: string;
  target?: string;
  entry?: string;
  clear: boolean;
  listUsers: boolean;
  limit?: number;
  dryRun: boolean;
}

const DEFAULT_LIST_USERS_LIMIT = 20;

/** Turns raw argv flags into exactly one action, or throws on an ambiguous or
 * malformed combination — validated before opening any DB connection, same
 * reasoning as `resolvePinAction`/`resolveDeleteAction`: a typo must fail
 * loudly instead of half-acting on the wrong user. */
export function resolveCuratorAction(args: CuratorArgs): CuratorAction {
  const modesRequested = [args.entry !== undefined, args.clear, args.listUsers].filter(
    Boolean,
  ).length;
  if (modesRequested > 1) {
    throw new Error("--entry, --clear and --list-users are mutually exclusive");
  }

  if (args.listUsers) {
    if (args.user !== undefined) {
      throw new Error("--list-users does not take --user (it discovers user ids)");
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
      throw new Error("--limit must be a positive integer");
    }
    return { kind: "list-users", limit: args.limit ?? DEFAULT_LIST_USERS_LIMIT };
  }

  if (!args.user) {
    throw new Error("--user <id> is required (use --list-users to find one)");
  }

  if (args.entry !== undefined) {
    if (!args.entry) throw new Error("--entry requires a substring identifying the entry");
    if (args.target !== "memory" && args.target !== "user") {
      throw new Error('--target must be "memory" or "user"');
    }
    return {
      kind: "remove",
      userId: args.user,
      target: args.target,
      entry: args.entry,
      dryRun: args.dryRun,
    };
  }

  if (args.clear) {
    return { kind: "clear", userId: args.user, dryRun: args.dryRun };
  }

  // No mutation flag given: show what's stored, same "default is safe" shape
  // as `showcase:pin` defaulting to `--list`.
  return { kind: "show", userId: args.user };
}

function renderEntries(target: MemoryTarget, entries: string[]): string {
  if (entries.length === 0) return `  ${target}: (empty)`;
  const { current, limit } = usageOf(entries, target);
  const lines = entries.map((entry, i) => `    [${i}] ${entry}`).join("\n");
  return `  ${target} (${current}/${limit} chars):\n${lines}`;
}

export async function runCuratorAction(deps: CuratorDeps, action: CuratorAction): Promise<void> {
  switch (action.kind) {
    case "list-users": {
      const users = await deps.store.listUsers(action.limit);
      if (users.length === 0) {
        deps.log("[memory:curate] no users have stored memory");
        return;
      }
      for (const user of users) {
        deps.log(`${user.userId}  (updated ${user.updatedAt})`);
      }
      return;
    }

    case "show": {
      const snapshot = await deps.store.loadSnapshot(action.userId);
      deps.log(`[memory:curate] ${action.userId}`);
      deps.log(renderEntries("user", snapshot.user));
      deps.log(renderEntries("memory", snapshot.memory));
      return;
    }

    case "remove": {
      if (action.dryRun) {
        const snapshot = await deps.store.loadSnapshot(action.userId);
        const entries = snapshot[action.target];
        const matches = entries.filter((e) => e.includes(action.entry));
        if (matches.length === 0) {
          throw new Error(`no ${action.target} entry contains "${action.entry}"`);
        }
        if (matches.length > 1) {
          throw new Error(
            `"${action.entry}" matches ${matches.length} entries; use a longer, unique substring`,
          );
        }
        deps.log(`[memory:curate] --dry-run: would remove from ${action.target}:`);
        deps.log(`  ${matches[0]}`);
        return;
      }

      const outcome = await deps.store.applyOperations({
        userId: action.userId,
        target: action.target,
        operations: [{ action: "remove", old_text: action.entry }],
        origin: CURATOR_ORIGIN,
      });
      if (!outcome.ok) {
        throw new Error(outcome.message);
      }
      deps.log(
        `[memory:curate] removed 1 entry from ${action.userId}'s ${action.target} ` +
          `(${outcome.entries.length} remaining)`,
      );
      return;
    }

    case "clear": {
      if (action.dryRun) {
        const snapshot = await deps.store.loadSnapshot(action.userId);
        deps.log(
          `[memory:curate] --dry-run: would clear ${snapshot.user.length} user + ` +
            `${snapshot.memory.length} memory entries for ${action.userId}`,
        );
        return;
      }

      const counts = await deps.store.clearUser(action.userId, CURATOR_ORIGIN);
      deps.log(
        `[memory:curate] cleared ${counts.user} user + ${counts.memory} memory entries ` +
          `for ${action.userId}`,
      );
      return;
    }
  }
}
