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
import { penTools, makeBatchDesignTool, makeAnalyzeImageTool } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveTaskPolicy, type TaskPolicy } from "./taskPolicy.js";
import { applyVisionPreprocessing, modelSupportsVision } from "./vision-messages.js";
import { isVisionConfigured } from "../services/vision.js";
import { getMCPTools } from "./mcp.js";
import { getWebTools } from "./web-search.js";
import {
  detectSkillCommand,
  ensureSkillsLoaded,
  getAllSkills,
  getSkill,
  getSkillTools,
} from "./skills.js";
import { renderMemorySnapshot } from "./memory/render.js";
import { createMemoryToolContext, getMemoryTools } from "./memory/tool.js";
import type { MemoryStore } from "./memory/store.js";
import { getLearnedCatalog, type LearnedSkill, type LearnedSkillStore } from "./skills/learnedStore.js";
import { createSkillRunContext } from "./skills/runContext.js";
import { getSelfSkillTools } from "./skills/tool.js";
import type { TraceQueryable } from "../tracing/traceStore.js";

// Bounds the memory-snapshot read on top of (not instead of) the pool's own
// connectionTimeoutMillis (src/tracing/traceStore.ts): that setting only
// covers acquiring a connection, but a connection that IS acquired can still
// hang mid-query if the network black-holes packets after the handshake
// (no RST, so the client never sees a rejected promise). Racing the read
// against a short local timer is what actually caps every request's worst
// case, since a hang here — not an exception — is exactly what a plain
// try/catch cannot degrade from.
const MEMORY_SNAPSHOT_TIMEOUT_MS = 2_000;

// Same reasoning as MEMORY_SNAPSHOT_TIMEOUT_MS: the learned-skill catalog
// read (getLearnedCatalog) sits in this same hot path, so a hung — not
// merely erroring — Postgres connection must not hold the request open
// forever either. getLearnedCatalog already catches thrown errors and falls
// back to its cache; this timeout is what catches the "acquired but never
// responds" case a plain try/catch cannot.
const LEARNED_SKILLS_TIMEOUT_MS = 2_000;

