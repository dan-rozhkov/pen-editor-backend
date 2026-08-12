import {
  MEMORY_LIMITS,
  MEMORY_SEPARATOR,
  type MemoryOperation,
  type MemoryTarget,
  type MemoryUsage,
} from "./types.js";

export function serializeEntries(entries: string[]): string {
  return entries.join(MEMORY_SEPARATOR);
}

export function usageOf(entries: string[], target: MemoryTarget): MemoryUsage {
  return { current: serializeEntries(entries).length, limit: MEMORY_LIMITS[target] };
}

export type MemoryApplyOutcome =
  | { ok: true; entries: string[]; usage: MemoryUsage }
  | {
      ok: false;
      kind: "over_capacity" | "no_match" | "ambiguous" | "invalid";
      message: string;
      usage: MemoryUsage;
      currentEntries: string[];
    };

function findUnique(
  entries: string[],
  oldText: string,
): { index: number } | { matches: number[] } {
  const matches = entries
    .map((entry, index) => (entry.includes(oldText) ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length === 1) return { index: matches[0] };
  return { matches };
}

// Pure: takes the entries as they were actually read under FOR UPDATE and
// returns either the full replacement array or a typed failure. The whole
// batch is atomic — a single failing operation leaves `entries` untouched —
// and the budget is checked once, on the FINAL state, so a batch may pass
// through an intermediate state that is over the limit (consolidate + add in
// one call is the documented way out of a full store).
export function applyMemoryOperations(
  entries: string[],
  operations: MemoryOperation[],
  target: MemoryTarget,
): MemoryApplyOutcome {
  const before = [...entries];
  const fail = (
    kind: "over_capacity" | "no_match" | "ambiguous" | "invalid",
    message: string,
  ): MemoryApplyOutcome => ({
    ok: false,
    kind,
    message,
    usage: usageOf(before, target),
    currentEntries: before,
  });

  let next = [...entries];
  let addedChars = 0;

  for (const op of operations) {
    if (op.action === "add") {
      const content = op.content?.trim();
      if (!content) return fail("invalid", "An 'add' operation requires non-empty 'content'.");
      // Idempotent: an exact duplicate of an entry already present (after
      // trim) is a silent no-op rather than a second copy. This is what
      // makes it safe for the background review to re-propose a fact the
      // foreground turn already saved this same turn — it re-reads a fresh
      // snapshot (see selfimprove/review.ts) but can still land on the same
      // wording. A silent success (not an error) is the right response: the
      // model asked for the entry to exist, and it does — surfacing this as
      // a failure would just prompt a pointless retry loop, and it must not
      // break the "whole batch applies atomically" contract other ops in
      // the same call rely on.
      if (next.includes(content)) continue;
      next = [...next, content];
      addedChars += content.length;
      continue;
    }

    const oldText = op.old_text?.trim();
    if (!oldText) {
      return fail(
        "invalid",
        `A '${op.action}' operation requires 'old_text' — a substring that uniquely identifies the entry.`,
      );
    }
    const found = findUnique(next, oldText);
    if ("matches" in found) {
      if (found.matches.length === 0) {
        return fail(
          "no_match",
          `No memory entry contains "${oldText}". Nothing was changed.`,
        );
      }
      const candidates = found.matches.map((i) => `- ${next[i]}`).join("\n");
      return fail(
        "ambiguous",
        `"${oldText}" matches ${found.matches.length} entries; use a longer, unique substring. Candidates:\n${candidates}`,
      );
    }

    if (op.action === "remove") {
      next = next.filter((_, i) => i !== found.index);
      continue;
    }

    const content = op.content?.trim();
    if (!content) {
      return fail("invalid", "A 'replace' operation requires non-empty 'content'.");
    }
    // Unlike `add`, the source entry at `found.index` already exists and
    // must go SOMEWHERE — a bare duplicate-guard (skip and leave both) would
    // silently leave two byte-identical entries behind, and `findUnique`
    // then reports "ambiguous" for both forever with no old_text substring
    // able to tell them apart (memory has no TTL/eviction, so this is a
    // permanent budget leak, not a one-turn glitch). Two cases:
    //   - content matches some OTHER entry verbatim: the desired end state
    //     ("this fact now reads as `content`") is already satisfied by that
    //     other entry, so replacing-into-a-duplicate collapses to deleting
    //     the now-redundant source entry, not writing a second copy.
    //   - content equals the entry's OWN current text: no actual change was
    //     requested, so this is a plain no-op — the entry stays, since
    //     dropping it would remove something the model never asked to
    //     remove.
    const duplicateElsewhere = next.some(
      (entry, i) => i !== found.index && entry === content,
    );
    if (duplicateElsewhere) {
      next = next.filter((_, i) => i !== found.index);
    } else if (content !== next[found.index]) {
      next = next.map((entry, i) => (i === found.index ? content : entry));
      addedChars += content.length;
    }
  }

  const finalUsage = usageOf(next, target);
  if (finalUsage.current > finalUsage.limit) {
    const before_ = usageOf(before, target);
    return {
      ok: false,
      kind: "over_capacity",
      message: `Memory at ${before_.current}/${before_.limit} chars. Adding this entry (${addedChars} chars) would exceed the limit. Consolidate now: use 'replace' to merge overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), then retry this add — all in this turn.`,
      usage: before_,
      currentEntries: before,
    };
  }

  return { ok: true, entries: next, usage: finalUsage };
}
