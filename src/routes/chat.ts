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
import type { MemoryStore } from "../ai/memory/store.js";
import { runReviewSafe } from "../ai/selfimprove/review.js";
import { isPlausibleUserId } from "../lib/userId.js";
import type { LearnedSkillStore } from "../ai/skills/learnedStore.js";
import type { TraceQueryable } from "../tracing/traceStore.js";

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
  // Client-generated stable anonymous id (localStorage `pen.userId`). Absent
  // → every memory feature is silently off for this request, which is what
  // keeps the showcase runner and any older client working untouched. The
  // 1..64 bound here is only a coarse sanity/DoS guard (still 400s a grossly
  // malformed value like a 65-char string) — the actual UUID-shape check
  // (isPlausibleUserId) runs AFTER this parse succeeds and, on failure,
  // treats the id as absent rather than 400ing: an older/malformed client
  // must silently fall back to a memory-free turn, not get an error for a
  // field it doesn't know the shape contract of.
  userId: z.string().min(1).max(64).optional(),
});

export async function chatRoutes(
  app: FastifyInstance,
  config: Config,
  traceStore: TraceStore | null = null,
  memoryStore: MemoryStore | null = null,
  // Phase 2 (self-authored skills): learnedSkillStore feeds the catalog
  // merge + load_skill/skill_manage's read side; auditDb is skill_manage/
  // skill_view's own handle for agent_selfimprove_audit writes. Both null by
  // default so every existing caller (tests, ad hoc scripts) is unaffected.
  learnedSkillStore: LearnedSkillStore | null = null,
  auditDb: TraceQueryable | null = null,
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
      userId: rawUserId,
    } = parsed.data;

    // A shape-invalid userId (e.g. an older client, or a malformed value)
    // is treated as absent rather than rejected — see the field's doc
    // comment on chatBodySchema above.
    const userId = rawUserId && isPlausibleUserId(rawUserId) ? rawUserId : undefined;

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
      userId,
      memoryStore,
      learnedSkillStore,
      auditDb,
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

        // Fire-and-forget: the response has already streamed. `memoryStore`
        // is the counters/audit table handle shared by BOTH subsystems (see
        // app.ts — it is constructed whenever MEMORY_ENABLED OR
        // SELF_SKILLS_ENABLED is on, since agent_review_state holds both
        // counters in one row), so it can be non-null here even on a turn
        // where memory itself was not injected (skills-only). maybeRunReview
        // does its own per-subsystem flag/due checks; this gate is only the
        // cheap "is there anywhere to write at all" precondition — the
        // showcase runner and every headless entry point never reach it.
        if (userId && memoryStore) {
          // The client auto-resends on every client-executed tool call
          // (`lastAssistantMessageIsCompleteWithToolCalls`), so one user
          // message can be many `POST /api/chat` requests. A request whose
          // final step still has tool calls is a continuation — the model
          // handed work back to the browser and this request never produced
          // a reply the user actually saw — so only a step-less final step
          // counts as a completed user turn. See the `turnComplete` doc
          // comment on MaybeRunReviewInput for what this fixes.
          const lastStep = steps[steps.length - 1];
          const turnComplete = !lastStep || lastStep.toolCalls.length === 0;
          runReviewSafe({
            config,
            store: memoryStore,
            userId,
            system,
            turnTools: tools,
            modelMessages,
            assistantText: steps.map((s) => s.text).join("\n").trim(),
            stepCount: steps.length,
            modelOverride,
            turnComplete,
            learnedSkillStore,
            auditDb,
          });
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
