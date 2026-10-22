import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../../config.js";
import { createSystemOne, type SystemOneClient } from "../../services/systemone.js";
import {
  MEMORY_CIRCUIT_BREAKER,
  MEMORY_FILTER_ALL_SKIPPED,
  MEMORY_FILTER_SKIPPED,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_WRITE_SAVED,
} from "./prompts.js";
import type { AuditOrigin, MemoryStore } from "./store.js";
import type { ReviewAttribution } from "../selfimprove/attribution.js";
import type { MemoryOperation, MemoryTarget } from "./types.js";
import { runMemoryFilter, type MemoryFilterResult, type MemoryFilterVerdict } from "./filter.js";
import { MEMORY_SNAPSHOT_TIMEOUT_MS, withTimeout } from "../withTimeout.js";

/** After this many failed memory calls in ONE request the tool stops the
 * model rather than letting it burn the whole step budget retrying. */
export const MEMORY_MAX_FAILURES = 3;

/** System One write filter wiring (src/ai/memory/filter.ts). Absent = off. */
export interface MemoryFilterContext {
  mode: Config["MEMORY_FILTER_MODE"];
  /** null = TYPESAFE_API_KEY unset: logged as `no-client`, write as usual. */
  client: SystemOneClient | null;
  config: Pick<
    Config,
    | "MEMORY_FILTER_DURABLE_MIN"
    | "MEMORY_FILTER_DUPLICATE_MIN"
    | "MEMORY_FILTER_TIMEOUT_MS"
    | "MEMORY_FILTER_SHADOW_TIMEOUT_MS"
  >;
}

export interface MemoryToolContext {
  store: MemoryStore;
  userId: string;
  origin: AuditOrigin;
  // Per-request, mutable: a fresh context is built for every turn (and for
  // every review run), so the counter can never leak across requests.
  failures: { count: number };
  /** Stamped into each audit payload (background review). */
  attribution?: ReviewAttribution;
  filter?: MemoryFilterContext;
}

export function createMemoryToolContext(
  store: MemoryStore,
  userId: string,
  origin: AuditOrigin,
  attribution?: ReviewAttribution,
  filter?: MemoryFilterContext,
): MemoryToolContext {
  return {
    store,
    userId,
    origin,
    failures: { count: 0 },
    ...(attribution ? { attribution } : {}),
    ...(filter ? { filter } : {}),
  };
}

const round2 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);

/** An add a later op in the same batch points at (via old_text) must stay, or
 * that op fails with no_match and the atomic batch dies. Trimmed like apply.ts. */
function isReferencedByLater(operations: MemoryOperation[], index: number): boolean {
  const content = operations[index]?.content ?? "";
  return operations.slice(index + 1).some((op) => {
    const oldText = op.old_text?.trim();
    return !!oldText && content.includes(oldText);
  });
}

/** The one place verdicts become a drop set (index -> reason). Enforce drops
 * exactly this; both modes log its size as `wouldDrop`. */
function planDrops(
  operations: MemoryOperation[],
  verdicts: MemoryFilterVerdict[],
): Map<number, string> {
  const drops = new Map<number, string>();
  for (const v of verdicts) {
    if (v.drop && !isReferencedByLater(operations, v.index)) drops.set(v.index, v.drop);
  }
  return drops;
}

// One JSON line per filtered call. NEVER the entry contents: they are user
// data (PII); the verdicts are positional numbers only.
function logFilter(
  ctx: MemoryToolContext,
  mode: string,
  target: MemoryTarget,
  operations: MemoryOperation[],
  result: Pick<MemoryFilterResult, "outcome" | "verdicts" | "asked">,
  dropped: number,
): void {
  const wouldDrop = planDrops(operations, result.verdicts).size;
  console.log(
    `[memoryFilter] ${JSON.stringify({
      mode,
      origin: ctx.origin,
      target,
      adds: operations.filter((op) => op.action === "add").length,
      asked: result.asked,
      wouldDrop,
      dropped,
      outcome: result.outcome,
      verdicts: result.verdicts.map((v) => ({
        durable: round2(v.durable),
        duplicate: round2(v.duplicate),
        drop: v.drop,
      })),
    })}`,
  );
}

