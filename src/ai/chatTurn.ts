import {
  convertToModelMessages,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type DynamicToolUIPart,
} from "ai";
import { randomUUID, createHash } from "node:crypto";
import type { Config } from "../config.js";
import { createModel } from "./provider.js";
import { penTools, makeBatchDesignTool } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveTaskPolicy, type TaskPolicy } from "./taskPolicy.js";
import { getMCPTools } from "./mcp.js";
import { getWebTools } from "./web-search.js";
import {
  detectSkillCommand,
  ensureSkillsLoaded,
  getAllSkills,
  getSkill,
  getSkillTools,
} from "./skills.js";

// Strips reasoning/thinking blocks and provider metadata from chat history.
// Some providers reject stale/invalid thinking signatures when prior assistant turns are replayed.
// Exported for unit testing; re-exported from routes/chat.js for backwards compatibility.
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

export interface PrepareChatTurnInput {
  config: Config;
  messages: Array<Record<string, unknown>>;
  canvasContext?: string;
  modelOverride?: string;
}

export interface PreparedChatTurn {
  model: LanguageModel;
  system: string;
  modelMessages: ModelMessage[];
  tools: ToolSet;
  taskPolicy: TaskPolicy;
  selectedModelId: string;
  systemPromptHash: string;
  /** Name of the skill named by the slash command on the current message, if any. */
  slashSkillName: string | undefined;
}

// Assembles everything streamText needs for a turn: slash-command skill
// detection/injection, the system prompt, sanitized/converted model
// messages, the resolved task policy, and the tool set. Shared by the
// /api/chat route and (soon) the standalone showcase-generation script, so
// neither can drift from the other's prompt/tool wiring.
//
// NOTE: this mutates the passed-in `messages` array in place (slash-command
// text stripping via a part mutation, and a `splice` to inject the synthetic
// lookup_skill pair). Callers that need to log/trace the "raw" incoming
// messages must capture that reference *before* calling this function if
// they want the un-mutated form — the /api/chat route intentionally does
// NOT do this today and traces the post-mutation array, so this preserves
// that observable behavior as-is.
export async function prepareChatTurn(
  input: PrepareChatTurnInput,
): Promise<PreparedChatTurn> {
  const { config, messages, canvasContext, modelOverride } = input;

  // Every skill lookup below — the slash command, the catalog in the system
  // prompt, the load_skill tool — silently resolves to nothing on an empty
  // map, so the turn must not be assembled before the skills are in memory.
  await ensureSkillsLoaded();

  // Detect slash command skill in last user message and resolve it
  let skillContent: string | undefined;
  // Name of the skill named by the CURRENT message's slash command (e.g.
  // "/prototype ..."), regardless of whether it resolved to a known skill —
  // used by resolveTaskPolicy below to route batch_design's embed-only guard.
  let slashSkillName: string | undefined;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === "user") {
    const parts = lastMsg.parts ?? lastMsg.content;

    // Extract the raw text and a setter to write back the stripped text
    let rawText: string | undefined;
    let setText: ((v: string) => void) | undefined;

    if (Array.isArray(parts)) {
      const textPart = parts.find(
        (p: Record<string, unknown>) =>
          p && typeof p === "object" && (p as { type?: string }).type === "text",
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
        slashSkillName = detected.skillName;
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

  const model = createModel(config, modelOverride);
  const skillCatalog = getAllSkills().map((s) => ({
    name: s.name,
    description: s.description,
  }));
  const system = buildSystemPrompt(canvasContext, skillCatalog);
  const selectedModelId = modelOverride ?? config.OPENROUTER_MODEL;
  const systemPromptHash = createHash("sha256")
    .update(system)
    .digest("hex")
    .slice(0, 16);

  const normalizedMessages = (() => {
    const sanitized = sanitizeMessagesForProvider(messages);
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

  // Structural backstop for prototype/slides: swap in the embed-only
  // batch_design variant so a native frame/rect/text create op is rejected
  // at the schema level instead of relying on prompting alone. Computed
  // from the incoming message history (including the synthetic
  // load_skill/lookup_skill pair injected above for a slash command) plus
  // the current slash command name, if any.
  const taskPolicy = resolveTaskPolicy({ messages, slashSkillName });

  const mcpTools = await getMCPTools(config);
  const tools = {
    ...penTools,
    ...getWebTools(config),
    ...mcpTools,
    ...getSkillTools(),
  } as ToolSet;
  if (taskPolicy !== "native") {
    tools.batch_design = makeBatchDesignTool({ embedOnly: true });
    delete tools.draw_vector;
  }

  return {
    model,
    system,
    modelMessages,
    tools,
    taskPolicy,
    selectedModelId,
    systemPromptHash,
    slashSkillName,
  };
}
