import type { ModelMessage } from "ai";

// Observation masking for old, large browser tool outputs. See
// docs/specs/2026-10-23-context-compaction-design.md ("Phase 1"). The
// history grows inside ONE user message in the tool loop, mostly from
// browse_* outputs (page snapshots) in the browse subagent turn. A snapshot
// from twenty steps ago describes a page that has long since changed, so it
// is replaced by a constant placeholder once it ages out.
//
// PURE module: no I/O, no process-global state, no clock. Same input array
// gives byte-identical output, which is what keeps the provider's cached
// prompt prefix stable. Mirrors image-budget.ts's step-wise cutoff.

/** Only these tools are masked. Everything else stays verbatim. */
export const TEXT_BUDGET_TOOLS: readonly string[] = ["browse_act", "browse_snapshot", "browse_open"];

/** H: the most recent tool results are never touched (every tool counts). */
export const KEEP_RECENT_TOOL_RESULTS = 5;
/** S: the eligible prefix grows in multiples of S, so the boundary moves rarely. */
export const TEXT_BUDGET_STEP = 5;
/** A result at or under this many chars is not worth masking. */
export const MASK_MIN_CHARS = 2000;
/**
 * How much of the original output the placeholder keeps verbatim. A
 * browse_act result opens with its outcome (url, title, changed, ...); without
 * it the model cannot tell whether an old "Submit" click succeeded and may
 * repeat an irreversible action. The head is a pure function of the output,
 * so the placeholder stays byte-identical across turns.
 */
export const MASKED_HEAD_CHARS = 300;

export interface TextBudgetReport {
  mode: "shadow" | "enforce";
  /**
   * Estimated size in tokens (chars / 4) of the MESSAGES only: no system
   * prompt, no tool schemas, no image/file data. The provider's input token
   * count is larger. The start threshold is compared against this number.
   */
  estimatedTokens: number;
  /** Number of tool-result parts in the history. */
  toolResults: number;
  /** Parts that were (enforce) or would be (shadow) masked. */
  elidedParts: number;
  /** Original chars of those parts. */
  elidedChars: number;
  /** Estimated chars of the whole history. */
  totalChars: number;
}

export type TextBudgetCounts = Omit<TextBudgetReport, "mode">;

// Same formula as image-budget.ts's private cutoff(): C = floor(max(0, N-H)/S)*S.
function cutoff(total: number, liveFloor: number, step: number): number {
  return Math.floor(Math.max(0, total - liveFloor) / step) * step;
}

type ToolOutput = { type: string; value?: unknown };

function isErrorOutput(output: ToolOutput): boolean {
  return output.type === "error-text" || output.type === "error-json";
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value ?? null)?.length ?? 0;
}

// A `content` output that carries anything besides text (an image, a file)
// is never masked: replacing it would delete the image too and shift the slot
// count that image-budget.ts and the vision pass below this one rely on.
function hasNonTextContent(output: ToolOutput): boolean {
  return (
    output.type === "content" &&
    Array.isArray(output.value) &&
    (output.value as Array<{ type?: string }>).some((item) => item?.type !== "text")
  );
}

// The output as text, for the size estimate and the placeholder head.
// `content` outputs keep only their text items; image/file data never counts.
function outputText(output: ToolOutput): string {
  if (output.type === "text" || output.type === "error-text") {
    return typeof output.value === "string" ? output.value : "";
  }
  if (output.type === "content" && Array.isArray(output.value)) {
    return (output.value as Array<{ type?: string; text?: string }>)
      .map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
      .join("");
  }
  if (output.type === "json" || output.type === "error-json") {
    return JSON.stringify(output.value ?? null) ?? "";
  }
  return "";
}

function outputChars(output: ToolOutput): number {
  if (output.type === "json" || output.type === "error-json") return jsonLength(output.value);
  return outputText(output).length;
}

