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