/** The stored entries of `target`, bounded by a timeout; null on any failure
 * (the caller logs `failed` and writes unfiltered). */
async function readExisting(
  ctx: MemoryToolContext,
  target: MemoryTarget,
): Promise<string[] | null> {
  try {
    const snapshot = await withTimeout(
      ctx.store.loadSnapshot(ctx.userId),
      MEMORY_SNAPSHOT_TIMEOUT_MS,
      "[memoryFilter] snapshot read",
    );
    return snapshot[target];
  } catch (err) {
    console.warn("[memoryFilter] snapshot read failed, writing unfiltered:", err);
    return null;
  }
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
    execute: async ({ target, operations }: MemoryInput, options?: { abortSignal?: AbortSignal }) => {
      if (ctx.failures.count >= MEMORY_MAX_FAILURES) {
        return { ok: false, done: true, error: MEMORY_CIRCUIT_BREAKER };
      }

      const filter = ctx.filter;
      let skipped: { content: string; reason: string }[] = [];
      let toWrite = operations;

      if (filter) {
        if (!filter.client) {
          logFilter(ctx, filter.mode, target, operations,
            { outcome: "no-client", verdicts: [], asked: 0 }, 0);
        } else {
          // Shadow reads BEFORE the write too, so it judges the pre-write
          // state; only the vendor call is detached.
          const existing = await readExisting(ctx, target);
          if (!existing) {
            logFilter(ctx, filter.mode, target, operations,
              { outcome: "failed", verdicts: [], asked: 0 }, 0);
          } else if (filter.mode === "shadow") {
            // No abortSignal here: shadow measures, and an aborted request
            // must not censor the measurement.
            void runMemoryFilter(filter.client, {
              config: filter.config,
              target,
              operations,
              existing,
              timeoutMs: filter.config.MEMORY_FILTER_SHADOW_TIMEOUT_MS,
            })
              .then((result) => logFilter(ctx, "shadow", target, operations, result, 0))
              .catch((err) => console.warn("[memoryFilter] shadow failed unexpectedly:", err));
          } else {
            const result = await runMemoryFilter(filter.client, {
              config: filter.config,
              target,
              operations,
              existing,
              timeoutMs: filter.config.MEMORY_FILTER_TIMEOUT_MS,
              ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
            });
            const dropIdx = planDrops(operations, result.verdicts);
            skipped = [...dropIdx].map(([i, reason]) => ({
              content: operations[i]?.content ?? "",
              reason,
            }));
            toWrite = operations.filter((_, i) => !dropIdx.has(i));
            logFilter(ctx, "enforce", target, operations, result, dropIdx.size);
          }
        }
      }

      if (toWrite.length === 0) {
        // Everything was dropped: count it, so a model that keeps retrying
        // the same rejected entries trips the circuit breaker.
        ctx.failures.count += 1;
        return { ok: true, saved: false, message: MEMORY_FILTER_ALL_SKIPPED, skipped };
      }

      let outcome;
      try {
        outcome = await ctx.store.applyOperations({
          userId: ctx.userId,
          target,
          operations: toWrite,
          origin: ctx.origin,
          ...(ctx.attribution ? { attribution: ctx.attribution } : {}),
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
        if (skipped.length > 0) {
          return {
            ok: true,
            message: `${MEMORY_WRITE_SAVED} ${MEMORY_FILTER_SKIPPED}`,
            usage: outcome.usage,
            skipped,
          };
        }
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

/** The filter wiring for a memory tool context, or undefined when the mode is
 * off. `client` undefined = build one from config (null without
 * TYPESAFE_API_KEY); an injected client (tests) wins, null included. */
export function memoryFilterContext(
  config: Config,
  client: SystemOneClient | null | undefined,
): MemoryFilterContext | undefined {
  if (config.MEMORY_FILTER_MODE === "off") return undefined;
  return {
    mode: config.MEMORY_FILTER_MODE,
    client: client !== undefined ? client : createSystemOne(config),
    config,
  };
}