function messageChars(message: ModelMessage): number {
  if (typeof message.content === "string") return message.content.length;
  let n = 0;
  for (const part of message.content as Array<Record<string, unknown>>) {
    if (part.type === "text" || part.type === "reasoning") {
      n += typeof part.text === "string" ? part.text.length : 0;
    } else if (part.type === "tool-call") {
      n += jsonLength(part.input);
    } else if (part.type === "tool-result") {
      n += outputChars(part.output as ToolOutput);
    }
  }
  return n;
}

/** Constant text: a pure function of (toolName, original output text) only. */
export function textBudgetPlaceholder(toolName: string, text: string): string {
  const head = text.slice(0, MASKED_HEAD_CHARS);
  return `[Earlier ${toolName} result shortened to save context (${text.length} chars). It showed the page at that moment; the page may have changed since. Call browse_snapshot to read the current page. Start of the result: ${head}]`;
}

interface Analysis {
  counts: TextBudgetCounts;
  /** Ordinals (chronological tool-result index) to mask, with original size. */
  masked: Map<number, number>;
}

function analyse(messages: ModelMessage[], opts: { startTokens: number }): Analysis {
  let totalChars = 0;
  let toolResults = 0;
  const candidates: Array<{ ordinal: number; chars: number; toolName: string }> = [];
  // Newest non-error result of each masked tool, of any size.
  const newestOfTool = new Map<string, number>();

  // Pass 1: size, and candidate list with their global ordinals.
  for (const message of messages) {
    totalChars += messageChars(message);
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const ordinal = toolResults++;
      const output = part.output as ToolOutput;
      if (!TEXT_BUDGET_TOOLS.includes(part.toolName)) continue;
      if (isErrorOutput(output)) continue;
      newestOfTool.set(part.toolName, ordinal);
      if (hasNonTextContent(output)) continue;
      const chars = outputChars(output);
      if (chars > MASK_MIN_CHARS) candidates.push({ ordinal, chars, toolName: part.toolName });
    }
  }

  const estimatedTokens = Math.ceil(totalChars / 4);
  const masked = new Map<number, number>();
  if (estimatedTokens >= opts.startTokens) {
    const limit = cutoff(toolResults, KEEP_RECENT_TOOL_RESULTS, TEXT_BUDGET_STEP);
    // The newest result of each masked tool always stays, even past the
    // cutoff: after a run of other tools (browse_read, web_search, ...) the
    // last browse_snapshot is still the only element table the next
    // browse_act can refer to. Still monotone: a result loses this
    // protection only when a newer one of its tool arrives, never regains it.
    for (const c of candidates) {
      if (c.ordinal < limit && newestOfTool.get(c.toolName) !== c.ordinal) masked.set(c.ordinal, c.chars);
    }
  }
  let elidedChars = 0;
  for (const chars of masked.values()) elidedChars += chars;
  return {
    counts: { estimatedTokens, toolResults, elidedParts: masked.size, elidedChars, totalChars },
    masked,
  };
}

/** Report only: what applyTextBudget would remove. Never changes anything. */
export function planTextBudget(
  messages: ModelMessage[],
  opts: { startTokens: number },
): TextBudgetCounts {
  return analyse(messages, opts).counts;
}

/**
 * Returns the history with old, large browse_* outputs replaced by a constant
 * placeholder. Does not mutate the input; unchanged messages are shared. When
 * nothing is masked the SAME array is returned.
 */
export function applyTextBudget(
  messages: ModelMessage[],
  opts: { startTokens: number },
): { messages: ModelMessage[]; report: TextBudgetCounts } {
  const { counts, masked } = analyse(messages, opts);
  if (masked.size === 0) return { messages, report: counts };

  let ordinal = 0;
  const next = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (!masked.has(ordinal++)) return part;
      changed = true;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: textBudgetPlaceholder(part.toolName, outputText(part.output as ToolOutput)),
        },
      };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: next, report: counts };
}
