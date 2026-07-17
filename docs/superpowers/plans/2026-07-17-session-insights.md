# Session Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract, store, and report the material the Clio summarizer must discard — verbatim user corrections, memory requests, the agent's own claims, and whether it recovered from tool errors — as input for a cron self-improvement agent.

**Architecture:** A second `generateObject` pass per session (`src/analysis/insights.ts`), independent of `summarize.ts`, persisted to a new `session_insights` table keyed by `session_id`. `run.ts` gains a second loop that backfills any summarized session lacking insights. Transcript rendering in `assemble.ts` becomes budget-tiered so user text and errors are never truncated to make room for tool payloads. `mapSteps` in `chat.ts` is fixed so the final turn's tool I/O is no longer empty.

**Tech Stack:** TypeScript (ESM, `moduleResolution: NodeNext`), Fastify, Vercel AI SDK v6 (`generateObject`), zod, node-postgres, Vitest.

Spec: `docs/superpowers/specs/2026-07-17-session-insights-design.md`

## Global Constraints

- **Relative imports MUST carry the `.js` extension** (e.g. `import { scrubPii } from "./pii.js"`) — required by `moduleResolution: "NodeNext"` + ESM.
- Tests live in `test/`, never in `src/`. Run with `npm test`. `npm run lint` must report 0 errors.
- `raw_traces` is the ONLY table allowed to hold unsanitized content. Every string written to `session_insights` passes through `scrubPii`.
- Verbatim quotes are permitted ONLY in the `user_quote` / `quote` fields of insights. `summarize.ts` and its no-quotes rule are NOT to be modified by this plan.
- `ANALYSIS_MODEL` defaults to `google/gemini-2.5-flash` (1M-token context).
- The extractor reports what the agent SAID. It must never invent lessons or interpretations — deriving lessons is the cron agent's job.
- Commit after every task. Do not push; the user cuts releases via the `ship-release` skill.

---

### Task 1: Insights extractor

**Files:**
- Create: `src/analysis/insights.ts`
- Test: `test/insights.test.ts`

**Interfaces:**
- Consumes: `scrubPii` from `src/analysis/pii.ts` — `(text: string) => string`.
- Produces:
  - `sessionInsightsSchema` (zod object)
  - `type SessionInsights = z.infer<typeof sessionInsightsSchema>`
  - `extractInsights(model: LanguageModel, sessionText: string): Promise<SessionInsights>`

- [ ] **Step 1: Write the failing test**

Create `test/insights.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { extractInsights, sessionInsightsSchema } from "../src/analysis/insights.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const cleanInsights = {
  errors: [
    {
      tool: "batch_design",
      error: "unknown node id",
      recovered: false,
      what_agent_did_next: "Reported the failure to the user and stopped.",
    },
  ],
  corrections: [
    {
      what_agent_did: "Placed the card at the canvas origin",
      what_user_wanted: "The card centred in the existing frame",
      user_quote: "no, put it inside the frame, not next to it",
      agent_complied: true,
    },
  ],
  memory_requests: [{ quote: "always use 8px spacing from now on", honored: false }],
  agent_claims: [
    { quote: "I cannot read the canvas without a tool call", kind: "limitation" },
  ],
};

function objectModel(objects: Array<Record<string, unknown>>) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        { type: "text", text: JSON.stringify(objects[Math.min(call++, objects.length - 1)]) },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

describe("extractInsights", () => {
  it("returns validated insights with all four categories", async () => {
    const result = await extractInsights(objectModel([cleanInsights]), "user: make a card");
    expect(result.errors[0].recovered).toBe(false);
    expect(result.corrections[0].agent_complied).toBe(true);
    expect(result.memory_requests[0].honored).toBe(false);
    expect(result.agent_claims[0].kind).toBe("limitation");
  });

  it("scrubs PII out of verbatim quote fields", async () => {
    const dirty = {
      ...cleanInsights,
      memory_requests: [{ quote: "remember my email is john@example.com", honored: true }],
      corrections: [
        {
          ...cleanInsights.corrections[0],
          user_quote: "call me on +1 555 123 4567 instead",
        },
      ],
    };
    const result = await extractInsights(objectModel([dirty]), "text");
    expect(result.memory_requests[0].quote).toContain("[EMAIL]");
    expect(result.memory_requests[0].quote).not.toContain("john@example.com");
    expect(result.corrections[0].user_quote).toContain("[PHONE]");
  });

  it("keeps empty categories as empty arrays", async () => {
    const empty = { errors: [], corrections: [], memory_requests: [], agent_claims: [] };
    const result = await extractInsights(objectModel([empty]), "user: hi");
    expect(result).toEqual(empty);
  });

  it("schema rejects an unknown agent_claim kind", () => {
    const bad = {
      ...cleanInsights,
      agent_claims: [{ quote: "q", kind: "musing" }],
    };
    expect(sessionInsightsSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- insights`
