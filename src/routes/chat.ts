import {
  streamText,
  stepCountIs,
  NoSuchToolError,
  InvalidToolInputError,
  type ToolSet,
  type StepResult,
} from "ai";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getAllowedModels,
  isOriginAllowed,
  parseEnvList,
  type Config,
} from "../config.js";
import { AGENT_MODES } from "../ai/system-prompt.js";
import { logSession, type LogStep } from "../logging.js";
import { randomUUID } from "node:crypto";
import { getAllSkills } from "../ai/skills.js";
import { writeRawTraceSafe, type TraceStore } from "../tracing/traceStore.js";
import {
  prepareChatTurn,
  sanitizeMessagesForProvider,
} from "../ai/chatTurn.js";

// Re-exported for backwards compatibility: existing tests import this
// symbol from routes/chat.js. The implementation now lives in
// ai/chatTurn.ts (shared with the standalone showcase-generation script).
export { sanitizeMessagesForProvider };

// Maximum image parts per single message (not per conversation).
const MAX_IMAGE_PARTS = 4;

// pipeUIMessageStreamToResponse masks every stream error to a generic
// "An error occurred." by default (so server internals never leak to the
// client). But that also hides our own actionable tool-input validation
// messages — e.g. batch_design's embed-only guard, 'Prototype/slides flow
// is embed-only: batch_design may not create a native "frame" node.' — from
// the model, so it gets a dead-end instead of guidance it could act on. Surface
// the message for tool-call validation errors only (safe, model-facing
// guidance); keep the generic mask for everything else.
export function streamErrorMessage(error: unknown): string {
  if (
    NoSuchToolError.isInstance(error) ||
    InvalidToolInputError.isInstance(error)
  ) {
    return error.message;
  }
  return "An error occurred.";
}
const MAX_AGENT_STEPS = 12;

// Shared by onFinish/onAbort: turns AI SDK step results into the trimmed
// shape used for both session logging (logSteps) and trace payloads.
function mapSteps(steps: readonly StepResult<ToolSet>[]): LogStep[] {
  return steps.map((step, i) => ({
    stepNumber: i,
    text: step.text,
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
    finishReason: step.finishReason,
    usage: {
      inputTokens: step.usage.inputTokens ?? 0,
      outputTokens: step.usage.outputTokens ?? 0,
    },
  }));
}

const chatBodySchema = z.object({
  id: z.string().max(200).optional(),
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
  model: z.string().optional(),
  agentMode: z.enum(AGENT_MODES).optional(),
});

export async function chatRoutes(
  app: FastifyInstance,
  config: Config,
  traceStore: TraceStore | null = null,
) {
  const allowedModels = getAllowedModels(config);
  const allowedOrigins = parseEnvList(config.CORS_ALLOWED_ORIGINS);

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        details: parsed.error.format(),
      });
    }

    const {
      id: chatSessionId,
      messages,
      canvasContext,
      model: modelOverride,
      agentMode = "edits",
    } = parsed.data;

    if (modelOverride && !allowedModels.includes(modelOverride)) {
      return reply.status(400).send({
        error: `Model "${modelOverride}" is not allowed. Allowed models: ${allowedModels.join(", ")}`,
      });
    }

    const maxImagesInOneMessage = messages.reduce((max, msg) => {
      const parts = msg.parts;
      if (!Array.isArray(parts)) return max;
      const count = parts.filter(
        (p) =>
          p &&
          typeof p === "object" &&
          ((p as { type?: unknown }).type === "file" ||
            (p as { type?: unknown }).type === "image"),
      ).length;
      return Math.max(max, count);
    }, 0);
    if (maxImagesInOneMessage > MAX_IMAGE_PARTS) {
      return reply.status(400).send({
        error: `Too many images in a single message: ${maxImagesInOneMessage} attached, maximum is ${MAX_IMAGE_PARTS} per message`,
      });
    }

    const traceSessionId = chatSessionId ?? `anon-${randomUUID()}`;

    const {
      model,
      system,
      modelMessages,
      tools,
      taskPolicy,
      selectedModelId,
      systemPromptHash,
    } = await prepareChatTurn({
      config,
      messages,
      canvasContext,
      modelOverride,
    });
    const maxSteps = MAX_AGENT_STEPS;

    // Abort the LLM stream when the client disconnects mid-response, so we
    // stop paying for tokens nobody will receive.
    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
    });

    // Builds the trace-store row shape; the only bits that vary per callback
    // are the mapped steps, the stream-error label, and token usage.
    const buildTraceRow = (
      steps: LogStep[],
      streamError: string | null,
      usage?: { inputTokens?: number; outputTokens?: number },
    ) => ({
      sessionId: traceSessionId,
      model: selectedModelId,
      agentMode,
      payload: {
        // Full incoming history: client-tool results/errors from prior turns
        // live here; storing the system prompt itself is redundant (hash
        // identifies the prompt version).
        messages: messages as unknown[],
        steps,
        systemPromptHash,
        resolvedTaskPolicy: taskPolicy,
      },
      streamError,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    });

    const result = streamText({
      model,
      system,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(maxSteps),
      abortSignal: abortController.signal,
      onAbort({ steps }) {
        console.log(
          `[chat] Client disconnected; aborted stream after ${steps.length} step(s).`,
        );

        if (traceStore) {
          writeRawTraceSafe(
            traceStore,
            buildTraceRow(mapSteps(steps), "client-aborted"),
          );
        }
      },
      onFinish({ usage, steps }) {
        console.log(
          `[tokens] input: ${usage.inputTokens}, output: ${usage.outputTokens}, cache read: ${usage.inputTokenDetails?.cacheReadTokens ?? "n/a"}`,
        );

        // Only pay for the step-mapping work when something will consume it.
        const logSteps =
          traceStore || config.ENABLE_AGENT_LOGGING ? mapSteps(steps) : [];

        if (config.ENABLE_AGENT_LOGGING) {
          logSession({
            sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            model: selectedModelId,
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

        if (traceStore) {
          writeRawTraceSafe(
            traceStore,
            buildTraceRow(logSteps, null, {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
            }),
          );
        }
      },
    });

    // Set CORS headers manually since reply.hijack() bypasses Fastify plugins.
    // Only reflect origins from the allowlist (empty allowlist = dev mode, allow any).
    const origin = request.headers.origin;
    reply.raw.setHeader("Vary", "Origin");
    if (origin && isOriginAllowed(allowedOrigins, origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    }

    // Pipe the UI message stream directly to the raw Node.js response,
    // bypassing Fastify's send() which can't handle object streams.
    result.pipeUIMessageStreamToResponse(reply.raw, {
      onError: (error) => {
        if (traceStore) {
          writeRawTraceSafe(
            traceStore,
            buildTraceRow(
              [],
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        return streamErrorMessage(error);
      },
    });

    // Tell Fastify we already handled the response.
    reply.hijack();
  });

  app.get("/api/skills", async (_request, reply) => {
    const skills = getAllSkills().map((s) => ({
      name: s.name,
      description: s.description,
    }));
    return reply.send({ skills });
  });
}
