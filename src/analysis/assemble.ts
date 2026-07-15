export interface RawTraceDbRow {
  id: number;
  session_id: string;
  created_at: Date;
  model: string;
  agent_mode: string;
  payload: { messages?: unknown[]; steps?: unknown[]; systemPromptHash?: string };
  stream_error: string | null;
  input_tokens: number;
  output_tokens: number;
}

export interface AssembledSession {
  sessionId: string;
  model: string;
  agentMode: string;
  startedAt: Date;
  endedAt: Date;
  requestCount: number;
  messages: unknown[];
  // The final turn's steps (text + tool calls the model produced in response
  // to the last request) — `messages` only carries client history BEFORE that
  // response, so the summarizer would otherwise never see it.
  finalTurnSteps: unknown[];
  streamErrors: string[];
  stepCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// Later requests of a session carry the entire prior history (split-execution:
// client-tool results/errors ride along in `messages`), so the row with the
// longest history IS the session transcript.
export function assembleSession(rows: RawTraceDbRow[]): AssembledSession {
  if (rows.length === 0) throw new Error("assembleSession: no rows");
  const sorted = [...rows].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
  const longest = sorted.reduce((best, r) =>
    (r.payload.messages?.length ?? 0) >= (best.payload.messages?.length ?? 0)
      ? r
      : best,
  );
  const last = sorted[sorted.length - 1];
  return {
    sessionId: last.session_id,
    model: last.model,
    agentMode: last.agent_mode,
    startedAt: sorted[0].created_at,
    endedAt: last.created_at,
    requestCount: sorted.length,
    messages: longest.payload.messages ?? [],
    finalTurnSteps: longest.payload.steps ?? [],
    streamErrors: sorted
      .map((r) => r.stream_error)
      .filter((e): e is string => Boolean(e)),
    stepCount: sorted.reduce((n, r) => n + (r.payload.steps?.length ?? 0), 0),
    totalInputTokens: sorted.reduce((n, r) => n + r.input_tokens, 0),
    totalOutputTokens: sorted.reduce((n, r) => n + r.output_tokens, 0),
  };
}

const MAX_PART_CHARS = 1_500;

function clip(value: unknown, max = MAX_PART_CHARS): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function renderPart(part: Record<string, unknown>): string | null {
  const type = String(part.type ?? "");
  if (type === "text") return clip(part.text);
  if (type === "file" || type === "image") return "[image omitted]";
  if (type === "reasoning") return null;
  if (type.startsWith("tool-") || type === "dynamic-tool") {
    const name =
      type === "dynamic-tool" ? String(part.toolName ?? "?") : type.slice(5);
    const input = part.input === undefined ? "" : ` input: ${clip(part.input, 500)}`;
    const errorText =
      typeof part.errorText === "string" && part.errorText.length > 0
        ? part.errorText
        : undefined;
    if (part.state === "output-error" || errorText !== undefined) {
      return `[tool ${name}]${input} ERROR: ${clip(errorText ?? "unknown error", 1000)}`;
    }
    const output =
      part.output === undefined ? "" : ` output: ${clip(part.output, 1000)}`;
    return `[tool ${name}]${input}${output}`;
  }
  return null;
}

// `finalTurnSteps` come from `LogStep` (src/logging.ts), a different shape
// from message parts: { text, toolCalls: {toolName,args}[], toolResults:
// {toolName,result}[] } with tool calls/results paired by array index.
function renderFinalTurnStep(step: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const text = typeof step.text === "string" ? step.text.trim() : "";
  if (text) lines.push(`assistant: ${clip(text)}`);

  const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
  toolCalls.forEach((rawCall, i) => {
    if (!rawCall || typeof rawCall !== "object") return;
    const call = rawCall as Record<string, unknown>;
    const name = String(call.toolName ?? "?");
    const input = call.args === undefined ? "" : ` input: ${clip(call.args, 500)}`;

    const rawResult = toolResults[i];
    let outputPart = "";
    if (rawResult && typeof rawResult === "object") {
      const result = (rawResult as Record<string, unknown>).result;
      const errorText =
        result && typeof result === "object" &&
        typeof (result as Record<string, unknown>).error === "string"
          ? ((result as Record<string, unknown>).error as string)
          : undefined;
      if (errorText !== undefined) {
        outputPart = ` ERROR: ${clip(errorText, 1000)}`;
      } else if (result !== undefined) {
        outputPart = ` output: ${clip(result, 1000)}`;
      }
    }
    lines.push(`assistant: [tool ${name}]${input}${outputPart}`);
  });
  return lines;
}

export function renderSessionText(
  session: AssembledSession,
  maxChars = 60_000,
): string {
  const lines: string[] = [];
  for (const msg of session.messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const rendered = renderPart(part as Record<string, unknown>);
      if (rendered) lines.push(`${role}: ${rendered}`);
    }
  }
  const finalTurnLines = session.finalTurnSteps.flatMap((step) =>
    step && typeof step === "object"
      ? renderFinalTurnStep(step as Record<string, unknown>)
      : [],
  );
  if (finalTurnLines.length > 0) {
    lines.push("Final turn:");
    lines.push(...finalTurnLines);
  }
  if (session.streamErrors.length > 0) {
    lines.push(`Stream errors:\n${session.streamErrors.join("\n")}`);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[...truncated...]\n${text.slice(-half)}`;
}