Expected: FAIL — `Cannot find module '../src/analysis/insights.js'`

- [ ] **Step 3: Write the implementation**

Create `src/analysis/insights.ts`:

```ts
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { scrubPii } from "./pii.js";

export const sessionInsightsSchema = z.object({
  errors: z.array(
    z.object({
      tool: z.string().describe("Tool name"),
      error: z.string().describe("Error category, not the raw payload"),
      recovered: z
        .boolean()
        .describe("Did the agent get past this error later in the session"),
      what_agent_did_next: z
        .string()
        .describe("The agent's next action after the error"),
    }),
  ),
  corrections: z.array(
    z.object({
      what_agent_did: z.string().describe("The action the user pushed back on"),
      what_user_wanted: z.string().describe("What the user wanted instead"),
      user_quote: z.string().describe("The user's correction, VERBATIM"),
      agent_complied: z
        .boolean()
        .describe("Did the agent then do what the user asked"),
    }),
  ),
  memory_requests: z.array(
    z.object({
      quote: z
        .string()
        .describe("The user's request to remember/always-do something, VERBATIM"),
      honored: z.boolean().describe("Did the agent follow it for the rest of the session"),
    }),
  ),
  agent_claims: z.array(
    z.object({
      quote: z.string().describe("Something the agent stated about itself, VERBATIM"),
      kind: z.enum(["limitation", "assumption", "plan", "conclusion"]),
    }),
  ),
});

export type SessionInsights = z.infer<typeof sessionInsightsSchema>;

// Unlike the Clio summarizer, this pass MAY quote the user — the exact wording of
// a correction or a "remember X" IS the rule the cron agent needs. Privacy is held
// by the PII rules below plus scrubInsights() on the way out.
const INSIGHTS_SYSTEM = `You read a trace of a session between a user and an AI design agent that edits a canvas via tools. You extract facts that would help improve the agent's system prompt.

Extract four categories:
- errors: tool failures. Report the tool and a short error CATEGORY (e.g. "unknown node id"), whether the agent RECOVERED later in the session, and what it did next.
- corrections: moments the user pushed back on what the agent did. Quote the user's correction verbatim.
- memory_requests: moments the user asked the agent to remember something or always do something. Quote verbatim. Set honored=false if the agent later ignored it.
- agent_claims: statements the agent made ABOUT ITSELF — its limitations, assumptions, plans, or conclusions. Quote verbatim.

RULES:
- Report only what is IN the trace. Never invent lessons, interpretations, or advice — that is a downstream job.
- agent_claims are things the AGENT said, not your analysis of the session.
- Quotes are allowed ONLY in user_quote and quote. Everything else is your own description.
- Even in quotes: never include personal names, emails, phone numbers, addresses, or credentials. Skip an entry rather than quote a credential.
- If a category has nothing, return an empty array. Do not pad.`;

function scrubInsights(i: SessionInsights): SessionInsights {
  return {
    errors: i.errors.map((e) => ({
      ...e,
      tool: scrubPii(e.tool),
      error: scrubPii(e.error),
      what_agent_did_next: scrubPii(e.what_agent_did_next),
    })),
    corrections: i.corrections.map((c) => ({
      ...c,
      what_agent_did: scrubPii(c.what_agent_did),
      what_user_wanted: scrubPii(c.what_user_wanted),
      user_quote: scrubPii(c.user_quote),
    })),
    memory_requests: i.memory_requests.map((m) => ({ ...m, quote: scrubPii(m.quote) })),
    agent_claims: i.agent_claims.map((a) => ({ ...a, quote: scrubPii(a.quote) })),
  };
}

export async function extractInsights(
  model: LanguageModel,
  sessionText: string,
): Promise<SessionInsights> {
  const { object } = await generateObject({
    model,
    schema: sessionInsightsSchema,
    system: INSIGHTS_SYSTEM,
    prompt: scrubPii(sessionText),
  });
  return scrubInsights(object);
}
```

