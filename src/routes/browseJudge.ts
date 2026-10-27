import type { FastifyInstance } from "fastify";
import { generateText, Output } from "ai";
import { z } from "zod";
import {
  QA_JUDGE_CONTEXT_MAX_CHARS,
  QA_JUDGE_PAGE_MAX_CHARS,
  QA_JUDGE_SYSTEM,
  QA_JUDGE_TIMEOUT_MS,
  buildQaJudgePrompt,
  parseQaJudgeVerdict,
  qaJudgeError,
  qaJudgeSchema,
  type QaJudgeInput,
} from "@sideform/browser-agent/agent";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";
import { abortOnClientDisconnect } from "./clientDisconnect.js";

// POST /api/browse/judge — the QA judge: decides pass / fail / inconclusive for
// a finished QA browse run (the frontend runs the browse itself). The client
// sends evidence only; the prompt is built here with buildQaJudgePrompt and
// never accepted from the client. Model failures answer 200 { error } so the
// client treats them as a judge error, not an HTTP failure.

const jsonLen = (v: unknown): number => JSON.stringify(v)?.length ?? 0;
const cappedStrings = z.array(z.string().max(500)).max(20).optional();
// Whitespace collapsed to one line, then cut (not rejected): these values come from the tested page.
const oneLine = (max: number) => z.string().transform((v) => v.replace(/\s+/g, " ").trim().slice(0, max));

// z.object strips unknown keys (e.g. a client-supplied verdict inside qa).
// Oversized page fields are truncated, not rejected: the evidence is still
// useful and the judge sees `truncated`.
const bodySchema = z.object({
  scenario: z.string().min(1).max(8000),
  context: z.string().max(QA_JUDGE_CONTEXT_MAX_CHARS).optional(),
  qa: z.object({
    steps: z
      .array(
        z.object({
          index: z.number(),
          tool: z.string(),
          args: z.unknown().refine((a) => jsonLen(a) <= 2000, "step args too large"),
          ok: z.boolean(),
          error: z.string().max(500).optional(),
        }),
      )
      .max(30),
    stepsDropped: z.number().int().optional(),
    // QaCheckRecord: the recorder has no cap (10 per qa_assert call plus finals).
    checks: z
      .array(
        z.object({
          source: z.enum(["agent", "final"]),
          check: z
            .object({})
            .passthrough()
            .refine((c) => jsonLen(c) <= 2000, "check too large"),
          passed: z.boolean(),
          actual: z.string().optional(),
          error: z.string().optional(),
          // The element a check by `index` named (package cap: 80 chars). One line: page text must not forge a check line.
          target: oneLine(80).optional(),
        }),
      )
      .max(400)
      .optional(),
    // URL and title of the page at the agent's last qa_assert; cut, not rejected.
    pageAtCheck: z.object({ url: oneLine(4096), title: oneLine(1024) }).optional(),
    consoleErrors: cappedStrings,
    consoleErrorsDropped: z.number().int().optional(),
    failedRequests: cappedStrings,
    failedRequestsDropped: z.number().int().optional(),
  }),
  page: z
    .object({
      url: z.string().transform((v) => v.slice(0, 4096)),
      title: z.string().transform((v) => v.slice(0, 1024)),
      text: z.string(),
      truncated: z.boolean().optional(),
    })
    .transform((p) =>
      p.text.length > QA_JUDGE_PAGE_MAX_CHARS
        ? { ...p, text: p.text.slice(0, QA_JUDGE_PAGE_MAX_CHARS), truncated: true }
        : p,
    ),
});

export async function browseJudgeRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.post(
    "/api/browse/judge",
    {
      bodyLimit: 160 * 1024,
      // One model call per finished QA run — same budget as /api/browse/plan.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      // Disabled answers for any body (the body limit still applies).
      if (config.QA_JUDGE_MODEL === "off") {
        return reply.send({ disabled: true });
      }
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const gone = abortOnClientDisconnect(reply);
      try {
        const { output: object } = await generateText({
          model: createModel(config, config.QA_JUDGE_MODEL),
          output: Output.object({ schema: qaJudgeSchema }),
          instructions: QA_JUDGE_SYSTEM,
          prompt: buildQaJudgePrompt(parsed.data as QaJudgeInput),
          maxOutputTokens: 400,
          maxRetries: 0,
          abortSignal: AbortSignal.any([gone.signal, AbortSignal.timeout(QA_JUDGE_TIMEOUT_MS)]),
        });
        // generateText + Output.object already validated the object; the parser here only
        // trims and cuts a long reason.
        const verdict = parseQaJudgeVerdict(object);
        if (!verdict.ok) {
          // Unreachable after schema validation; kept for the type narrowing.
          return reply.send(qaJudgeError(new Error(verdict.errors.join("; "))));
        }
        app.log.info({ browseJudge: { verdict: verdict.value.verdict } }, "qa judge answered");
        return reply.send(verdict.value);
      } catch (err) {
        if (gone.signal.aborted) {
          app.log.info({ browseJudge: { clientGone: true } }, "qa judge: client gone");
        } else {
          // Never log the scenario or page text; the error message only.
          app.log.warn({ browseJudge: { error: err instanceof Error ? err.message : String(err) } }, "qa judge failed");
        }
        return reply.send(qaJudgeError(err));
      }
    },
  );
}
