import { usageOf, serializeEntries } from "./apply.js";
import type { MemorySnapshot, MemoryTarget } from "./types.js";

const RULE = "═".repeat(46);

const HEADERS: Record<MemoryTarget, string> = {
  memory: "MEMORY (your personal notes)",
  user: "USER PROFILE (who the user is)",
};

// The usage gauge is deliberately visible to the model: it is the only signal
// it gets that consolidation is due, since there is no eviction policy.
export function renderMemoryBlock(target: MemoryTarget, entries: string[]): string {
  if (entries.length === 0) return "";
  const { current, limit } = usageOf(entries, target);
  const percent = Math.round((current / limit) * 100);
  const gauge = `[${percent}% — ${current.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars]`;
  return [RULE, `${HEADERS[target]} ${gauge}`, RULE, serializeEntries(entries)].join("\n");
}

// User profile first: who the user is frames how to read the agent's own
// notes. Loaded once per request and never re-read mid-turn — the tool's
// success response is terminal precisely because this block is already stale
// the moment a write lands.
export function renderMemorySnapshot(snapshot: MemorySnapshot): string {
  return [
    renderMemoryBlock("user", snapshot.user),
    renderMemoryBlock("memory", snapshot.memory),
  ]
    .filter(Boolean)
    .join("\n\n");
}
