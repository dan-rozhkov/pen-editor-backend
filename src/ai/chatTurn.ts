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
import { getUserSkillCatalog } from "./skills/userSkillCatalog.js";
import type { UserSkill, UserSkillStore } from "./skills/userStore.js";

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

// Same reasoning as LEARNED_SKILLS_TIMEOUT_MS, but for the per-user custom
// skill catalog: getUserSkillCatalog already caches (15s TTL) and catches
// thrown errors, so this timeout only covers the "acquired but never
// responds" Postgres case a plain try/catch can't degrade from.
const USER_SKILLS_TIMEOUT_MS = 2_000;

// Mirrors MAX_LEARNED_SKILLS_IN_PROMPT — bounds one user's custom-skill
// catalog in the prompt. The store's own MAX_SKILLS_PER_USER cap (50, see
// validateUserSkill.ts) already keeps a single user under this in practice;
// this is the same defense-in-depth the learned cap is.
const MAX_USER_SKILLS_IN_PROMPT = 50;

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
  /**
   * User skills (Figma-style custom skills, per-userId, user_skills table).
   * Undefined/null → no custom skills for this turn — the showcase runner
   * and any caller that doesn't wire one (or has no userId) stay exactly
   * the pre-user-skills turn. Unlike learnedSkillStore this has no feature
   * flag: presence of BOTH a store AND input.userId is what gates it.
   */
  userSkillStore?: UserSkillStore | null;
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
        } else if (input.userSkillStore && input.userId) {
          // The headline Figma behavior: `/my-skill` resolves to a user's
          // own custom skill exactly like a curated one — same synthetic
          // lookup_skill injection below, same text-stripping via setText.
          // Curated always wins the name tie (checked above); a DISABLED
          // user skill is deliberately not resolvable here either, mirroring
          // load_skill's own enabled check in skills.ts.
          //
          // This fires on ANY message starting with "/" — a pasted path
          // like "/Users/foo/bar" matches detectSkillCommand's regex too —
          // so it is NOT a rare path; every such message reaches Postgres.
          // A `.catch()` alone only degrades a REJECTED promise, not a
          // connection that was acquired but never responds (no RST on a
          // network black-hole), so this needs the same withTimeout guard
          // as the catalog read below or a hung DB stalls /api/chat on
          // every slash-shaped message, not just genuine skill invocations.
          const userSkill = await withTimeout(
            input.userSkillStore.get(input.userId, detected.skillName),
            USER_SKILLS_TIMEOUT_MS,
            "[userskills] slash-command lookup",
          ).catch(() => null);
          if (userSkill && userSkill.enabled) {
            skillContent = userSkill.body;
            setText(detected.userText);
            // Best-effort AND bounded: a failed or hung counter bump must
            // not fail — or stall — the turn.
            await withTimeout(
              input.userSkillStore.bumpUse(input.userId, detected.skillName),
              USER_SKILLS_TIMEOUT_MS,
              "[userskills] slash-command bumpUse",
            ).catch(() => undefined);
          }
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

  // User skills (Figma-style custom skills). No feature flag, unlike
  // learnedStore above: presence of BOTH a store AND a userId is what gates
  // it, mirroring memoryEligible's stance elsewhere in this function — the
  // showcase runner and any caller with no userId simply never populate
  // this, and stay exactly the pre-user-skills turn. Same race-against-a-
  // timeout shape as the learned catalog read, so a slow/unreachable
  // Postgres degrades to "no user skills this turn" instead of hanging
  // /api/chat; getUserSkillCatalog itself caches per (store, userId) for
  // 15s and catches thrown errors, so this timeout only covers the
  // "acquired but never responds" case a plain try/catch can't.
  const userSkillStore = input.userSkillStore ?? null;
  let userSkills: UserSkill[] = [];
  if (userSkillStore && input.userId) {
    try {
      userSkills = await withTimeout(
        getUserSkillCatalog(userSkillStore, input.userId),
        USER_SKILLS_TIMEOUT_MS,
        "[userskills] catalog read",
      );
    } catch (err) {
      console.error("[userskills] catalog read timed out; continuing without user skills:", err);
    }
  }

  // A learned or user skill's name can outlive its usefulness if a human
  // later adds a curated skill under the same name (checkNameCollision only
  // guards `create` time — it can't see a file that doesn't exist yet).
  // Without this filter the catalog would render the name TWICE, and
  // load_skill always resolves the curated one anyway (see getSkill/
  // getAllSkills precedence in skills.ts), so the shadowed entry would be
  // dead weight the model can never actually reach — curated wins ties,
  // always. skill_manage's curatedGuard still lets an agent DELETE a
  // now-shadowed learned row directly (see tool.ts); this only controls
  // what's rendered in the prompt.
  const curatedNames = new Set(getAllSkills().map((s) => s.name));

  const visibleUserSkills = userSkills.filter((s) => !curatedNames.has(s.name));
  if (visibleUserSkills.length !== userSkills.length) {
    console.warn(
      `[userskills] ${userSkills.length - visibleUserSkills.length} user skill(s) hidden from the catalog — shadowed by a curated skill of the same name.`,
    );
  }
  // Same cap reasoning as MAX_LEARNED_SKILLS_IN_PROMPT — bounds the prompt's
  // size and makes truncation visible rather than silent, even though
  // MAX_SKILLS_PER_USER (validateUserSkill.ts) already keeps a single user
  // under this in practice.
  const boundedUserSkills = visibleUserSkills.slice(0, MAX_USER_SKILLS_IN_PROMPT);
  if (visibleUserSkills.length > MAX_USER_SKILLS_IN_PROMPT) {
    console.warn(
      `[userskills] user skill catalog truncated to ${MAX_USER_SKILLS_IN_PROMPT} of ${visibleUserSkills.length} enabled user skills.`,
    );
  }

  // A user skill wins over a learned one on a name tie (curated always wins
  // over both) — so a learned row shadowed by this user's own custom skill
  // of the same name is filtered out here too, on top of the curated filter.
  const userNames = new Set(boundedUserSkills.map((s) => s.name));
  const visibleLearnedSkills = learnedSkills.filter(
    (s) => !curatedNames.has(s.name) && !userNames.has(s.name),
  );
  if (visibleLearnedSkills.length !== learnedSkills.length) {
    console.warn(
      `[selfskills] ${learnedSkills.length - visibleLearnedSkills.length} learned skill(s) hidden from the catalog — shadowed by a curated or user skill of the same name.`,
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
    ...boundedUserSkills.map((s) => ({
      name: s.name,
      description: s.description,
      custom: true as const,
    })),
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

  // Whether a canvas context is delivered at all this turn — headless
  // callers (showcase runner, review runs) that never pass canvasContext
  // must render byte-identical to before this option existed, so the
  // pointer block only appears when there is somewhere for it to point.
  const canvasContextDelivered = Boolean(canvasContext);

  const system = buildSystemPrompt(skillCatalog, {
    memoryGuidance: memoryInjected,
    memorySnapshot: memorySnapshotBlock,
    selfSkillsGuidance: selfSkillsInjected,
    canvasContextDelivered,
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

  // Canvas context goes on the TAIL of modelMessages, not into `system`.
  // Why: `system` is the first block of every request, and a provider's
  // prompt cache only stays warm while that prefix is byte-identical
  // request to request. The frontend rebuilds canvasContext (roots,
  // selectedIds, selectedNodes, theme, variables) on every single request,
  // including every auto-continuation of a tool-call loop — so when it lived
  // in `system` (see buildSystemPrompt's history), the cached prefix broke
  // on request #1 of every conversation and nothing downstream of it ever
  // cached either. Appending it as the LAST message instead keeps system +
  // the full prior history stable, so only this one trailing message varies.
  //
  // Role is "user", not "system": a trailing system-role message is
  // rejected by some OpenRouter-routed providers, but every provider
  // accepts a trailing user message. The wrapper text below is there so the
  // model doesn't mistake this for something the human actually typed.
  // Skipped entirely when this turn has no canvas context (headless
  // callers — the showcase runner, review runs) so that path stays
  // byte-for-byte what it was before this change.
  if (canvasContext) {
    modelMessages.push({
      role: "user",
      content: `<canvas_context>\nAutomatic message from the Pencil editor (not from the user): the current state of the canvas.\n\n${canvasContext}\n</canvas_context>`,
    });
  }

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
    ...getSkillTools({
      learnedStore,
      runContext: skillRunContext,
      userSkills: userSkillStore && input.userId ? { store: userSkillStore, userId: input.userId } : null,
    }),
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
    // This gate is about NOT CREATING NATIVE SCENE NODES in embed-only mode
    // — not about which tools are "expensive" or "external". vectorize_image
    // defaults to mode: "layers", which places native vector paths exactly
    // like draw_vector does, so it's gated the same way.
    //
    // remove_background stays available here on purpose — it's an asymmetry,
    // not an oversight. Its image_url branch never touches the scene graph:
    // URL in, URL out, and the cut-out PNG is meant to be dropped straight
    // into an embed's `<img src>` — exactly the "real imagery in the design"
    // the prototype skill asks for. Gating it out would remove the one
    // capability prototype/slides screens most want. Its node_id branch
    // (replace a canvas node's image fill in place) simply won't find a
    // matching node here — embed-only mode has no such nodes — and returns a
    // clear error; one wasted step in a rare case is cheaper than losing the
    // image_url path entirely.
    delete tools.vectorize_image;
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

  // Structural gate: remove_background/vectorize_image are client-executed
  // but call our backend routes, which return 503 without FAL_KEY. Rather
  // than advertise a tool that's guaranteed to fail, drop it from the
  // per-request set when the feature isn't configured on this deployment.
  if (!config.FAL_KEY) {
    delete tools.remove_background;
    delete tools.vectorize_image;
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
