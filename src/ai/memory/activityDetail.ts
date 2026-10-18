/**
 * "What changed" detail for the user-facing memory-activity feed. Built from
 * a WHITELIST of audit-payload keys only (never usage, entryCount, bodyLines,
 * attribution, ...). The feed is per-user, so showing the owner their own
 * content is not a cross-user leak.
 */
export type ActivityDetail =
  | {
      kind: "memory";
      target: "memory" | "user";
      operations: Array<{ action: "add" | "replace" | "remove"; content?: string; oldText?: string }>;
      /** Valid operations dropped by the cap; omitted when 0. */
      moreOperations?: number;
    }
  | {
      kind: "skill";
      action: "create" | "revive" | "patch" | "delete";
      name: string;
      description?: string;
      oldString?: string;
      newString?: string;
      absorbedInto?: string;
    };

const MAX_STRING = 500;
const MAX_OPERATIONS = 10;

function cap(value: string): string {
  // Cut by code points so a surrogate pair is never split.
  const chars = Array.from(value);
  return chars.length > MAX_STRING ? `${chars.slice(0, MAX_STRING).join("")}…` : value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? cap(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MEMORY_ACTIONS = new Set(["add", "replace", "remove"]);
const SKILL_ACTIONS = new Set(["create", "revive", "patch", "delete"]);

export function buildActivityDetail(
  subsystem: "memory" | "skill",
  action: string,
  src: unknown,
): ActivityDetail | undefined {
  if (!isRecord(src)) return undefined;
  if (subsystem === "memory") {
    if (src.target !== "memory" && src.target !== "user") return undefined;
    if (!Array.isArray(src.operations)) return undefined;
    const operations: Array<{ action: "add" | "replace" | "remove"; content?: string; oldText?: string }> = [];
    let moreOperations = 0;
    for (const raw of src.operations) {
      if (!isRecord(raw) || typeof raw.action !== "string" || !MEMORY_ACTIONS.has(raw.action)) continue;
      if (operations.length >= MAX_OPERATIONS) {
        moreOperations++;
        continue;
      }
      const content = str(raw.content);
      const oldText = str(raw.old_text);
      operations.push({
        action: raw.action as "add" | "replace" | "remove",
        ...(content !== undefined ? { content } : {}),
        ...(oldText !== undefined ? { oldText } : {}),
      });
    }
    if (operations.length === 0) return undefined;
    return { kind: "memory", target: src.target, operations, ...(moreOperations > 0 ? { moreOperations } : {}) };
  }
  if (!SKILL_ACTIONS.has(action)) return undefined;
  const name = str(src.name);
  if (!name) return undefined;
  const description = str(src.description);
  const oldString = str(src.oldString);
  const newString = str(src.newString);
  const absorbedInto = str(src.absorbedInto);
  return {
    kind: "skill",
    action: action as "create" | "revive" | "patch" | "delete",
    name,
    ...(description !== undefined ? { description } : {}),
    ...(oldString !== undefined ? { oldString } : {}),
    ...(newString !== undefined ? { newString } : {}),
    ...(absorbedInto !== undefined ? { absorbedInto } : {}),
  };
}
