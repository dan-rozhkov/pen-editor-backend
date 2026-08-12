import { tool } from "ai";
import { z } from "zod";
import {
  MEMORY_CIRCUIT_BREAKER,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_WRITE_SAVED,
} from "./prompts.js";
import type { AuditOrigin, MemoryStore } from "./store.js";
import type { MemoryOperation, MemoryTarget } from "./types.js";

/** After this many failed memory calls in ONE request the tool stops the
 * model rather than letting it burn the whole step budget retrying. */
export const MEMORY_MAX_FAILURES = 3;

export interface MemoryToolContext {
  store: MemoryStore;
  userId: string;
  origin: AuditOrigin;
  // Per-request, mutable: a fresh context is built for every turn (and for
  // every review run), so the counter can never leak across requests.
  failures: { count: number };
}

export function createMemoryToolContext(
  store: MemoryStore,
  userId: string,
  origin: AuditOrigin,
): MemoryToolContext {
  return { store, userId, origin, failures: { count: 0 } };
}

// Exported so the background review can build a schema-accurate `memory`
// stub (src/ai/selfimprove/review.ts) when persistent memory is disabled for
// the run but the model might still reach for the tool by name.
export const memoryInputSchema = z.object({
  target: z
    .enum(["memory", "user"])
    .describe(
      "'user' = who the user is (name, role, preferences, style). 'memory' = your own notes (environment, conventions, tool quirks, lessons).",
    ),
  operations: z
    .array(
      z.object({
        action: z.enum(["add", "replace", "remove"]),
        content: z
          .string()
          .optional()
          .describe("The new entry text. Required for 'add' and 'replace'."),
        old_text: z
          .string()
          .optional()
          .describe(
            "A substring that uniquely identifies the entry to change. Required for 'replace' and 'remove'; an ambiguous substring is rejected with the candidates listed.",
          ),
      }),
    )
    .min(1)
    .max(20)
    .describe("All changes for this call, applied atomically and in order."),
});

type MemoryInput = { target: MemoryTarget; operations: MemoryOperation[] };

export function getMemoryTools(ctx: MemoryToolContext): Record<string, unknown> {
  const memory = tool({
    description: MEMORY_TOOL_DESCRIPTION,
    inputSchema: memoryInputSchema,
    execute: async ({ target, operations }: MemoryInput) => {
      if (ctx.failures.count >= MEMORY_MAX_FAILURES) {
        return { ok: false, done: true, error: MEMORY_CIRCUIT_BREAKER };
      }

      let outcome;
      try {
        outcome = await ctx.store.applyOperations({
          userId: ctx.userId,
          target,
          operations,
          origin: ctx.origin,
        });
      } catch (err) {
        ctx.failures.count += 1;
        console.error("[memory] write failed:", err);
        return {
          ok: false,
          error:
            "Memory is temporarily unavailable (storage error). Continue with your reply; the fact can be saved in a later turn.",
        };
      }

      if (outcome.ok) {
        return { ok: true, message: MEMORY_WRITE_SAVED, usage: outcome.usage };
      }

      ctx.failures.count += 1;
      // Only the over-capacity path echoes the entries: that error is the one
      // the model is expected to fix in the same turn, and it cannot
      // consolidate what it cannot see.
      if (outcome.kind === "over_capacity") {
        return {
          ok: false,
          error: outcome.message,
          current_entries: outcome.currentEntries,
          usage: outcome.usage,
        };
      }
      return { ok: false, error: outcome.message, usage: outcome.usage };
    },
  });

  return { memory };
}
