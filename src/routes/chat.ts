import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type ToolSet,
} from "ai";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";
import { penTools } from "../ai/tools.js";
import { AGENT_MODES, buildSystemPrompt } from "../ai/system-prompt.js";
import { getMCPTools } from "../ai/mcp.js";
import { logSession, type LogStep } from "../logging.js";
import { randomUUID } from "node:crypto";
import { detectSkillCommand, getAllSkills, getSkill } from "../ai/skills.js";

const MAX_IMAGE_PARTS = 3;
const MAX_AGENT_STEPS = {
  research: 15,
  default: 12,
} as const;

const chatBodySchema = z.object({
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
  model: z.string().optional(),
  agentMode: z.enum(AGENT_MODES).optional(),
});

// Strips reasoning/thinking blocks and provider metadata from chat history.
// Some providers reject stale/invalid thinking signatures when prior assistant turns are replayed.
function sanitizeMessagesForProvider(
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
          type === "reasoning" || type === "thinking" || type === "redacted_thinking";
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
          (p: Record<string, unknown>) => p && typeof p === "object" && (p as { type?: string }).type === "text",
        ) as { type: string; text: string } | undefined;
        if (textPart?.text) {
          rawText = textPart.text;
          setText = (v) => { textPart.text = v; };
        }
      } else if (typeof parts === "string") {
        rawText = parts;
        const key = "parts" in lastMsg ? "parts" : "content";
        setText = (v) => { (lastMsg as Record<string, unknown>)[key] = v; };
      }

      if (rawText && setText) {
        const detected = detectSkillCommand(rawText);
        if (detected) {
          const skill = getSkill(detected.skillName);
          if (!skill) {
            return reply.status(400).send({
              error: `Unknown skill: /${detected.skillName}`,
            });
          }
          skillContent = skill.content;
          setText(detected.userText);
        }
      }
    }

    // When a skill is detected, inject a synthetic tool call + result pair
    // right before the last user message so the AI sees skill instructions
    // without changing the system prompt (preserves prompt caching).
    if (skillContent) {
      const toolCallId = `skill-${randomUUID()}`;
      const assistantMsg: Record<string, unknown> = {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "lookup_skill",
            args: {},
          },
        ],
      };
      const toolResultMsg: Record<string, unknown> = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "lookup_skill",
            result: `Follow these instructions for the current task:\n\n${skillContent}`,
          },
        ],
      };
      messages.splice(messages.length - 1, 0, assistantMsg, toolResultMsg);
    }

    const imagePartCount = messages.reduce((count, msg) => {
      const parts = msg.parts;
      if (!Array.isArray(parts)) return count;
      return count + parts.filter((p) =>
        p && typeof p === "object" &&
        ((p as { type?: unknown }).type === "file" || (p as { type?: unknown }).type === "image"),
      ).length;
    }, 0);
    if (imagePartCount > MAX_IMAGE_PARTS) {
      return reply.status(400).send({
        error: `Too many images: ${imagePartCount} attached, maximum is ${MAX_IMAGE_PARTS}`,
      });
    }

    const model = createModel(config, modelOverride);
    const system = buildSystemPrompt(canvasContext, agentMode);
    const selectedModelId = modelOverride ?? config.OPENROUTER_MODEL;
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
      normalizedMessages as unknown as UIMessage[]
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
      : { ...penTools, ...mcpTools };
    const maxSteps = isResearch
      ? MAX_AGENT_STEPS.research
      : MAX_AGENT_STEPS.default;

    const result = streamText({
      model,
      system,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(maxSteps),
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

  app.get("/api/skills", async (_request, reply) => {
    const skills = getAllSkills().map((s) => ({
      name: s.name,
      description: s.description,
    }));
    return reply.send({ skills });
  });
}
