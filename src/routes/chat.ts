import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";
import { penTools } from "../ai/tools.js";
import { buildSystemPrompt } from "../ai/system-prompt.js";
import { logSession, type LogStep } from "../logging.js";

const chatBodySchema = z.object({
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
  model: z.string().optional(),
  agentMode: z.enum(["edits", "fast"]).optional(),
});

function hasDesignSystemGuidelinesCall(
  steps: Array<{
    toolCalls?: Array<{
      toolName?: string;
      args?: unknown;
      input?: unknown;
    }>;
  }>,
): boolean {
  return steps.some((step) =>
    (step.toolCalls ?? []).some((call) => {
      if (call.toolName !== "get_guidelines") return false;

      const payload = (call.args ?? call.input ?? {}) as { topic?: string };
      return payload.topic === "design-system";
    }),
  );
}

export async function chatRoutes(app: FastifyInstance, config: Config) {
  app.post("/api/chat", async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.format(),
      });
    }

    const {
      messages,
      canvasContext,
      model: modelOverride,
      agentMode = "edits",
    } = parsed.data;
    const model = createModel(config, modelOverride);
    const system = buildSystemPrompt(canvasContext, agentMode);

    const modelMessages = await convertToModelMessages(
      messages as unknown as UIMessage[]
    );
    const allToolNames = Object.keys(penTools) as Array<keyof typeof penTools>;
    const toolsWithoutBatchDesign = allToolNames.filter(
      (toolName) => toolName !== "batch_design",
    );
    const mandatoryEditsInstruction =
      `${system}\n\n` +
      "MANDATORY TOOL RULE: You must call get_guidelines with topic=\"design-system\" " +
      "before your first batch_design call. Until then, batch_design is unavailable.";
    const mandatoryFastInstruction =
      `${system}\n\n` +
      "MANDATORY FAST TOOL RULES:\n" +
      "1) You must call get_guidelines with topic=\"design-system\".\n" +
      "2) You must call get_variables.\n" +
      "3) You must call find_empty_space_on_canvas with the intended embed width/height.\n" +
      "Only after all three are completed, batch_design becomes available.";

    const result = streamText({
      model,
      system,
      messages: modelMessages,
      tools: penTools,
      prepareStep: ({ steps }) => {
        const typedSteps = steps as Array<{
          toolCalls?: Array<{
            toolName?: string;
            args?: unknown;
            input?: unknown;
          }>;
        }>;
        const guidelinesLoaded = hasDesignSystemGuidelinesCall(typedSteps);

        if (agentMode === "fast") {
          const hasVariablesCall = typedSteps.some((step) =>
            (step.toolCalls ?? []).some((call) => call.toolName === "get_variables"),
          );
          const hasFindEmptySpaceCall = typedSteps.some((step) =>
            (step.toolCalls ?? []).some(
              (call) => call.toolName === "find_empty_space_on_canvas",
            ),
          );

          if (!guidelinesLoaded || !hasVariablesCall || !hasFindEmptySpaceCall) {
            return {
              activeTools: toolsWithoutBatchDesign,
              system: mandatoryFastInstruction,
            };
          }
        } else if (!guidelinesLoaded) {
          return {
            activeTools: toolsWithoutBatchDesign,
            system: mandatoryEditsInstruction,
          };
        }

        return {
          activeTools: allToolNames,
        };
      },
      stopWhen: stepCountIs(agentMode === "fast" ? 6 : 3),
      onFinish({ usage, steps }) {
        console.log(
          `[tokens] input: ${usage.inputTokens}, output: ${usage.outputTokens}, cache read: ${usage.inputTokenDetails?.cacheReadTokens ?? "n/a"}`
        );

        if (config.ENABLE_AGENT_LOGGING) {
          const logSteps: LogStep[] = steps.map((step, i) => ({
            stepNumber: i,
            text: step.text,
            toolCalls: step.toolCalls.map((tc: Record<string, unknown>) => ({
              toolName: String(tc.toolName ?? ""),
              args: (tc.args ?? {}) as Record<string, unknown>,
            })),
            toolResults: step.toolResults.map((tr: Record<string, unknown>) => ({
              toolName: String(tr.toolName ?? ""),
              result: tr.result,
            })),
            finishReason: step.finishReason,
            usage: {
              inputTokens: step.usage.inputTokens ?? 0,
              outputTokens: step.usage.outputTokens ?? 0,
            },
          }));

          logSession({
            sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            model: modelOverride ?? config.OPENROUTER_MODEL,
            systemPrompt: system,
            messages: messages as unknown[],
            steps: logSteps,
            totalUsage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
            },
          }).catch((err) => {
            console.error("[logging] Failed to write session log:", err);
          });
        }
      },
    });

    // Set CORS headers manually since reply.hijack() bypasses Fastify plugins.
    const origin = request.headers.origin;
    if (origin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
    }

    // Pipe the UI message stream directly to the raw Node.js response,
    // bypassing Fastify's send() which can't handle object streams.
    result.pipeUIMessageStreamToResponse(reply.raw);

    // Tell Fastify we already handled the response.
    reply.hijack();
  });
}
