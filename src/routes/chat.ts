import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  NoSuchToolError,
  InvalidToolInputError,
  type UIMessage,
  type ToolSet,
  type DynamicToolUIPart,
} from "ai";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getAllowedModels,
  isOriginAllowed,
  parseEnvList,
  type Config,
} from "../config.js";
import { createModel } from "../ai/provider.js";
import { penTools } from "../ai/tools.js";
import { AGENT_MODES, buildSystemPrompt } from "../ai/system-prompt.js";
import { getMCPTools } from "../ai/mcp.js";
import { getWebTools } from "../ai/web-search.js";
import { logSession, type LogStep } from "../logging.js";
import { randomUUID, createHash } from "node:crypto";
import { detectSkillCommand, getAllSkills, getSkill } from "../ai/skills.js";
import { writeRawTraceSafe, type TraceStore } from "../tracing/traceStore.js";

// Maximum image parts per single message (not per conversation).
const MAX_IMAGE_PARTS = 4;

// pipeUIMessageStreamToResponse masks every stream error to a generic
// "An error occurred." by default (so server internals never leak to the
// client). But that also hides our own actionable tool-input validation
// messages — e.g. batch_design's "Too many operations (30). Maximum is 25.
// Split the work into multiple sequential batch_design calls." — from the
// model, so it gets a dead-end instead of guidance it could act on. Surface the
// message for tool-call validation errors only (safe, model-facing guidance);
// keep the generic mask for everything else.
export function streamErrorMessage(error: unknown): string {
  if (
    NoSuchToolError.isInstance(error) ||
    InvalidToolInputError.isInstance(error)
  ) {
    return error.message;
  }
  return "An error occurred.";
}
const MAX_AGENT_STEPS = {
  research: 15,
  default: 12,
} as const;

const chatBodySchema = z.object({
  id: z.string().max(200).optional(),
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
  model: z.string().optional(),
  agentMode: z.enum(AGENT_MODES).optional(),
});