- [ ] **Step 4: Run the tests and lint**

Run: `npm test -- insights && npm run lint`
Expected: 4 tests PASS, lint reports 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/insights.ts test/insights.test.ts
git commit -m "feat(analysis): add session insights extractor"
```

---

### Task 2: Tiered transcript rendering

**Files:**
- Modify: `src/analysis/assemble.ts:63-161` (`MAX_PART_CHARS`, `clip`, `renderPart`, `renderFinalTurnStep`, `renderSessionText`)
- Test: `test/assemble.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `AssembledSession` (already defined in this file, unchanged).
- Produces: `renderSessionText(session: AssembledSession, maxChars?: number): string` — same signature as today, `maxChars` default changes from `60_000` to `200_000`. All callers (`run.ts`) keep working unchanged.

**Why:** the flat 60k cap cuts the middle out of the transcript, and tool inputs clip at 500 chars. The longest sessions are both the most truncated and the most interesting, so the extractor would lose the corrections it exists to find. Tiering tightens tool payloads first and leaves user text and errors intact.

- [ ] **Step 1: Write the failing test**

Append to `test/assemble.test.ts`:

```ts
describe("renderSessionText tiering", () => {
  const longInput = { operations: ["x".repeat(3000)] };
  const bigToolMsg = {
    role: "assistant",
    parts: [
      {
        type: "tool-batch_design",
        toolCallId: "c1",
        state: "output-available",
        input: longInput,
        output: "y".repeat(3000),
      },
    ],
  };
  const correction = {
    role: "user",
    parts: [{ type: "text", text: "no, put it inside the frame, not next to it" }],
  };

  it("tier 1: keeps generous tool payloads when the transcript fits", () => {
    const session = assembleSession([
      row({ payload: { messages: [correction, bigToolMsg], steps: [] } }),
    ]);
    const text = renderSessionText(session);
    expect(text).toContain("no, put it inside the frame, not next to it");
    // tier 1 allows 2000 chars of tool input: more than the old 500-char clip
    expect(text.length).toBeGreaterThan(2500);
  });

  it("tightens tool payloads but never the user's text when over budget", () => {
    const session = assembleSession([
      row({ payload: { messages: [correction, bigToolMsg], steps: [] } }),
    ]);
    const text = renderSessionText(session, 1200);
    expect(text).toContain("no, put it inside the frame, not next to it");
    expect(text.length).toBeLessThanOrEqual(1200);
  });

  it("falls back to middle-truncation when even the tightest tier overflows", () => {
    const many = Array.from({ length: 200 }, () => bigToolMsg);
    const session = assembleSession([
      row({ payload: { messages: [correction, ...many], steps: [] } }),
    ]);
    const text = renderSessionText(session, 2000);
    expect(text).toContain("[...truncated...]");
    expect(text.length).toBeLessThanOrEqual(2200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assemble`
Expected: FAIL — the tier-1 case fails because today's `clip` caps tool input at 500 chars.

- [ ] **Step 3: Implement tiering**

In `src/analysis/assemble.ts`, replace everything from `const MAX_PART_CHARS = 1_500;` (line 63) down to the end of `renderSessionText` with:

```ts
interface ClipLimits {
  text: number;
  toolInput: number;
  toolOutput: number;
}

// Tried most-generous-first; the first tier whose render fits `maxChars` wins.
// `text` never tightens across tiers: user messages ARE the corrections we are
// mining for, and errors are the failures. Only tool payloads give ground.
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
```

- [ ] **Step 4: Run the tests and lint**

