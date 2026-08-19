export interface RawTraceDbRow {
  id: number;
  session_id: string;
  created_at: Date;
  // Same anonymous id carried on RawTraceRow (traceStore.ts); absent on rows
  // written before the column existed or on a turn without a plausible id.
  user_id?: string | null;
  model: string;
  agent_mode: string;
  payload: { messages?: unknown[]; steps?: unknown[]; systemPromptHash?: string };
  stream_error: string | null;
  input_tokens: number;
  output_tokens: number;
}

export interface AssembledSession {
  sessionId: string;
  // First non-null user_id among the session's rows, else null. Feeds
  // session_summaries.user_id (src/analysis/run.ts).
  userId: string | null;
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
    // First non-null wins: one session is one client, and later rows of a
    // session can only lose the id (an older client tab), never change it.
    userId: sorted.find((r) => r.user_id)?.user_id ?? null,
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

interface ClipLimits {
  text: number;
  toolInput: number;
  toolOutput: number;
}

// Tried most-generous-first; the first tier whose render fits `maxChars`
// wins. `text` never tightens across tiers: user messages ARE the
// corrections we are mining for, and errors are the failures. Only tool
// payloads give ground.
const TIERS: ClipLimits[] = [
  { text: 4000, toolInput: 2000, toolOutput: 2000 },
  { text: 4000, toolInput: 500, toolOutput: 1000 },
  { text: 4000, toolInput: 200, toolOutput: 200 },
];

const ERROR_CHARS = 1_000;

function clip(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function renderPart(
  part: Record<string, unknown>,
  limits: ClipLimits,
): string | null {
  const type = String(part.type ?? "");
  if (type === "text") return clip(part.text, limits.text);
  if (type === "file" || type === "image") return "[image omitted]";
  if (type === "reasoning") return null;
  if (type.startsWith("tool-") || type === "dynamic-tool") {
    const name =
      type === "dynamic-tool" ? String(part.toolName ?? "?") : type.slice(5);
    const input =
      part.input === undefined ? "" : ` input: ${clip(part.input, limits.toolInput)}`;
    const errorText =
      typeof part.errorText === "string" && part.errorText.length > 0
        ? part.errorText
        : undefined;
    if (part.state === "output-error" || errorText !== undefined) {
      return `[tool ${name}]${input} ERROR: ${clip(errorText ?? "unknown error", ERROR_CHARS)}`;
    }
    const output =
      part.output === undefined ? "" : ` output: ${clip(part.output, limits.toolOutput)}`;
    return `[tool ${name}]${input}${output}`;
  }
  return null;
}

// `finalTurnSteps` come from `LogStep` (src/logging.ts), a different shape
// from message parts: { text, toolCalls: {toolName,args}[], toolResults:
// {toolName,result}[] } with tool calls/results paired by array index.
function renderFinalTurnStep(
  step: Record<string, unknown>,
  limits: ClipLimits,
): string[] {
  const lines: string[] = [];
  const text = typeof step.text === "string" ? step.text.trim() : "";
  if (text) lines.push(`assistant: ${clip(text, limits.text)}`);

  const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
  toolCalls.forEach((rawCall, i) => {
    if (!rawCall || typeof rawCall !== "object") return;
    const call = rawCall as Record<string, unknown>;
    const name = String(call.toolName ?? "?");
    const input =
      call.args === undefined ? "" : ` input: ${clip(call.args, limits.toolInput)}`;

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
        outputPart = ` ERROR: ${clip(errorText, ERROR_CHARS)}`;
      } else if (result !== undefined) {
        outputPart = ` output: ${clip(result, limits.toolOutput)}`;
      }
    }
    lines.push(`assistant: [tool ${name}]${input}${outputPart}`);
  });
  return lines;
}

function renderAtTier(session: AssembledSession, limits: ClipLimits): string {
  const lines: string[] = [];
  for (const msg of session.messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const rendered = renderPart(part as Record<string, unknown>, limits);
      if (rendered) lines.push(`${role}: ${rendered}`);
    }
  }
  const finalTurnLines = session.finalTurnSteps.flatMap((step) =>
    step && typeof step === "object"
      ? renderFinalTurnStep(step as Record<string, unknown>, limits)
      : [],
  );
  if (finalTurnLines.length > 0) {
    lines.push("Final turn:");
    lines.push(...finalTurnLines);
  }
  if (session.streamErrors.length > 0) {
    lines.push(`Stream errors:\n${session.streamErrors.join("\n")}`);
  }
  return lines.join("\n");
}

// 200k chars ≈ 50k tokens — comfortable for ANALYSIS_MODEL (gemini-2.5-flash,
// 1M-token context) and far above any real session.
export function renderSessionText(
  session: AssembledSession,
  maxChars = 200_000,
): string {
  let text = "";
  for (const limits of TIERS) {
    text = renderAtTier(session, limits);
    if (text.length <= maxChars) return text;
  }
  // Last resort: even the tightest tier overflows.
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[...truncated...]\n${text.slice(-half)}`;
}
