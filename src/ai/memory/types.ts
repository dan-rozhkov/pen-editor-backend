/** Which of the two always-in-prompt stores an operation targets. */
export type MemoryTarget = "memory" | "user";

/** Entries are stored as a jsonb string[], but every budget check is made on
 * this joined form — the separator's characters count against the limit. */
export const MEMORY_SEPARATOR = "\n§\n";

/** Characters, not tokens. Ported from Hermes verbatim: the char budget IS
 * the selection mechanism — there is no embedding retrieval and no TTL. */
export const MEMORY_LIMITS: Record<MemoryTarget, number> = {
  memory: 2200,
  user: 1375,
};

export interface MemoryUsage {
  current: number;
  limit: number;
}

export interface MemorySnapshot {
  memory: string[];
  user: string[];
}

export interface MemoryOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  old_text?: string;
}

export const EMPTY_MEMORY_SNAPSHOT: MemorySnapshot = { memory: [], user: [] };