Run: `npm test -- assemble && npm run lint`
Expected: all `assemble` tests PASS (the pre-existing ones too — they assert content, not clip lengths). Lint 0 errors.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all PASS. If a pre-existing test pinned the old 60k default or a 500-char clip, update that test to the new tiering and note it in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/assemble.ts test/assemble.test.ts
git commit -m "feat(analysis): tier transcript rendering so user text is never truncated"
```

---

### Task 3: Fix `mapSteps` tool I/O

**Files:**
- Modify: `src/routes/chat.ts:57-75` (`mapSteps`)
- Test: `test/chat-trace.test.ts` (append a case)

**Interfaces:**
- Produces: no signature change. `mapSteps` keeps writing the `LogStep` shape from `src/logging.ts` — field names stay `args` and `result`. ONLY the source properties change.

**Why:** `mapSteps` reads `tc.args` / `tr.result`, but AI SDK v6 emits `input` / `output` on step tool calls and results. Verified against the live database on 2026-07-17: `payload.steps[].toolCalls[].args` is `{}` on every row ever written. This matters because `assembleSession` takes the final turn from `payload.steps` (`messages` only carries history BEFORE the last response), so the last assistant turn renders with no input, no output and no ERROR line — and that is where a failing session usually fails.

Keeping the `args`/`result` field names means `assemble.ts` needs no change and old rows still parse.

**Note:** this only helps traces written from now on. The 9 existing sessions already hold `args: {}` on disk; their backfilled insights keep a blind final turn.

- [ ] **Step 1: Write the failing test**

Append to the `describe("chat route trace writing", ...)` block in `test/chat-trace.test.ts`. It reuses the file's existing `toolThenSlowTextChunks()` (emits a `get_guidelines` tool call with `input: {topic:"table"}`, then finishes with `tool-calls`), `textStreamChunks`, `recordingTraceStore`, `startServer`, `postChat` and `userMessage` helpers — do not add a second harness. `get_guidelines` is server-executed (it has an `execute` in `penTools`) and `topic: "table"` is a valid enum value, so the step yields a real tool result:

```ts
  it("records v6 step tool input/output into payload.steps", async () => {
    // Turn 1 calls the tool; turn 2 (after the tool result) finishes with text.
    let call = 0;
    holders.model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks: call === 1 ? toolThenSlowTextChunks() : textStreamChunks("done"),
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const store = recordingTraceStore();
    const { app, url } = await startServer(makeConfig(), store);
    await (
      await postChat(url, {
        id: "tab-args-1",
        messages: [userMessage("give me table guidelines")],
      })
    ).text();
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    const steps = store.rows[0].payload.steps as Array<{
      toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
      toolResults: Array<{ toolName: string; result: unknown }>;
    }>;
    expect(steps[0].toolCalls[0].toolName).toBe("get_guidelines");
    expect(steps[0].toolCalls[0].args).toEqual({ topic: "table" });
    expect(steps[0].toolResults[0].result).toBeTruthy();
    await app.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- chat-trace`
Expected: FAIL — `args` is `{}` because `mapSteps` reads the v4-era `tc.args`.

- [ ] **Step 3: Fix `mapSteps`**

In `src/routes/chat.ts`, replace the `toolCalls` / `toolResults` mapping inside `mapSteps`:

```ts
    // AI SDK v6 emits `input`/`output` on step tool calls/results; `args`/`result`
    // are the v4-era names and are always undefined. The LogStep field names stay
    // as-is so stored traces keep their shape.
    toolCalls: step.toolCalls.map((tc: Record<string, unknown>) => ({
      toolName: String(tc.toolName ?? ""),
      args: (tc.input ?? tc.args ?? {}) as Record<string, unknown>,
    })),
    toolResults: step.toolResults.map((tr: Record<string, unknown>) => ({
      toolName: String(tr.toolName ?? ""),
      result: tr.output ?? tr.result,
    })),
```

- [ ] **Step 4: Run the tests and lint**

Run: `npm test -- chat-trace && npm run lint`
Expected: PASS, 0 lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/chat.ts test/chat-trace.test.ts
git commit -m "fix(tracing): read v6 input/output in mapSteps so final-turn tool I/O is recorded"
```

---

### Task 4: Persist insights (migration + run loop)

**Files:**
- Create: `src/analysis/migrations/002_insights.sql`
- Modify: `src/analysis/run.ts` (add a loop after the summarization loop, before TTL cleanup)
- Test: `test/analysis-run.test.ts` (append a `tallyInsights` block)

**Interfaces:**
- Consumes: `extractInsights` from Task 1, `assembleSession` / `renderSessionText` from `src/analysis/assemble.ts`.
- Produces: `tallyInsights(rows: InsightRow[]): ReportInsights` exported from `src/analysis/run.ts` — Task 5 renders its output. Types:

```ts
export interface InsightRow {
  errors: Array<{ tool: string; error: string; recovered: boolean }>;
  corrections: Array<{ what_agent_did: string; what_user_wanted: string; agent_complied: boolean }>;
  memory_requests: Array<{ quote: string; honored: boolean }>;
}
```

`ReportInsights` is defined in Task 5 (`src/analysis/report.ts`) and imported here.

The build copies `src/analysis/migrations/` into `dist/` wholesale (see `package.json` `build`), so `002_insights.sql` needs no build change.

- [ ] **Step 1: Write the migration**

Create `src/analysis/migrations/002_insights.sql`:

```sql
CREATE TABLE IF NOT EXISTS session_insights (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT        NOT NULL UNIQUE
                    REFERENCES session_summaries(session_id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  errors          JSONB       NOT NULL DEFAULT '[]',
  corrections     JSONB       NOT NULL DEFAULT '[]',
  memory_requests JSONB       NOT NULL DEFAULT '[]',
  agent_claims    JSONB       NOT NULL DEFAULT '[]',
  model           TEXT        NOT NULL
);
```

- [ ] **Step 2: Write the failing test for `tallyInsights`**

Append to `test/analysis-run.test.ts`:

```ts
import { parseWindowDays, tally, tallyInsights } from "../src/analysis/run.js";

describe("tallyInsights", () => {
  const rows = [
    {
      errors: [
        { tool: "batch_design", error: "unknown node id", recovered: false },
        { tool: "batch_design", error: "operation limit", recovered: true },
      ],
      corrections: [
        { what_agent_did: "placed at origin", what_user_wanted: "inside the frame", agent_complied: true },
        { what_agent_did: "used 12px gap", what_user_wanted: "8px gap", agent_complied: false },
      ],
      memory_requests: [{ quote: "always use 8px spacing", honored: false }],
    },
    { errors: [], corrections: [], memory_requests: [{ quote: "prefer dark mode", honored: true }] },
  ];

  it("counts totals and surfaces only the actionable entries", () => {
    const t = tallyInsights(rows);
    expect(t.corrections).toBe(2);
    expect(t.memoryRequests).toBe(2);
    expect(t.correctionsNotComplied).toEqual([
      { what_agent_did: "used 12px gap", what_user_wanted: "8px gap" },
    ]);
    expect(t.memoryRequestsNotHonored).toEqual(["always use 8px spacing"]);
    expect(t.unrecoveredErrors).toEqual([
      { tool: "batch_design", error: "unknown node id" },
    ]);
  });

  it("returns zeroed counts for no rows", () => {
    expect(tallyInsights([])).toEqual({
      corrections: 0,
      correctionsNotComplied: [],
      memoryRequests: 0,
      memoryRequestsNotHonored: [],
      unrecoveredErrors: [],
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- analysis-run`
Expected: FAIL — `tallyInsights is not a function`.

- [ ] **Step 4: Implement `tallyInsights` in `run.ts`**

Add to `src/analysis/run.ts`, next to the existing `tally`:

```ts
export interface InsightRow {
  errors: Array<{ tool: string; error: string; recovered: boolean }>;
  corrections: Array<{
    what_agent_did: string;
    what_user_wanted: string;
    agent_complied: boolean;
  }>;
  memory_requests: Array<{ quote: string; honored: boolean }>;
}

// The report lists what the agent got WRONG — a complied-with correction needs no
// action, an ignored one is a prompt bug.
export function tallyInsights(rows: InsightRow[]): ReportInsights {
  return {
    corrections: rows.reduce((n, r) => n + r.corrections.length, 0),
    correctionsNotComplied: rows.flatMap((r) =>
      r.corrections
        .filter((c) => !c.agent_complied)
        .map((c) => ({
          what_agent_did: c.what_agent_did,
          what_user_wanted: c.what_user_wanted,
        })),
    ),
    memoryRequests: rows.reduce((n, r) => n + r.memory_requests.length, 0),
    memoryRequestsNotHonored: rows.flatMap((r) =>
      r.memory_requests.filter((m) => !m.honored).map((m) => m.quote),
    ),
    unrecoveredErrors: rows.flatMap((r) =>
      r.errors
        .filter((e) => !e.recovered)
        .map((e) => ({ tool: e.tool, error: e.error })),
    ),
  };
}
```

Add the import at the top of `run.ts`:

```ts
import { renderReport, type ReportInsights } from "./report.js";
```

(`renderReport` is already imported — extend that line rather than adding a second one. `ReportInsights` lands in Task 5; if you are executing tasks in order, Task 5's type does not exist yet — do Task 5 before this step, or define the interface in `report.ts` now as its first deliverable.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- analysis-run`
Expected: PASS.

- [ ] **Step 6: Add the extraction loop to `main()`**

In `src/analysis/run.ts`, insert between the summarization loop (which ends with the `failedSessions` log) and the `// 2. Cluster the window` block:

```ts
    // 1b. Extract insights for any summarized session that lacks them. Separate
    // from summarization so it can fail, re-run and backfill independently — but
    // only while the raw traces live (TRACE_RAW_TTL_DAYS, deleted in step 3).
    const { rows: needInsights } = await pool.query<{ session_id: string }>(
      `SELECT ss.session_id FROM session_summaries ss
       WHERE NOT EXISTS (
         SELECT 1 FROM session_insights si WHERE si.session_id = ss.session_id
       )
       ORDER BY ss.id`,
    );
    console.log(`[analyze] ${needInsights.length} session(s) to extract insights from`);
    let failedInsights = 0;
    for (const { session_id } of needInsights) {
      try {
        const { rows } = await pool.query<RawTraceDbRow>(
          "SELECT * FROM raw_traces WHERE session_id = $1 ORDER BY created_at",
          [session_id],
        );
        if (rows.length === 0) {
          console.log(`[analyze] ${session_id}: raw traces expired, skipping insights`);
          continue;
        }
        const insights = await extractInsights(
          model,
          renderSessionText(assembleSession(rows)),
        );
        await pool.query(
          `INSERT INTO session_insights
             (session_id, errors, corrections, memory_requests, agent_claims, model)
           VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6)
           ON CONFLICT (session_id) DO NOTHING`,
          [
            session_id,
            JSON.stringify(insights.errors),
            JSON.stringify(insights.corrections),
            JSON.stringify(insights.memory_requests),
            JSON.stringify(insights.agent_claims),
            config.ANALYSIS_MODEL,
          ],
        );
        console.log(
          `[analyze] insights for ${session_id}: ${insights.corrections.length} correction(s), ${insights.memory_requests.length} memory request(s)`,
        );
      } catch (err) {
        failedInsights += 1;
        console.error(`[analyze] insights for ${session_id} failed:`, err);
        continue;
      }
    }
    if (failedInsights > 0) {
      console.log(`[analyze] ${failedInsights} session(s) failed insight extraction`);
    }
```

Add to the imports at the top of `run.ts`:

```ts
import { extractInsights } from "./insights.js";
```

- [ ] **Step 7: Verify the build and full suite**

Run: `npm test && npm run lint && npm run build`
Expected: all PASS, 0 lint errors, `dist/analysis/migrations/002_insights.sql` exists.

Check: `ls dist/analysis/migrations/`

- [ ] **Step 8: Commit**

```bash
git add src/analysis/migrations/002_insights.sql src/analysis/run.ts test/analysis-run.test.ts
git commit -m "feat(analysis): persist and backfill session insights"
```

---

### Task 5: Report section

**Files:**
- Modify: `src/analysis/report.ts` (add `ReportInsights`, extend `ReportInput`, render the section)
- Modify: `src/analysis/run.ts` (query insights for the window, pass `tallyInsights(...)` into `renderReport`)
- Test: `test/report.test.ts` (append cases)

**Interfaces:**
- Produces:

```ts
export interface ReportInsights {
  corrections: number;
  correctionsNotComplied: Array<{ what_agent_did: string; what_user_wanted: string }>;
  memoryRequests: number;
  memoryRequestsNotHonored: string[];
  unrecoveredErrors: Array<{ tool: string; error: string }>;
}
```
  `ReportInput` gains `insights?: ReportInsights`. Optional, so existing callers and tests keep compiling.

- [ ] **Step 1: Write the failing test**

Append to `test/report.test.ts`:

```ts
describe("insights section", () => {
  const withInsights: ReportInput = {
    ...input,
    insights: {
      corrections: 4,
      correctionsNotComplied: [
        { what_agent_did: "used a 12px gap", what_user_wanted: "an 8px gap" },
      ],
      memoryRequests: 3,
      memoryRequestsNotHonored: ["always use 8px spacing"],
      unrecoveredErrors: [{ tool: "batch_design", error: "unknown node id" }],
    },
  };

  it("renders counts and the actionable entries before the clusters", () => {
    const md = renderReport(withInsights);
    expect(md).toContain("## Corrections & memory requests");
    expect(md).toContain("**Corrections: 4** (1 not complied)");
    expect(md).toContain("**Memory requests: 3** (1 not honored)");
    expect(md).toContain("**Unrecovered tool errors: 1**");
    expect(md).toContain("- correction (not complied): used a 12px gap → an 8px gap");
    expect(md).toContain("- memory request (not honored): always use 8px spacing");
    expect(md).toContain("- unrecovered error: batch_design — unknown node id");
    expect(md.indexOf("## Corrections & memory requests")).toBeLessThan(
      md.indexOf("# Clusters"),
    );
  });

  it("omits the section entirely when insights are absent", () => {
    expect(renderReport(input)).not.toContain("## Corrections & memory requests");
  });

  it("omits the section when there is nothing to report", () => {
    const empty = {
      ...input,
      insights: {
        corrections: 0,
        correctionsNotComplied: [],
        memoryRequests: 0,
        memoryRequestsNotHonored: [],
        unrecoveredErrors: [],
      },
    };
    expect(renderReport(empty)).not.toContain("## Corrections & memory requests");
  });

  it("neutralises newlines in LLM-derived quotes", () => {
    const sneaky = {
      ...withInsights,
      insights: {
        ...withInsights.insights!,
        memoryRequestsNotHonored: ["line one\n# fake heading"],
      },
    };
    const md = renderReport(sneaky);
    expect(md).toContain("- memory request (not honored): line one # fake heading");
    expect(md).not.toMatch(/^# fake heading$/m);
  });

  it("caps the list at 10 entries with a footer", () => {
    const many = {
      ...withInsights,
      insights: {
        ...withInsights.insights!,
        memoryRequests: 14,
        memoryRequestsNotHonored: Array.from({ length: 14 }, (_, i) => `rule ${i}`),
      },
    };
    const md = renderReport(many);
    // 1 not-complied correction + 14 memory rules + 1 unrecovered error = 16
    expect(md).toContain("_Showing 10 of 16._");
    expect(md).not.toContain("rule 13");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- report`
Expected: FAIL — `insights` is not a property of `ReportInput`.

- [ ] **Step 3: Implement the section**

In `src/analysis/report.ts`, add the interface and extend `ReportInput`:

```ts
export interface ReportInsights {
  corrections: number;
  correctionsNotComplied: Array<{ what_agent_did: string; what_user_wanted: string }>;
  memoryRequests: number;
  memoryRequestsNotHonored: string[];
  unrecoveredErrors: Array<{ tool: string; error: string }>;
}

export interface ReportInput {
  date: string;
  windowDays: number | null;
  summaryCount: number;
  clusters: ReportCluster[];
  previousClusters: Array<{ name: string; size: number }>;
  outcomes: Record<string, number>;
  toolErrors: Array<{ tool: string; error: string; count: number }>;
  insights?: ReportInsights;
}
```

Add the section renderer:

```ts
const MAX_INSIGHT_LINES = 10;

// Lists only what the agent got wrong: those are the entries a prompt fix acts on.
function insightLines(i: ReportInsights): string[] {
  const entries = [
    ...i.correctionsNotComplied.map(
      (c) =>
        `- correction (not complied): ${inline(c.what_agent_did)} → ${inline(c.what_user_wanted)}`,
    ),
    ...i.memoryRequestsNotHonored.map((q) => `- memory request (not honored): ${inline(q)}`),
    ...i.unrecoveredErrors.map(
      (e) => `- unrecovered error: ${inline(e.tool)} — ${inline(e.error)}`,
    ),
  ];
  if (entries.length === 0) return [];
  const shown = entries.slice(0, MAX_INSIGHT_LINES);
  const lines = [
    "",
    "## Corrections & memory requests",
    "",
    `**Corrections: ${i.corrections}** (${i.correctionsNotComplied.length} not complied) · ` +
      `**Memory requests: ${i.memoryRequests}** (${i.memoryRequestsNotHonored.length} not honored) · ` +
      `**Unrecovered tool errors: ${i.unrecoveredErrors.length}**`,
    "",
    ...shown,
  ];
  if (entries.length > shown.length) {
    lines.push("", `_Showing ${shown.length} of ${entries.length}._`);
  }
  return lines;
}
```

In `renderReport`, insert the section between the tool-errors table and `"# Clusters"`. Change the tail of the `lines` array literal from:

```ts
    "",
    "# Clusters",
  ];
```

to:

```ts
    ...(input.insights ? insightLines(input.insights) : []),
    "",
    "# Clusters",
  ];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- report`
Expected: PASS.

- [ ] **Step 5: Feed insights into the report from `run.ts`**

In `src/analysis/run.ts`, before the `renderReport(` call, query the insights for the same window and tally them. Insert directly after the `const byId = new Map(...)` line:

```ts
      // Same window as `summaries`: join through session_summaries so the report's
      // insight counts describe exactly the sessions it clusters.
      const { rows: insightRows } = await pool.query<InsightRow>(
        `SELECT si.errors, si.corrections, si.memory_requests
         FROM session_insights si
         JOIN session_summaries ss ON ss.session_id = si.session_id
         WHERE ss.pii_check_passed
           AND ($1::int IS NULL OR ss.created_at > now() - make_interval(days => $1::int))`,
        [windowDays],
      );
```

Then add `insights: tallyInsights(insightRows),` to the `renderReport({ ... })` argument object, after `previousClusters`.

- [ ] **Step 6: Verify the full suite and build**

Run: `npm test && npm run lint && npm run build`
Expected: all PASS, 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/analysis/report.ts src/analysis/run.ts test/report.test.ts
git commit -m "feat(analysis): report corrections, memory requests and unrecovered errors"
```

---

### Task 6: Live verification and docs

**Files:**
- Modify: `CLAUDE.md` (the "Trace analysis" section)

**Interfaces:** none — this task ships no code.

**Prerequisite:** `TRACE_DATABASE_URL` must be in `pen-editor-backend/.env` (gitignored), pointing at the render.com Postgres with the `?sslmode=no-verify` suffix — `createPgPool` sets no explicit `ssl` and relies on node-postgres parsing `sslmode` from the URL.

- [ ] **Step 1: Run the analyzer against real data**

Run: `npm run analyze`

Expected in the log:
- `applied migrations: 002_insights.sql`
- `N session(s) to extract insights from` where N is the number of existing summaries (9 at the time of writing — the backfill)
- one `insights for tab-…` line per session
- `report written to reports/YYYY-MM-DD.md`

- [ ] **Step 2: Check the health-dashboard session**

That session (`tab-1784288486419-1`) is the real `unknown node id` failure. Confirm its insights are not empty and that `recovered` reflects what actually happened:

Write a throwaway script in the scratchpad (do NOT commit it) that connects with `pg` and prints:

```sql
SELECT errors, corrections, memory_requests, agent_claims
FROM session_insights WHERE session_id = 'tab-1784288486419-1'
```

Expected: at least one `errors` entry for `batch_design` / `unknown node id`. Its final turn is blind for this session (pre-fix trace, see Task 3), so absence of a final-turn error is explained, not a bug.

- [ ] **Step 3: Read the report**

Run: `cat reports/$(date +%F).md`
Expected: a `## Corrections & memory requests` section between the tool-errors table and `# Clusters`.

- [ ] **Step 4: Update `CLAUDE.md`**

In the "Trace analysis (`src/analysis/`, `src/tracing/`)" section, after the sentence describing what `npm run analyze` does, add:

```markdown
A second pass (`src/analysis/insights.ts`) extracts per-session `session_insights`
— tool errors with recovery status, user corrections, memory requests, and the
agent's own claims — as input for prompt improvement. Unlike the Clio summarizer
it MAY quote the user verbatim (in `user_quote`/`quote` only); everything stored
still passes through `scrubPii`. It runs in its own loop, so it backfills sessions
summarized before it existed — but only while their `raw_traces` rows survive
`TRACE_RAW_TTL_DAYS`.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe the session-insights pass"
```

---

## Notes for the executor

- Task 4 Step 4 imports `ReportInsights` from `report.js`, which Task 5 creates. **Execute Task 5 before Task 4's Step 4**, or add the `ReportInsights` interface to `report.ts` as the first thing you do in Task 4. Tasks 1-3 are independent of each other and of 4/5.
- Do not touch `summarize.ts` or its no-quotes prompt. The Clio artifact and the insights artifact are deliberately separate.
- Do not push. The user cuts releases with the `ship-release` skill.
