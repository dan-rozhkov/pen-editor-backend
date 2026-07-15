import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { containsPii, scrubPii } from "./pii.js";

export const sessionSummarySchema = z.object({
  user_goal: z
    .string()
    .describe("What the user was trying to accomplish, as a general pattern"),
  summary: z
    .string()
    .describe("What happened in the session: agent actions, failures, recovery"),
  outcome: z.enum(["success", "partial", "failure", "unclear"]),
  tool_errors: z.array(
    z.object({
      tool: z.string().describe("Tool name"),
      error: z.string().describe("Error category, not the verbatim message"),
    }),
  ),
  frustration: z
    .boolean()
    .describe("User showed frustration (repeats, complaints, giving up)"),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

// Clio principle: the summary describes BEHAVIOR PATTERNS, never content.
const SUMMARIZER_SYSTEM = `You analyze a trace of a session between a user and an AI design agent that edits a canvas via tools.

Produce a structured summary for aggregate analysis. STRICT PRIVACY RULES:
- Never include personal names, emails, phone numbers, addresses, company names, or credentials.
- Never quote user text verbatim. Describe what the user did, not what they wrote.
- Describe design content generically ("a landing page hero", "a pricing table"), never specific copy.
- tool_errors: report the tool name and a short error CATEGORY (e.g. "operation limit exceeded", "unknown node id"), not raw error payloads.`;

async function summarizeOnce(
  model: LanguageModel,
  sessionText: string,
): Promise<SessionSummary> {
  const { object } = await generateObject({
    model,
    schema: sessionSummarySchema,
    system: SUMMARIZER_SYSTEM,
    prompt: scrubPii(sessionText),
  });
  return object;
}

function summaryText(s: SessionSummary): string {
  return [s.user_goal, s.summary, ...s.tool_errors.map((e) => `${e.tool} ${e.error}`)].join("\n");
}

function scrubSummary(s: SessionSummary): SessionSummary {
  return {
    ...s,
    user_goal: scrubPii(s.user_goal),
    summary: scrubPii(s.summary),
    tool_errors: s.tool_errors.map((e) => ({
      tool: scrubPii(e.tool),
      error: scrubPii(e.error),
    })),
  };
}

export async function summarizeWithPiiGuard(
  model: LanguageModel,
  sessionText: string,
  maxRetries = 2,
): Promise<{ summary: SessionSummary; piiCheckPassed: boolean }> {
  let last: SessionSummary | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await summarizeOnce(model, sessionText);
    if (!containsPii(summaryText(last))) {
      return { summary: last, piiCheckPassed: true };
    }
  }
  // Last resort: hard-scrub the fields so nothing raw persists, and flag it.
  return { summary: scrubSummary(last!), piiCheckPassed: false };
}
