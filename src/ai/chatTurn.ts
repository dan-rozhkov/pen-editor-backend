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
import { bareModelId, createModel, parseModelRef, providerHandlesToolResultImages } from "./provider.js";
import { penTools, makeBatchDesignTool, makeAnalyzeImageTool } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveTaskPolicy, type TaskPolicy } from "./taskPolicy.js";
import { applyImageBudget, planImageElision } from "./image-budget.js";
import { freezeElidedSlots, resolveImageRescues } from "./imageRelevance.js";
import { applyVisionPreprocessing, modelSupportsVision } from "./vision-messages.js";
import { SCREENSHOT_TOOL_NAMES, promoteScreenshotToolOutputs } from "./screenshotOutput.js";
import { isVisionConfigured } from "../services/vision.js";
import { isQuiverConfigured } from "../services/quiver.js";
import { attachMobbinRelease, getMCPTools, releaseMCPTools } from "./mcp.js";
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
import { createSystemOne, type SystemOneClient } from "../services/systemone.js";
import { routeSkill, SKILL_ROUTING_SHADOW_BUDGET_MS, type SkillRouteVerdict } from "./skillRouting.js";

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
  /**
   * The browser's own Mobbin OAuth access token (`X-Mobbin-Token` request
   * header, read by src/routes/chat.ts — never stored server-side, see
   * docs/superpowers/specs/2026-09-18-mobbin-mcp-design.md). Undefined →
   * getMCPTools returns no Mobbin tools for this turn, same as an
   * unconnected user or a headless caller (the showcase runner, background
   * reviews).
   */
  mobbinAccessToken?: string;
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
  /**
   * Jev client for skillRouting.ts's auto-pick. Undefined → falls back to
   * createSystemOne(config) (null when TYPESAFE_API_KEY is unset, which is
   * also how the route is skipped entirely in production without the key).
   * Threaded through here — rather than constructed unconditionally inside
   * this function — so tests can inject a fake client without a network
   * stub, mirroring how memoryStore/learnedSkillStore/userSkillStore are
   * wired above.
   */
  systemOneClient?: SystemOneClient | null;
  /**
   * Stable id for this conversation, threaded straight into
   * createModel({sessionId}) — see src/ai/provider.ts. Only meaningful when
   * the resolved model's provider is an OpenCode route (OpenCode's Go docs
   * use it for their own routing/prompt-cache); ignored on an OpenRouter
   * turn. Undefined for callers that don't have one (e.g. the showcase
   * runner, which never resolves to an OpenCode model since it has no user
   * key to pass either).
   */
  sessionId?: string;
  /**
   * The REAL conversation id, undefined when the client sent none — unlike
   * {@link sessionId}, which src/routes/chat.ts backfills with a per-REQUEST
   * `anon-<uuid>`. Anything that must remember a decision ACROSS turns has
   * to key off this one; an id that changes every request is not a session.
   * Today that is imageRelevance.ts's ratchet, which skips Jev entirely
   * when this is absent (see that module's doc comment).
   */
  chatSessionId?: string;
  /**
   * The calling user's OWN OpenCode API key (never a server-side key — none
   * exists for OpenCode in this product), threaded straight into
   * createModel({opencodeApiKey}). Only meaningful when the resolved
   * model's provider is an OpenCode route. Undefined for every OpenRouter
   * turn and for every caller that doesn't have one (the showcase runner
   * never wires this — see src/ai/provider.ts's CreateModelOptions doc
   * comment).
   */
  opencodeApiKey?: string;
  /**
   * What the requesting client can actually do. Currently one flag:
   * desktopBrowser — true only when the Electron shell's built-in browser
   * bridge (window.penDesktop.browser) is present in that session. Threaded
   * straight from chatBodySchema.clientCapabilities (src/routes/chat.ts).
   * Undefined/false → the browse_* tools are dropped below, same as any
   * other caller (the showcase runner, tests) that never wires this.
   */
  clientCapabilities?: { desktopBrowser?: boolean };
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
  /**
   * How `slashSkillName` was arrived at, or undefined when no skill was
   * resolved at all. Both values feed resolveTaskPolicy identically — an
   * enforced Jev pick MUST behave exactly like the equivalent typed slash
   * command, see the FIR-45 note at the assignment site — but they are very
   * different facts about the turn, and the shadow→enforce rollout is
   * judged on being able to tell "the user asked for this skill" from "Jev
   * guessed it". Overloading slashSkillName alone would erase that
   * distinction from the one analytics event that records it.
   */
  skillSource: "slash" | "auto" | undefined;
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
  let skillSource: "slash" | "auto" | undefined;
  // Captured here (rather than re-extracted later) so the Jev auto-pick
  // below can see the same last-user-message text this block worked with.
  // When a slash command was detected, this is ALWAYS the stripped text
  // (detected.userText) regardless of whether the token resolved to a
  // known skill — a pasted path ("/Users/me/shot.png make this bigger") or
  // an unrecognized "/word" still has a slash-shaped token at the front
  // that Jev has no business routing on. When it resolved to a curated or
  // enabled user skill, skillContent is already set and the auto-pick is
  // skipped anyway; when it named a real-but-DISABLED user skill,
  // skipAutoPick below suppresses the auto-pick entirely instead.
  let lastUserText: string | undefined;
  // Set when the slash command named a real user skill the owner has
  // disabled. That skill is deliberately unresolvable here (mirrors
  // load_skill's own enabled check) — letting Jev auto-pick a DIFFERENT
  // curated skill for this message would be a back door around that
  // deliberate choice, so no auto-pick happens at all in this case.
  let skipAutoPick = false;
  // The last USER message, which is NOT always the last message: tools are
  // client-executed, so every auto-continuation of the tool loop arrives as
  // a fresh HTTP request whose tail is an assistant/tool message. Keying off
  // `messages[messages.length - 1]` (as this did) meant a skill resolved on
  // step 1 silently vanished from step 2 onward — the synthetic pair below
  // lives only in this server-side array and is never streamed back, so the
  // client's history cannot carry it. Two things broke as a result: the
  // model stopped seeing the instructions it was still supposed to be
  // following, and resolveTaskPolicy fell back to "native" mid-prototype,
  // handing out the native batch_design while the FIR-45 embed-only guard
  // was supposed to be on. Re-resolving from the last user message makes
  // every step of one turn identical, which also keeps the prompt-cache
  // prefix stable across the loop instead of invalidating it at step 2.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  // True only on the first request of a turn. Side effects that must happen
  // once per user message rather than once per tool-loop step (the user-skill
  // usage counter below) are gated on this.
  const isFreshUserTurn = lastUserIndex === messages.length - 1;
  const lastMsg = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
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

    lastUserText = rawText;

    if (rawText && setText) {
      const detected = detectSkillCommand(rawText);
      if (detected) {
        slashSkillName = detected.skillName;
        skillSource = "slash";
        // Route Jev on the stripped text unconditionally from here on — see
        // the doc comment on `lastUserText` above for why this must happen
        // even when the token doesn't resolve to anything.
        lastUserText = detected.userText;
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
          // `lookupFailed` distinguishes "the store answered: no such
          // skill" from "we never got an answer". Both surface as null
          // below, but they must NOT be treated the same — see the
          // skipAutoPick assignment further down.
          let lookupFailed = false;
          const userSkill = await withTimeout(
            input.userSkillStore.get(input.userId, detected.skillName),
            USER_SKILLS_TIMEOUT_MS,
            "[userskills] slash-command lookup",
          ).catch(() => {
            lookupFailed = true;
            return null;
          });
          if (userSkill && userSkill.enabled) {
            skillContent = userSkill.body;
            setText(detected.userText);
            // Best-effort AND bounded: a failed or hung counter bump must
            // not fail — or stall — the turn. Gated on isFreshUserTurn so
            // the counter still measures user invocations: without it, a
            // turn that runs ten tool-loop steps would bump the same skill
            // ten times, since each step re-resolves the same slash command.
            if (isFreshUserTurn) {
              await withTimeout(
                input.userSkillStore.bumpUse(input.userId, detected.skillName),
                USER_SKILLS_TIMEOUT_MS,
                "[userskills] slash-command bumpUse",
              ).catch(() => undefined);
            }
          } else if (userSkill || lookupFailed) {
            // Either a real user skill that exists but is disabled, or a
            // lookup that timed out / threw so we cannot know. Both suppress
            // the auto-pick — see skipAutoPick's doc comment above. Treating
            // a failed lookup as "no such skill" would reopen the very back
            // door that comment closes, and would do so precisely when the
            // DB is slow, i.e. as the DEFAULT behavior under load rather
            // than as a rare edge case.
            skipAutoPick = true;
          }
        }
      }
    }
  }

  // A short, deliberately small tail of the conversation immediately before
  // the current turn, fed to Jev as `recent_context` (skillRouting.ts's
  // state) so "make it bigger" or "now do the same for the login screen"
  // gets some signal beyond the bare current message — without shipping the
  // whole history to a third-party vendor. Only TEXT parts are read; tool
  // calls/results are skipped deliberately (arbitrary HTML/JSON, not useful
  // signal for "does this look like a documented workflow"). Final
  // truncation + scrubPii happens inside routeSkill, AFTER this string is
  // built — see MAX_CONTEXT_CHARS's comment there for why order matters.
  const RECENT_CONTEXT_MESSAGES = 4;
  const RECENT_CONTEXT_MESSAGE_CHARS = 500;
  // Finding #9: AI SDK v6 assistant messages are routinely split into
  // SEVERAL "text" parts around tool calls (e.g. a sentence before a tool
  // call, then another after its result) — reading only the first one, as
  // this used to, silently dropped every later fragment, so an assistant
  // turn that reasoned across a tool call fed recent_context only its
  // opening fragment. Every text part is joined (in document order) before
  // truncation, not just the first.
  function extractMessageText(msg: unknown): string | undefined {
    if (!msg || typeof msg !== "object") return undefined;
    const record = msg as Record<string, unknown>;
    const parts = record.parts ?? record.content;
    if (Array.isArray(parts)) {
      const textParts = parts.filter(
        (p) => p && typeof p === "object" && (p as { type?: string }).type === "text",
      ) as Array<{ text?: string }>;
      const joined = textParts
        .map((p) => p.text ?? "")
        .filter((t) => t.length > 0)
        .join("\n");
      return joined.length > 0 ? joined : undefined;
    }
    if (typeof parts === "string") return parts;
    return undefined;
  }
  function buildRecentContext(allMessages: typeof messages, beforeIndex: number): string {
    const lines: string[] = [];
    for (let i = beforeIndex - 1; i >= 0 && lines.length < RECENT_CONTEXT_MESSAGES; i--) {
      const msg = allMessages[i];
      const role = (msg as { role?: string } | undefined)?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractMessageText(msg);
      if (!text) continue;
      lines.unshift(`${role}: ${text.slice(0, RECENT_CONTEXT_MESSAGE_CHARS)}`);
    }
    return lines.join("\n");
  }

  // Jev auto-pick: when no slash command already resolved a skill, ask Jev
  // whether the message matches one of the curated skills up front, instead
  // of spending a whole extra round trip on the model reading the catalog,
  // emitting a load_skill call, and getting the result back. An explicit
  // slash command always wins — this never overrides it, and is skipped
  // entirely rather than called when it can't matter, so it costs nothing
  // on the vast majority of turns that don't touch it.
  //
  // Candidates are curated skills ONLY (getAllSkills()) — deliberately not
  // widened to user/learned skills, which need their own Postgres reads
  // (further down, already guarded by their own timeouts) and whose
  // inclusion here is a separate decision to make later.
  if (config.SKILL_ROUTING_MODE !== "off" && !skillContent && !skipAutoPick && lastUserText) {
    const systemOne = input.systemOneClient !== undefined
      ? input.systemOneClient
      : createSystemOne(config);
    if (systemOne) {
      const routeArgs = {
        messageText: lastUserText,
        candidates: getAllSkills().map((s) => ({ name: s.name, description: s.description, content: s.content })),
        threshold: config.SKILL_ROUTING_MIN_CONFIDENCE,
        gateThreshold: config.SKILL_ROUTING_GATE_THRESHOLD,
        fitsThreshold: config.SKILL_ROUTING_FITS_THRESHOLD,
        recentContext: buildRecentContext(messages, lastUserIndex),
      };

      // Logs EVERY verdict, in BOTH modes, including every no-pick reason
      // ("gated"/"no-fit"/"low-confidence"/"unavailable"/"error") — the
      // previous version returned early on `!verdict.skill`, which made
      // shadow mode's false-NEGATIVE rate unmeasurable: it only ever showed
      // the turns where routing WOULD have fired. Deliberately NOT gated
      // behind ENABLE_AGENT_LOGGING (off by default), which would make the
      // "measure before trusting enforce" story unmeasurable. Never logs
      // the user's message text or any state sent to Jev — verdict is
      // reason codes and numbers only (see SkillRouteVerdict's doc comment).
      const logVerdict = (verdict: SkillRouteVerdict, mode: "shadow" | "enforce"): void => {
        const entry: Record<string, unknown> = { ...verdict, mode };
        if (verdict.skill) entry.resolves = Boolean(getSkill(verdict.skill));
        console.log(`[skillRouting] ${JSON.stringify(entry)}`);
      };
      const logPick = (verdict: SkillRouteVerdict, mode: "shadow" | "enforce") => {
        logVerdict(verdict, mode);
        return verdict.skill ? getSkill(verdict.skill) : undefined;
      };

      if (config.SKILL_ROUTING_MODE === "enforce") {
        // Only enforce needs the answer to act on, so only enforce may pay
        // for it — this await is the one legitimate cost on the request
        // path, bounded overall by SKILL_ROUTING_ENFORCE_BUDGET_MS across
        // BOTH of routeSkill's Jev requests (see routeSkill's `reason:
        // "budget"` verdict for what happens if that budget runs out
        // mid-flight — `verdict.skill` is null there, so `picked` below is
        // simply undefined and nothing is injected).
        const verdict = await routeSkill(systemOne, {
          ...routeArgs,
          overallBudgetMs: config.SKILL_ROUTING_ENFORCE_BUDGET_MS,
        });
        const picked = logPick(verdict, "enforce");
        if (picked) {
          skillContent = picked.content;
          // Without this, resolveTaskPolicy (taskPolicy.ts) never learns
          // this turn picked "prototype"/"slides" — it only trusts an
          // explicit slash command or a load_skill call already in
          // history, neither of which this synthetic lookup_skill
          // injection satisfies (different tool name, empty input). That
          // left taskPolicy at "native" while the model was told it's in
          // prototype/slides mode, defeating the FIR-45 embed-only guard:
          // the model would get the native batch_design instead of the
          // embed-only variant. Setting this makes an enforced pick
          // resolve exactly like the equivalent explicit slash command.
          slashSkillName = verdict.skill ?? undefined;
          skillSource = "auto";
        }
      } else {
        // shadow: this mode by definition changes nothing, so it must not
        // cost the user anything either — fire the call WITHOUT awaiting it
        // so measurement adds zero latency to time-to-first-token, and log
        // once it resolves. Its overall budget is the much laxer
        // SKILL_ROUTING_SHADOW_BUDGET_MS (fire-and-forget still needs a
        // bound, just not one that touches TTFT). routeSkill is already
        // fail-open (never rejects), but attach .catch regardless so a
        // future change there can never turn this into an unhandled
        // rejection.
        void routeSkill(systemOne, {
          ...routeArgs,
          overallBudgetMs: SKILL_ROUTING_SHADOW_BUDGET_MS,
          // Shadow mode's per-call cap must be the laxer shadow budget too,
          // not routeSkill's enforce-shaped 1.5s default — otherwise Jev
          // genuinely answering in 2s under load reads as `reason: "error"`
          // instead of the real verdict shadow mode exists to collect. See
          // SKILL_ROUTING_SHADOW_BUDGET_MS's comment in skillRouting.ts.
          perCallTimeoutMs: SKILL_ROUTING_SHADOW_BUDGET_MS,
        })
          .then((verdict) => logPick(verdict, "shadow"))
          .catch((err) => {
            console.warn("[skillRouting] shadow pick failed unexpectedly:", err);
          });
      }
    }
  }

  // When a skill is detected, inject a synthetic tool call + result
  // right before the LAST USER MESSAGE — which is lastUserIndex, not
  // `messages.length - 1`; on a tool-loop continuation those differ, and
  // splicing at the tail would have dropped the pair behind the assistant
  // turn it is supposed to precede. See lastUserIndex's comment above.
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
    messages.splice(lastUserIndex >= 0 ? lastUserIndex : messages.length - 1, 0, skillMsg);
  }

  const model = createModel(config, modelOverride, {
    chatAgent: true,
    sessionId: input.sessionId,
    opencodeApiKey: input.opencodeApiKey,
  });

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
  // Bare — no provider prefix — since this id is what gets exposed via
  // traces/logs and compared against getModels()' bare ids (vision gating
  // below, GET /api/models). See src/ai/provider.ts's central invariant.
  const selectedModelId = bareModelId(modelOverride ?? config.CHAT_MODEL);
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

  const convertedMessagesRaw = await convertToModelMessages(
    normalizedMessages as unknown as UIMessage[],
  );

  // BUG FIX (2026-09-23): convertToModelMessages above is called WITHOUT
  // `{ tools }` (see promoteScreenshotToolOutputs' own comment for why that
  // isn't simply added), so get_screenshot's and browse_screenshot's
  // `toModelOutput` (src/ai/tools.ts) never run in production — every
  // screenshot tool result instead lands here as the AI SDK's untouched
  // default: `{ type: "text", value: "<the handler's raw JSON string>" }`.
  // Downstream code (vision-messages.ts, image-budget.ts) needs the SAME
  // `content` shape `toModelOutput` would have produced — a structured image
  // part it can find and swap for a description, plus (for browse_screenshot)
  // a sibling text part carrying url/title/snapshotId/elements that must
  // survive that swap. Without this pass, vision-less/VISION_MODEL paths fell
  // back to replacing the WHOLE text output with the image description,
  // silently dropping browse_screenshot's element table, and native-vision
  // paths sent the raw base64 JSON string to the model as text instead of an
  // image. This promotes both tools' outputs into that shape right here, so
  // every pass below it sees exactly what it already assumed.
  const convertedMessages = promoteScreenshotToolOutputs(convertedMessagesRaw);

  // Bounds the number of LIVE images in history, but ONLY on the path where
  // images actually survive as images: a vision model on a provider that can
  // carry tool-result images, which is exactly the case
  // applyVisionPreprocessing below returns untouched and therefore the only
  // one with no cap at all.
  //
  // Gating matters, it isn't just an optimization. On every other path
  // applyVisionPreprocessing already replaces each image with a cached,
  // byte-stable description, so no base64 was going to be sent and there are
  // no tokens for a budget to save. Running the budget in front of it there
  // would trade a real description for a constant placeholder — losing
  // information the model could still use — and would do it by rewriting the
  // OLDEST tool message in the history, invalidating the provider's whole
  // cached prefix for nothing. See src/ai/image-budget.ts and
  // docs/specs/2026-09-20-image-context-budget-design.md.
  const imagesSurviveAsImages =
    modelSupportsVision(config, selectedModelId) &&
    providerHandlesToolResultImages(
      parseModelRef(modelOverride ?? config.CHAT_MODEL).provider,
    );

  // Phase 2 (see docs/specs/2026-09-21-jev-image-relevance-design.md): Jev
  // can SPARE a slot phase 1's step-wise recency window was about to elide
  // — never evict one recency would have kept, and never add tokens on the
  // "off" path (imagesSurviveAsImages false), same gating reasoning as
  // phase 1 above. `off` never touches Jev at all and must render
  // byte-identical to before this feature existed — that is itself a
  // dedicated test, per the design doc's callout that SKILL_ROUTING_MODE
  // once shipped in enforce while everyone believed it was off.
  let rescuedToolCallIds: ReadonlySet<string> | undefined;
  if (imagesSurviveAsImages && config.IMAGE_RELEVANCE_MODE !== "off") {
    // Candidates are bounded to phase 1's own eviction zone by
    // planImageElision — Jev is never even asked about a slot recency
    // would have kept live. Cheap to compute unconditionally when the mode
    // is on: it reads slot counts only, no payload, same as
    // applyImageBudget itself.
    const candidates = planImageElision(convertedMessages);
    if (candidates.length > 0) {
      const systemOneForImages =
        input.systemOneClient !== undefined ? input.systemOneClient : createSystemOne(config);
      if (systemOneForImages) {
        const resolveOpts = {
          config,
          sessionId: input.chatSessionId,
          candidates,
          messages: convertedMessages,
        };
        if (config.IMAGE_RELEVANCE_MODE === "enforce") {
          // Only enforce needs the answer to act on, so only enforce pays
          // for it on the request path — bounded per-call by
          // config.IMAGE_RELEVANCE_TIMEOUT_MS inside resolveImageRescues,
          // the same TTFT-shaped budget skillRouting.ts's enforce path
          // uses for the same reason.
          const result = await resolveImageRescues(systemOneForImages, resolveOpts);
          rescuedToolCallIds = result.rescued;
          // Freeze everything this turn ACTUALLY elides — the applied plan,
          // not the candidate list and not just the shift victims.
          //
          // Two holes close here at once. A rescue pushes elision onto the
          // next slot in line, and that slot was never a candidate, so
          // nothing recorded a verdict for it. And when Jev fails — a
          // timeout, a transport error, a malformed answer for one
          // candidate — resolveImageRescues deliberately caches nothing,
          // yet pure recency still elides those candidates this turn.
          // Either way an unfrozen, already-elided slot comes back as a
          // FRESH candidate once the cutoff advances, Jev says "keep it",
          // and the image returns to life: its text flips from placeholder
          // back to a real image part in the middle of the history, breaking
          // the provider's cached prefix and silently re-adding the tokens
          // the budget just saved.
          //
          // "The next turn is a free chance to ask again" only ever applied
          // to slots that were NOT elided — and the plan is exactly the ones
          // that were. A slot the walk stopped short of (a multi-image
          // result can end it early) is not in the plan and stays askable.
          freezeElidedSlots(
            input.chatSessionId,
            planImageElision(convertedMessages, rescuedToolCallIds).map((slot) => slot.toolCallId),
          );
          // `outcome` is not decoration: a bare "0 rescued" reads identically
          // whether Jev declined every candidate or never answered at all, and
          // those have opposite fixes. See ImageRescueOutcome.
          console.log(
            `[imageRelevance] ${JSON.stringify({
              mode: "enforce",
              rescued: result.rescued.size,
              candidates: candidates.length,
              asked: result.asked,
              outcome: result.outcome,
            })}`,
          );
        } else {
          // Shadow must be a faithful DRY RUN of enforce, not just a
          // logger: it keeps the same ratchet enforce would keep, so the
          // rescue counts it reports are the counts enforce would produce.
          // Without freezing the shift victims here too, shadow lets slots
          // enforce would have frozen come back as fresh candidates and
          // reports rescues enforce would never grant.
          // shadow: by definition changes nothing, so it must cost the
          // user nothing either — fire-and-forget, never awaited, and the
          // applied budget below never sees `rescuedToolCallIds` (it stays
          // undefined on this branch). Mirrors chatTurn.ts's own shadow
          // skill-routing call just above in this file.
          void resolveImageRescues(systemOneForImages, {
            ...resolveOpts,
            timeoutMs: config.IMAGE_RELEVANCE_SHADOW_TIMEOUT_MS,
          })
            .then((result) => {
              // Shadow keeps the ratchet enforce would keep, over the plan
              // enforce would have applied — that is what makes its numbers
              // an estimate of enforce rather than of itself.
              freezeElidedSlots(
                input.chatSessionId,
                planImageElision(convertedMessages, result.rescued).map((slot) => slot.toolCallId),
              );
              // Shadow exists to be MEASURED, so it must never report a zero
              // that can't be read. `would rescue 0/6` said the same thing on
              // a healthy conservative model and on a TypeSafe account out of
              // credits — one calls for moving the threshold, the other for
              // paying a bill.
              console.log(
                `[imageRelevance] ${JSON.stringify({
                  mode: "shadow",
                  wouldRescue: result.rescued.size,
                  candidates: candidates.length,
                  asked: result.asked,
                  outcome: result.outcome,
                })}`,
              );
            })
            .catch((err) => {
              console.warn("[imageRelevance] shadow pick failed unexpectedly:", err);
            });
        }
      }
    }
  }

  const budgetedMessages = imagesSurviveAsImages
    ? applyImageBudget(convertedMessages, { rescued: rescuedToolCallIds })
    : convertedMessages;

  // Our analog of Hermes's decide_image_input_mode, run once right before
  // streamText sees the messages. Two-dimensional (see vision-messages.ts's
  // doc comment): a vision-capable model on a provider that can carry
  // tool-result images (OpenRouter) gets these back unchanged; a
  // vision-capable model on a provider that can't (DeepSeek-direct) only
  // has its get_screenshot results converted to text, leaving user
  // attachments native; a vision-less model gets every image, wherever it
  // appears, replaced with a text description. Shared by /api/chat and the
  // showcase runner via this same function, so neither can send a raw
  // image part to a text-only model, or a raw base64 blob into a
  // tool-result a provider can't carry.
  const modelMessages = await applyVisionPreprocessing(budgetedMessages, {
    config,
    modelId: selectedModelId,
    chatModelRef: modelOverride ?? config.CHAT_MODEL,
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

  const mcpTools = await getMCPTools(config, {
    mobbinAccessToken: input.mobbinAccessToken,
    // Same source of truth get_screenshot's own gate uses below — reused
    // rather than a second copy, so "can this model see" can never disagree
    // between the two gates. This decides whether getMCPTools hands back a
    // Mobbin tool set whose inline preview images survive, or one that's
    // been rewritten to drop them per-request (never baked into its
    // token-keyed client cache — see gateImagesForVisionlessModel's doc
    // comment in mcp.ts for why that has to happen outside the cache).
    modelSupportsVision: modelSupportsVision(config, selectedModelId),
  });
  // getMCPTools has already incremented a refCount for this lease by the
  // time it resolves (see mcp.ts) — anything below that throws before the
  // `return` at the end of this function would otherwise leak that lease
  // forever: routes/chat.ts's releaseMCPTools call is wired onto the
  // *returned* `tools` object's "close" handler, which is registered AFTER
  // prepareChatTurn returns, so a throw here means that handler never gets
  // wired at all and the lease is orphaned until the 10-minute
  // RETIRE_FORCE_CLOSE_MS backstop. getWebTools/getSkillTools/
  // getMemoryTools/getSelfSkillTools/makeAnalyzeImageTool can all throw
  // (config lookups, store construction), so the whole remainder of this
  // function is wrapped.
  try {
    // One run context per request: load_skill marks what the model actually
    // read this turn, and skill_manage refuses to patch/delete anything it
    // did not — see SkillRunContext's doc comment for why this must be
    // fresh per request rather than shared across turns.
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
    // The spread above only copies mcpTools' own ENUMERABLE properties, which
    // drops the non-enumerable Mobbin-client release hook — reattach it onto
    // the merged object so the caller's eventual releaseMCPTools(tools) call
    // (see routes/chat.ts) still reaches the real cached client instead of
    // becoming a silent no-op. See attachMobbinRelease's doc comment.
    attachMobbinRelease?.(mcpTools, tools);
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
      // generate_vector places its result as real scene nodes (paths/groups)
      // via x/y/width/height/parentId, exactly like draw_vector — same
      // "NOT CREATING NATIVE SCENE NODES in embed-only mode" reasoning as
      // draw_vector/vectorize_image above, so it's gated the same way.
      delete tools.generate_vector;
    }

    // generate_vector additionally needs QUIVER_API_KEY to do anything at
    // all — it is client-executed (no `execute` here), so unlike
    // analyze_image there's no backend call to make conditionally; the whole
    // tool is either offered or not. Same reasoning as the FAL_KEY gate on
    // remove_background/vectorize_image (GET /api/models) and the
    // isVisionConfigured gate on analyze_image just below: an unusable tool
    // left in the set would just burn a guaranteed-failing step.
    if (!isQuiverConfigured(config)) {
      delete tools.generate_vector;
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

    // Structural gate (mirrors the embed-only guard above): get_screenshot
    // (and browse_screenshot, SCREENSHOT_TOOL_NAMES) is client-executed and
    // returns an image, so it is only useful when that image can actually
    // reach the model as something readable. That is TWO independent axes
    // (see vision-messages.ts's doc comment on applyVisionPreprocessing),
    // not one:
    //   1. Can the model see at all (modelSupportsVision)?
    //   2. Can THIS PROVIDER'S AI SDK integration carry an image found inside
    //      a tool result through to the model natively
    //      (providerHandlesToolResultImages)? OpenRouter can; both OpenCode
    //      routes route through @ai-sdk/openai-compatible and cannot — that
    //      package JSON.stringifies a tool-result image part into plain text
    //      instead (see providerHandlesToolResultImages's doc comment).
    // A vision-capable model on a provider that can't carry the image STILL
    // has its get_screenshot result routed through applyVisionPreprocessing's
    // "tool-result-only" rewrite path — but with no VISION_MODEL configured,
    // describeImage has nothing to call, so every screenshot arrives as the
    // literal string "Vision is not configured on this server"
    // (src/services/vision.ts). That is exactly the "phantom tool nobody
    // could act on" this gate exists to prevent, so the tool must only stay
    // in the set when EITHER a real image reaches the model natively (axes 1
    // AND 2 both true) OR a VISION_MODEL is configured to describe it instead.
    const chatModelRef = modelOverride ?? config.CHAT_MODEL;
    const toolResultImagesNative = providerHandlesToolResultImages(
      parseModelRef(chatModelRef).provider,
    );
    const nativeVisionPath =
      modelSupportsVision(config, selectedModelId) && toolResultImagesNative;
    if (!nativeVisionPath && !isVisionConfigured(config)) {
      for (const name of SCREENSHOT_TOOL_NAMES) {
        delete tools[name];
      }
    }

    // Structural gate, unconditional (unlike the ones above): attach_local_repo
    // is client-executed but exists purely for a LOCAL agent driving the
    // editor tab over WebMCP to call directly — the design agent itself runs
    // in a browser with no filesystem, so offering it here could only waste a
    // tool-call step. It stays in penTools (with no execute) solely to satisfy
    // pen-editor's cross-repo tool-name contract; every real chat turn drops
    // it before the request goes out.
    delete tools.attach_local_repo;

    // Structural gate: browse_open/browse_snapshot/browse_screenshot/browse_act/
    // browse_tabs/browse_find_images/browse_task/browse_read are client-executed
    // against a browser tab that only exists inside the Electron shell
    // (pen-editor-desktop's BrowserController, driven over
    // window.penDesktop.browser) — a browser-hosted session has no such
    // bridge, so offering these there could only waste a tool-call step,
    // the same reasoning as the attach_local_repo gate just above. The flag
    // is derived once at module scope on the frontend (useDesignChat.ts) so
    // it can't vary mid-conversation and invalidate the cached tool set.
    // browse_task additionally drives POST /api/browse/step (Jev) from the
    // frontend's own loop, but that's a frontend/backend detail — the gate
    // here is purely about whether the desktop browser bridge exists.
    // browse_screenshot ALSO needs the vision gate below (it is deleted
    // there too when this flag is true but the model/provider/VISION_MODEL
    // combination can't carry the image) — the two gates are independent
    // and either one deleting it is sufficient.
    if (!input.clientCapabilities?.desktopBrowser) {
      delete tools.browse_open;
      delete tools.browse_snapshot;
      delete tools.browse_screenshot;
      delete tools.browse_act;
      delete tools.browse_tabs;
      delete tools.browse_find_images;
      delete tools.browse_task;
      delete tools.browse_read;
    }

    // Key gate, browse_task only: unlike browse_open/browse_act/
    // browse_find_images (which act on the browser tab directly, no
    // backend call involved), browse_task's loop calls POST
    // /api/browse/step, which 503s outright without TYPESAFE_API_KEY. Left
    // ungated, every browse_task call would burn its whole step budget on
    // identical 503s instead of never being offered — the same reasoning
    // as the FAL_KEY gate on remove_background/vectorize_image just below.
    if (!config.TYPESAFE_API_KEY) {
      delete tools.browse_task;
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
      skillSource,
      memoryInjected,
      // Reflects what was actually rendered into the catalog (deduped against
      // curated names, capped at MAX_LEARNED_SKILLS_IN_PROMPT) — not the raw
      // store read — since this is what other code inspects to know what the
      // model was actually shown this turn.
      learnedSkillNames: boundedLearnedSkills.map((s) => s.name),
    };
  } catch (err) {
    releaseMCPTools(mcpTools);
    throw err;
  }
}
