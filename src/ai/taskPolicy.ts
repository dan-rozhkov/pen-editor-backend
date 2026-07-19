// Structural signal for whether the current turn should be embed-only
// (prototype/slides skill routing), used by chat.ts to swap in the
// embed-only batch_design variant. CONSERVATIVE by design: only two strong
// signals are trusted — a slash command detected on the current message, or
// a `load_skill` tool call/result for "prototype"/"slides" anywhere in the
// message history. No fuzzy text heuristics (e.g. scanning user prose for
// the word "prototype") — those are exactly the kind of drift this guard
// exists to catch, not repeat.
export type TaskPolicy = "prototype" | "slides" | "native";

const POLICY_SKILL_NAMES = new Set(["prototype", "slides"]);

function isPolicySkillName(value: unknown): value is "prototype" | "slides" {
  return typeof value === "string" && POLICY_SKILL_NAMES.has(value);
}

// A `load_skill` tool part/invocation can show up in several AI SDK v6
// shapes depending on how the message was serialized:
//   - dynamic-tool part: { type: "dynamic-tool", toolName: "load_skill", input: { name } }
//   - typed tool part:   { type: "tool-load_skill", input: { name } }
//   - legacy tool-invocation wrapper: { type: "tool-invocation", toolInvocation: { toolName, args | input } }
// Returns the skill name argument if `part` is a load_skill call in any of
// these shapes, else null.
function loadSkillNameFromPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const p = part as Record<string, unknown>;

  const readNameFromInput = (input: unknown): string | undefined => {
    if (!input || typeof input !== "object") return undefined;
    const name = (input as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  };

  if (p.type === "dynamic-tool" && p.toolName === "load_skill") {
    return readNameFromInput(p.input);
  }
  if (typeof p.type === "string" && p.type === "tool-load_skill") {
    return readNameFromInput(p.input);
  }
  if (p.type === "tool-invocation" && p.toolInvocation) {
    const invocation = p.toolInvocation as Record<string, unknown>;
    if (invocation.toolName === "load_skill") {
      return readNameFromInput(invocation.input ?? invocation.args);
    }
  }
  return undefined;
}

// Walks every message's `parts[]` and `content[]` (both are used across the
// AI SDK v6 message shapes we persist/replay) looking for load_skill calls,
// keeping the LATEST prototype/slides match found (iterating in order).
function latestPolicySkillFromMessages(
  messages: Array<Record<string, unknown>>,
): "prototype" | "slides" | undefined {
  let latest: "prototype" | "slides" | undefined;

  const visitPartArray = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const part of arr) {
      const name = loadSkillNameFromPart(part);
      if (isPolicySkillName(name)) {
        latest = name;
      }
    }
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    visitPartArray((message as Record<string, unknown>).parts);
    visitPartArray((message as Record<string, unknown>).content);
  }

  return latest;
}

export function resolveTaskPolicy(args: {
  messages: Array<Record<string, unknown>>;
  slashSkillName?: string;
}): TaskPolicy {
  if (args.slashSkillName === "slides") return "slides";
  if (args.slashSkillName === "prototype") return "prototype";

  const fromHistory = latestPolicySkillFromMessages(args.messages);
  if (fromHistory) return fromHistory;

  return "native";
}