// A reasonable ceiling on how many learned rows get rendered into the
// system prompt's skills catalog in one turn — see the truncation comment
// where this is used. Generous enough that a real library (dozens of
// class-level skills, per SKILL_REVIEW_PROMPT's bias against sprawl) never
// hits it in practice, but still bounded rather than unlimited.
const MAX_LEARNED_SKILLS_IN_PROMPT = 50;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
  /** Client-generated stable anonymous id. Absent → memory is disabled for
   * this turn (the showcase runner and every headless entry point). */
  userId?: string;
  memoryStore?: MemoryStore | null;
  /**
   * Phase 2: injected learned-skill store. Undefined/null → no self-authored
   * skills for this turn — the showcase runner and any caller that doesn't
   * wire one stay exactly the pre-phase-2 turn. Ignored entirely (even if
   * passed) when SELF_SKILLS_ENABLED is off, so the flag is the only thing
   * that can change the system prompt/tool set byte-for-byte.
   */
  learnedSkillStore?: LearnedSkillStore | null;
  /**
   * Phase 2: direct Postgres handle for skill_manage/skill_view's own
   * agent_selfimprove_audit writes — separate from learnedSkillStore, which
   * only knows the agent_skills table. Same undefined/null/flag contract as
   * learnedSkillStore.
   */
  auditDb?: TraceQueryable | null;
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
  /** True when both the snapshot and the `memory` tool were added to this
   * turn — the review runner uses it to decide whether a review is possible
   * at all. */
  memoryInjected: boolean;
  /** Names of the self-authored skills that were merged into this turn's
   * catalog (empty when SELF_SKILLS_ENABLED is off or no store was wired). */
  learnedSkillNames: string[];
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

  // Self-authored skills (phase 2). Everything here is additive and
  // best-effort: the flag gates it (ignoring even an explicitly-passed
  // store when off, so the flag alone controls the prompt/tool byte
  // identity), and a slow/unreachable catalog read degrades to "no learned
  // skills this turn" rather than hanging the request — same race pattern
  // as the memory snapshot read above.
  const learnedStore = config.SELF_SKILLS_ENABLED ? (input.learnedSkillStore ?? null) : null;
  let learnedSkills: LearnedSkill[] = [];
  if (learnedStore) {
    try {
      learnedSkills = await withTimeout(
        getLearnedCatalog(learnedStore),
        LEARNED_SKILLS_TIMEOUT_MS,
        "[selfskills] catalog read",
      );
    } catch (err) {
      console.error("[selfskills] catalog read timed out; continuing without learned skills:", err);
    }
  }

  // A learned skill's name can outlive its usefulness if a human later adds
  // a curated skill under the same name (checkNameCollision only guards
  // `create` time — it can't see a file that doesn't exist yet). Without
  // this filter the catalog would render the name TWICE ("(learned)" and
  // not), and load_skill always resolves the curated one anyway (see
  // getSkill/getAllSkills precedence in skills.ts), so the learned entry
  // would be dead weight the model can never actually reach — curated wins
  // ties, always. skill_manage's curatedGuard still lets an agent DELETE
  // the now-shadowed row directly (see tool.ts); this only controls what's
  // rendered in the prompt.
  const curatedNames = new Set(getAllSkills().map((s) => s.name));
  const visibleLearnedSkills = learnedSkills.filter((s) => !curatedNames.has(s.name));
  if (visibleLearnedSkills.length !== learnedSkills.length) {
    console.warn(
      `[selfskills] ${learnedSkills.length - visibleLearnedSkills.length} learned skill(s) hidden from the catalog — shadowed by a curated skill of the same name.`,
    );
  }

  // Unbounded growth here means an unbounded system prompt: nothing today
  // caps how many rows agent_skills can accumulate, and a silent truncation
  // (or no cap at all) reads to whoever's debugging a missing skill as "it
  // must have loaded everything" when it didn't. The cap keeps the prompt's
  // size bounded and the log line makes the truncation visible instead of
  // silent.
  const boundedLearnedSkills = visibleLearnedSkills.slice(0, MAX_LEARNED_SKILLS_IN_PROMPT);
  if (visibleLearnedSkills.length > MAX_LEARNED_SKILLS_IN_PROMPT) {
    console.warn(
      `[selfskills] learned skill catalog truncated to ${MAX_LEARNED_SKILLS_IN_PROMPT} of ${visibleLearnedSkills.length} active learned skills.`,
    );
  }

  const skillCatalog = [
    ...getAllSkills().map((s) => ({ name: s.name, description: s.description })),
    ...boundedLearnedSkills.map((s) => ({
      name: s.name,
      description: s.description,
      learned: true as const,
    })),
  ];

  // Memory is per-user and opt-in twice over: the kill switch AND a userId.
  // A snapshot read that fails must degrade to an ordinary turn rather than
  // failing the user's request — losing memory for one turn is recoverable,
  // losing the turn is not.
  const memoryStore = input.memoryStore ?? null;
  const memoryEligible = Boolean(config.MEMORY_ENABLED && input.userId && memoryStore);
  let memorySnapshotBlock = "";
  let memoryInjected = false;
  if (memoryEligible && memoryStore && input.userId) {
    try {
      memorySnapshotBlock = renderMemorySnapshot(
        await withTimeout(
          memoryStore.loadSnapshot(input.userId),
          MEMORY_SNAPSHOT_TIMEOUT_MS,
          "[memory] snapshot read",
        ),
      );
      memoryInjected = true;
    } catch (err) {
      console.error("[memory] snapshot read failed; continuing without memory:", err);
    }
  }

  // Hoisted above the system prompt (the tool wiring that consumes it is
  // further down): whether `skill_manage` will actually be in this turn's
  // tool set decides whether the prompt may talk about writing skills.
  // Guidance without the tool is an instruction the model cannot follow —
  // the same rule memoryGuidance already follows.
  const auditDb = config.SELF_SKILLS_ENABLED ? (input.auditDb ?? null) : null;
  const selfSkillsInjected = Boolean(learnedStore && auditDb);

  const system = buildSystemPrompt(canvasContext, skillCatalog, {
    memoryGuidance: memoryInjected,
    memorySnapshot: memorySnapshotBlock,
    selfSkillsGuidance: selfSkillsInjected,
  });
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

  const convertedMessages = await convertToModelMessages(
    normalizedMessages as unknown as UIMessage[],
  );

  // Our analog of Hermes's decide_image_input_mode, run once right before
  // streamText sees the messages: a vision-capable model gets these back
  // unchanged, a vision-less one gets every image (user attachment or
  // get_screenshot result) replaced with a text description. Shared by
  // /api/chat and the showcase runner via this same function, so neither
  // can send a raw image part to a text-only model.
  const modelMessages = await applyVisionPreprocessing(convertedMessages, {
    config,
    modelId: selectedModelId,
  });

  // Structural backstop for prototype/slides: swap in the embed-only
  // batch_design variant so a native frame/rect/text create op is rejected
  // at the schema level instead of relying on prompting alone. Computed
  // from the incoming message history (including the synthetic
  // load_skill/lookup_skill pair injected above for a slash command) plus
  // the current slash command name, if any.
  const taskPolicy = resolveTaskPolicy({ messages, slashSkillName });

  const mcpTools = await getMCPTools(config);
  // One run context per request: load_skill marks what the model actually
  // read this turn, and skill_manage refuses to patch/delete anything it
  // did not — see SkillRunContext's doc comment for why this must be fresh
  // per request rather than shared across turns.
  const skillRunContext = createSkillRunContext();
  const tools = {
    ...penTools,
    ...getWebTools(config),
    ...mcpTools,
    ...getSkillTools({ learnedStore, runContext: skillRunContext }),
  } as ToolSet;
  if (memoryInjected && memoryStore && input.userId) {
    Object.assign(
      tools,
      getMemoryTools(createMemoryToolContext(memoryStore, input.userId, "foreground")),
    );
  }
  if (learnedStore && auditDb) {
    Object.assign(
      tools,
      getSelfSkillTools({
        store: learnedStore,
        runContext: skillRunContext,
        db: auditDb,
        // Skills are global, not per-user, so a write is legitimate without
        // a userId; the audit row still needs one, and "anonymous" is the
        // honest value for a caller with no client-supplied id.
        userId: input.userId ?? "anonymous",
        origin: "foreground",
        // skill_view belongs to the background review run. In a design turn
        // the model reads a skill via load_skill, which already satisfies
        // skill_manage's read-before-write guard — a second reader here
        // would just invite mid-task browsing of the library.
        includeView: false,
      }),
    );
  }
  if (taskPolicy !== "native") {
    tools.batch_design = makeBatchDesignTool({ embedOnly: true });
    delete tools.draw_vector;
  }

  // analyze_image needs this request's real config (VISION_MODEL etc.) to
  // actually call the vision service — the static penTools entry only
  // exists so the tool-name contract test can see its schema without one.
  // With no VISION_MODEL it has nothing to call, so it is dropped rather
  // than left to burn a step reporting itself unavailable.
  if (isVisionConfigured(config)) {
    tools.analyze_image = makeAnalyzeImageTool(config);
  } else {
    delete tools.analyze_image;
  }

  // Structural gate (mirrors the embed-only guard above): get_screenshot is
  // client-executed and returns an image, so it is only useful when the
  // main model can read that image natively, or a VISION_MODEL is
  // configured to describe it instead. Otherwise it's a phantom tool nobody
  // could act on, so it's removed from the per-request set rather than
  // merely discouraged in the prompt.
  if (!modelSupportsVision(config, selectedModelId) && !isVisionConfigured(config)) {
    delete tools.get_screenshot;
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
    memoryInjected,
    // Reflects what was actually rendered into the catalog (deduped against
    // curated names, capped at MAX_LEARNED_SKILLS_IN_PROMPT) — not the raw
    // store read — since this is what other code inspects to know what the
    // model was actually shown this turn.
    learnedSkillNames: boundedLearnedSkills.map((s) => s.name),
  };
}
