import type { Config } from "../../config.js";
import type { SystemOneAnswer, SystemOneClient, SystemOneQuestion } from "../../services/systemone.js";
import { scrubPii } from "../../analysis/pii.js";
import type { MemoryOperation, MemoryTarget } from "./types.js";

// Write filter for persistent memory, on System One (Jev / Luna). See
// docs/specs/2026-10-23-memory-write-filter-design.md. House style mirrors
// src/ai/imageRelevance.ts and src/ai/tasteCheck.ts: one `evaluate` call,
// absolute questions (Noul, not Choice), everything sent to the vendor passes
// through scrubPii and a length cap, a timeout via AbortSignal, and
// fail-open on every error. This module NEVER throws and never decides to
// drop anything on an answer it did not get.
//
// Two independent Noul questions per new entry:
//   durable_<i>   will this stay useful in a future, unrelated conversation?
//   duplicate_<i> does an existing entry of the same target already say it?
// Memory has no TTL, so a one-off task detail saved today is injected into
// every prompt for good; the only repair is the CLI curator.

/** At most this many `add` operations are judged per call; the rest are kept
 * unasked (fail-open). Bounds the question count and the vendor bill. */
export const MAX_FILTERED_ADDS = 8;

/** Per-entry cap after scrubPii, for new and existing entries alike. */
export const MAX_ENTRY_CHARS = 600;

export const DEFAULT_MEMORY_FILTER_TIMEOUT_MS = 2_000;

export type MemoryFilterDrop = "not_durable" | "duplicate";

export interface MemoryFilterVerdict {
  /** Index of the add in the `operations` array of the tool call. */
  index: number;
  /** Absent = the vendor gave no answer: unknown, never dropped on it. */
  durable?: number;
  duplicate?: number;
  drop: MemoryFilterDrop | null;
}

export type MemoryFilterOutcome =
  /** The vendor answered (possibly only some questions). */
  | "asked"
  /** No add with content, so there was nothing to ask. */
  | "nothing-to-ask"
  /** No System One client (TYPESAFE_API_KEY unset). */
  | "no-client"
  /** Asked and failed: timeout, transport, 4xx/5xx. Nothing is dropped. */
  | "failed";

export interface MemoryFilterResult {
  outcome: MemoryFilterOutcome;
  verdicts: MemoryFilterVerdict[];
  /** How many adds were put to the vendor. */
  asked: number;
}

export interface MemoryFilterOptions {
  config: Pick<Config, "MEMORY_FILTER_DURABLE_MIN" | "MEMORY_FILTER_DUPLICATE_MIN">;
  target: MemoryTarget;
  operations: MemoryOperation[];
  /** The entries of `target` as stored right now. */
  existing: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

function clip(text: string): string {
  const scrubbed = scrubPii(text);
  return scrubbed.length > MAX_ENTRY_CHARS ? scrubbed.slice(0, MAX_ENTRY_CHARS) : scrubbed;
}

const DURABLE_INSTRUCTIONS: Record<MemoryTarget, string> = {
  user:
    "is it a durable fact about who the user is (identity, role, preferences, working style) " +
    "that will still be true and useful in a future, unrelated conversation, rather than a " +
    "one-off detail of the task being worked on right now?",
  memory:
    "is it a durable note about the environment, conventions, tool quirks or lessons learned " +
    "that will still be useful in a future, unrelated conversation, rather than a one-off " +
    "detail of the task being worked on right now?",
};

export function durableQuestion(target: MemoryTarget, i: number): string {
  return (
    `Look at the entry in \`new_entries[${i}].text\` (it may be written in any language). ` +
    `State \`target\` is "${target}". Judged on its own, ${DURABLE_INSTRUCTIONS[target]} ` +
    "Answer no for task progress, a completed-work log, a temporary to-do, or something that " +
    "will be stale within a week."
  );
}

export function duplicateQuestion(i: number): string {
  return (
    `Look at the entry in \`new_entries[${i}].text\` and the list in \`existing_entries\` ` +
    "(entries may be written in any language). Does any single existing entry already state " +
    "the same fact as the new entry, with the same meaning, even if the words differ? " +
    "Answer no if the new entry adds anything the existing entries do not already say."
  );
}

function noul(answer: SystemOneAnswer | undefined): number | undefined {
  return answer && answer.type === "noul" ? answer.noul : undefined;
}

/**
 * Judges the `add` operations of one memory call. Pure apart from the one
 * `evaluate`; never throws.
 */
export async function runMemoryFilter(
  client: SystemOneClient | null | undefined,
  opts: MemoryFilterOptions,
): Promise<MemoryFilterResult> {
  const { config, target, operations } = opts;
  if (!client) return { outcome: "no-client", verdicts: [], asked: 0 };

  const adds: { index: number; text: string }[] = [];
  for (let index = 0; index < operations.length; index++) {
    const op = operations[index];
    if (op?.action !== "add" || typeof op.content !== "string" || op.content.trim() === "") continue;
    adds.push({ index, text: op.content });
    if (adds.length >= MAX_FILTERED_ADDS) break;
  }
  if (adds.length === 0) return { outcome: "nothing-to-ask", verdicts: [], asked: 0 };

  // An exact repeat is already a no-op in apply.ts, and a shadow-mode
  // snapshot read can race with the write and see the new entry itself —
  // either way it must not count as "already stored".
  const newTexts = new Set(adds.map((a) => a.text.trim()));
  // An entry that a remove/replace of the SAME batch rewrites is going away,
  // so it cannot count as "already stored": otherwise consolidating
  // [remove 'prefers dark UI', add 'prefers dark UI and dark themes'] would
  // drop the add as a duplicate and lose the fact.
  const rewritten = operations
    .filter((op) => op.action === "remove" || op.action === "replace")
    .map((op) => op.old_text?.trim())
    .filter((t): t is string => !!t);
  const existing = opts.existing.filter(
    (e) => !newTexts.has(e.trim()) && !rewritten.some((t) => e.includes(t)),
  );

  const state = {
    target,
    existing_entries: existing.map(clip),
    new_entries: adds.map((a) => ({ text: clip(a.text) })),
  };
  const questions: Record<string, SystemOneQuestion> = {};
  adds.forEach((_, i) => {
    questions[`durable_${i}`] = { type: "noul", instructions: durableQuestion(target, i) };
    if (existing.length > 0) {
      questions[`duplicate_${i}`] = { type: "noul", instructions: duplicateQuestion(i) };
    }
  });

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_MEMORY_FILTER_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

  try {
    const { answers } = await client.evaluate({ state, questions, signal });
    const verdicts = adds.map((add, i): MemoryFilterVerdict => {
      const durable = noul(answers[`durable_${i}`]);
      const duplicate = noul(answers[`duplicate_${i}`]);
      // A missing answer is "unknown": it can never produce a drop.
      const drop: MemoryFilterDrop | null =
        durable !== undefined && durable < config.MEMORY_FILTER_DURABLE_MIN
          ? "not_durable"
          : duplicate !== undefined && duplicate >= config.MEMORY_FILTER_DUPLICATE_MIN
            ? "duplicate"
            : null;
      return {
        index: add.index,
        ...(durable !== undefined ? { durable } : {}),
        ...(duplicate !== undefined ? { duplicate } : {}),
        drop,
      };
    });
    return { outcome: "asked", verdicts, asked: adds.length };
  } catch (err) {
    console.warn("[memoryFilter] evaluate failed, keeping every entry:", err);
    return { outcome: "failed", verdicts: [], asked: 0 };
  }
}