// Strips reasoning/thinking blocks and provider metadata from chat history.
// Some providers reject stale/invalid thinking signatures when prior assistant turns are replayed.
// Exported for unit testing.
export function sanitizeMessagesForProvider(
  rawMessages: Array<Record<string, unknown>>,
): { messages: Array<Record<string, unknown>>; removedReasoningParts: number } {
  let removedReasoningParts = 0;

  const sanitizeBlocks = (blocksRaw: unknown): unknown => {
    if (!Array.isArray(blocksRaw)) return blocksRaw;

    return blocksRaw
      .filter((block) => {
        if (!block || typeof block !== "object") return true;
        const type = (block as { type?: unknown }).type;
        const isReasoningLike =
          type === "reasoning" ||
          type === "thinking" ||
          type === "redacted_thinking";
        if (isReasoningLike) removedReasoningParts += 1;
        return !isReasoningLike;
      })
      .map((block) => {
        if (!block || typeof block !== "object") return block;
        const cleaned = { ...(block as Record<string, unknown>) };
        delete cleaned.providerMetadata;
        delete cleaned.callProviderMetadata;
        return cleaned;
      });
  };

  const messages = rawMessages.map((message) => {
    const sanitizedMessage = { ...message };
    if ("parts" in sanitizedMessage) {
      sanitizedMessage.parts = sanitizeBlocks(sanitizedMessage.parts);
    }
    if ("content" in sanitizedMessage) {
      sanitizedMessage.content = sanitizeBlocks(sanitizedMessage.content);
    }
    return sanitizedMessage;
  });

  return { messages, removedReasoningParts };
}

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

    // Detect slash command skill in last user message and resolve it
    let skillContent: string | undefined;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      const parts = lastMsg.parts ?? lastMsg.content;

      // Extract the raw text and a setter to write back the stripped text
      let rawText: string | undefined;
      let setText: ((v: string) => void) | undefined;

      if (Array.isArray(parts)) {
        const textPart = parts.find(
          (p: Record<string, unknown>) =>
            p &&
            typeof p === "object" &&
            (p as { type?: string }).type === "text",
        ) as { type: string; text: string } | undefined;
        if (textPart?.text) {
          rawText = textPart.text;
          setText = (v) => {
            textPart.text = v;
          };
        }
      } else if (typeof parts === "string") {
        rawText = parts;
        const key = "parts" in lastMsg ? "parts" : "content";
        setText = (v) => {
          (lastMsg as Record<string, unknown>)[key] = v;
        };
      }

      if (rawText && setText) {
        const detected = detectSkillCommand(rawText);
        if (detected) {
          const skill = getSkill(detected.skillName);
          // Unknown "/..." (a pasted path, "/как дела") is not an error —
          // the message passes through as plain text.
          if (skill) {
            skillContent = skill.content;
            setText(detected.userText);
          }
        }
      }
    }

    // When a skill is detected, inject a synthetic tool call + result
    // right before the last user message so the AI sees skill instructions
    // without changing the system prompt (preserves prompt caching).
    // This must be a valid UIMessage: convertToModelMessages expands the
    // dynamic-tool part into an assistant tool-call plus a tool result
    // message (and throws on raw ModelMessage roles like "tool").
    if (skillContent) {
      const skillToolPart: DynamicToolUIPart = {
        type: "dynamic-tool",
        toolName: "lookup_skill",
        toolCallId: `skill-${randomUUID()}`,
        state: "output-available",
        input: {},
        output: `Follow these instructions for the current task:\n\n${skillContent}`,
      };
      const skillMsg: Record<string, unknown> = {
        role: "assistant",
        parts: [skillToolPart],
      };
      messages.splice(messages.length - 1, 0, skillMsg);
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

    const model = createModel(config, modelOverride);
    const system = buildSystemPrompt(canvasContext, agentMode);
    const selectedModelId = modelOverride ?? config.OPENROUTER_MODEL;
    const traceSessionId = chatSessionId ?? `anon-${randomUUID()}`;
    const systemPromptHash = createHash("sha256")
      .update(system)
      .digest("hex")
      .slice(0, 16);
    const normalizedMessages = (() => {
      const sanitized = sanitizeMessagesForProvider(
        messages as Array<Record<string, unknown>>,
      );
      if (sanitized.removedReasoningParts > 0) {
        console.warn(
          `[chat] Sanitized ${sanitized.removedReasoningParts} reasoning/thinking part(s) for model "${selectedModelId}".`,
        );
      }
      return sanitized.messages;
    })();

    const modelMessages = await convertToModelMessages(
      normalizedMessages as unknown as UIMessage[],
    );

    const mcpTools = await getMCPTools(config);
    const isResearch = agentMode === "research";
    if (isResearch && Object.keys(mcpTools).length === 0) {
      return reply.status(503).send({
        error:
          "Research mode is unavailable: no MCP tools are connected. Check REFERO_API_KEY and MCP connectivity.",
      });
    }
    const tools = isResearch
      ? (mcpTools as ToolSet)
      : { ...penTools, ...getWebTools(config), ...mcpTools };
    const maxSteps = isResearch
      ? MAX_AGENT_STEPS.research
      : MAX_AGENT_STEPS.default;

    // Abort the LLM stream when the client disconnects mid-response, so we
    // stop paying for tokens nobody will receive.
    const abortController = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
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
          writeRawTraceSafe(traceStore, {
            sessionId: traceSessionId,
            model: selectedModelId,
            agentMode,
            payload: {
              messages: messages as unknown[],
              steps: [],
              systemPromptHash,
            },
            streamError: "client-aborted",
            inputTokens: 0,
            outputTokens: 0,
          });
        }
      },
      onFinish({ usage, steps }) {
        console.log(
          `[tokens] input: ${usage.inputTokens}, output: ${usage.outputTokens}, cache read: ${usage.inputTokenDetails?.cacheReadTokens ?? "n/a"}`,
        );

        const logSteps: LogStep[] = steps.map((step, i) => ({
          stepNumber: i,
          text: step.text,
          toolCalls: step.toolCalls.map((tc: Record<string, unknown>) => ({
            toolName: String(tc.toolName ?? ""),
            args: (tc.args ?? {}) as Record<string, unknown>,
          })),
          toolResults: step.toolResults.map(
            (tr: Record<string, unknown>) => ({
              toolName: String(tr.toolName ?? ""),
              result: tr.result,
            }),
          ),
          finishReason: step.finishReason,
          usage: {
            inputTokens: step.usage.inputTokens ?? 0,
            outputTokens: step.usage.outputTokens ?? 0,
          },
        }));

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
          writeRawTraceSafe(traceStore, {
            sessionId: traceSessionId,
            model: selectedModelId,
            agentMode,
            payload: {
              // Full incoming history: client-tool results/errors from prior
              // turns live here; storing the system prompt itself is redundant
              // (hash identifies the prompt version).
              messages: messages as unknown[],
              steps: logSteps,
              systemPromptHash,
            },
            streamError: null,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
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
          writeRawTraceSafe(traceStore, {
            sessionId: traceSessionId,
            model: selectedModelId,
            agentMode,
            payload: { messages: messages as unknown[], steps: [], systemPromptHash },
            streamError: error instanceof Error ? error.message : String(error),
            inputTokens: 0,
            outputTokens: 0,
          });
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
