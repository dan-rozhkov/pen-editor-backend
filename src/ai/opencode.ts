// OpenCode Zen/Go as a chat-model provider, BYOK (bring your own key).
//
// See docs/specs/2026-09-18-opencode-byok-design.md for the full design.
// This module owns exactly two things: the (hardcoded) base URLs and the
// allowlist of models known to speak the /chat/completions dialect, plus the
// factory that turns {provider, modelId, apiKey, sessionId} into a
// LanguageModel via @ai-sdk/openai-compatible.

import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelProviderId } from "./modelRef.js";

type OpenCodeProviderId = Extract<ModelProviderId, "opencode" | "opencode-go">;

// Hardcoded ON PURPOSE and must NEVER become env-configurable. The key that
// flows through this client is the USER'S OWN OpenCode key (see
// docs/specs/2026-09-18-opencode-byok-design.md, "Поток ключа") — if the
// base URL were configurable, a compromised/misconfigured deployment (or a
// malicious modelOverride path) could redirect that key to an attacker-
// controlled host. Baking the two real OpenCode bases in here is what makes
// that class of leak structurally impossible rather than merely unlikely.
export const OPENCODE_BASE_URLS: Record<OpenCodeProviderId, string> = {
  opencode: "https://opencode.ai/zen/v1",
  "opencode-go": "https://opencode.ai/zen/go/v1",
};

// OpenCode fronts THREE incompatible endpoint families for its models:
// `/responses` (the shape @ai-sdk/openai speaks), `/chat/completions` (the
// shape @ai-sdk/openai-compatible speaks — what this module uses), and
// `/messages` (the shape @ai-sdk/anthropic speaks). Which family a given
// model id answers on is a fixed property of that model, not something a
// caller chooses. This module only ever builds a /chat/completions client,
// so a model id that actually lives on /responses or /messages, sent here,
// would NOT fail loudly — /chat/completions would either 404 it or (worse)
// silently accept the id and return something nonsensical, since these are
// plain HTTP endpoints with no cross-family validation. That is why this is
// an ALLOWLIST of models verified to be on /chat/completions, rather than
// "send whatever id the caller passes and let the model name 404 if wrong."
//
// Data snapshot taken from opencode.ai/docs/go/ and opencode.ai/docs/zen/ on
// 2026-09-18 — re-verify against the live docs before extending this table,
// don't extrapolate from naming patterns.
//
// Re-verified 2026-09-21: minimax-m3/m2.7/m2.5 also exist on Go, but on the
// /messages family (@ai-sdk/anthropic), not /chat/completions — exactly the
// mis-family case this allowlist exists to prevent (see the block comment
// above). They are intentionally absent from "opencode-go" below.
export const OPENCODE_CHAT_COMPLETIONS_MODELS: Record<
  OpenCodeProviderId,
  readonly string[]
> = {
  "opencode-go": [
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "kimi-k3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "longcat-2.0",
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "hy4-preview",
    "hy3",
  ],
  opencode: [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v4-flash-vision-exp",
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "glm-5.3-flash",
    "glm-5.3",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "kimi-k2.5",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "kimi-k3",
    "big-pickle",
    "mimo-v2.5-free",
    "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
  ],
};

// OpenCode's own docs (Go, "Where can I use it?") ask a client to identify
// itself with its own User-Agent rather than a generic SDK name, and to send
// a stable `x-opencode-session` per conversation — both feed their routing
// and prompt-cache behavior on their side. This is intentionally a fixed
// constant, not per-deployment configuration: it is OUR client identifying
// itself, not something a caller should be able to spoof.
export const OPENCODE_USER_AGENT = "pen-editor-design-agent/1.0";

export interface CreateOpenCodeModelOptions {
  provider: OpenCodeProviderId;
  /** Already stripped of its provider prefix — what parseModelRef returns. */
  modelId: string;
  /** The calling user's OWN OpenCode API key. Never a server-side key. */
  apiKey: string;
  /** Stable id for this conversation, sent as x-opencode-session. */
  sessionId: string;
  /**
   * Test/DI-only override for the underlying fetch implementation (used to
   * intercept outgoing requests without a real network call). Defaults to
   * the global `fetch`. Never set by production callers.
   */
  fetch?: typeof globalThis.fetch;
}

// `sessionId` (forced into the `x-opencode-session` header below) traces
// back to the chat route's `traceSessionId`, which is the client-supplied
// body `id` — only validated by zod as `z.string().max(200)`, with no
// restriction on WHICH characters it contains. A raw newline (CRLF/LF header
// injection) or any codepoint outside Latin-1 makes the WHATWG `Headers`
// implementation throw a TypeError inside `.set()` (Node's `undici`
// enforces ByteString-only header values), which happens inside this
// module's `forcedHeadersFetch` — i.e. on EVERY request of that session —
// and surfaces to the user as an unhelpful, undiagnosable "An error
// occurred." Strip it down to a conservative safe set instead of trusting
// the caller; fall back to a generated id (rather than sending the empty
// string, or omitting the header, which OpenCode's routing/prompt-cache
// treats as no session at all) if nothing safe survives.
const SAFE_SESSION_ID_CHARS = /[^A-Za-z0-9._-]/g;

function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(SAFE_SESSION_ID_CHARS, "");
  return cleaned.length > 0 ? cleaned : randomUUID();
}

export function createOpenCodeModel(options: CreateOpenCodeModelOptions): LanguageModel {
  const { provider, modelId, apiKey, sessionId } = options;

  if (!OPENCODE_CHAT_COMPLETIONS_MODELS[provider].includes(modelId)) {
    throw new Error(
      `Model "${modelId}" is not in the OpenCode ${provider} /chat/completions ` +
        "allowlist (OPENCODE_CHAT_COMPLETIONS_MODELS). This module only " +
        "supports the /chat/completions family — if this model actually " +
        "exists on OpenCode, it may live on the /responses or /messages " +
        "endpoint family instead, which this client cannot speak to.",
    );
  }

  // Belt-and-suspenders: the real "no key -> reject" check lives in the
  // route (src/routes/chat.ts, a later task), which returns a clean 400
  // before createModel is ever reached. This guard exists so this function
  // is safe to call directly (e.g. from tests, or a future caller) without
  // silently building a client that would send `Authorization: Bearer `
  // upstream.
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      `createOpenCodeModel requires a non-empty user API key for provider "${provider}".`,
    );
  }

  // Force our identification headers at the actual network boundary,
  // instead of relying solely on createOpenAICompatible's `headers` config
  // below. This is NOT redundant caution — it was verified empirically
  // (test/opencode-provider.test.ts + a throwaway debug script against this
  // repo's exact installed "ai"/@ai-sdk/openai-compatible/@ai-sdk/
  // provider-utils versions) that a plain `headers: {"User-Agent": ...}` on
  // createOpenAICompatible does NOT survive a real `generateText`/
  // `streamText` call:
  //   1. `ai`'s generateText/streamText computes its OWN User-Agent header
  //      (`withUserAgentSuffix(callerHeaders ?? {}, "ai/<version>")`,
  //      node_modules/ai/dist/index.js) independent of the model/provider
  //      config, and passes it as `options.headers` into the model's
  //      doGenerate/doStream.
  //   2. Inside @ai-sdk/openai-compatible's chat-language-model,
  //      `combineHeaders(this.config.headers(), options.headers)`
  //      (node_modules/@ai-sdk/openai-compatible/dist/index.js) is a plain
  //      `{...a, ...b}` merge — `options.headers` WINS on a shared key. So
  //      `ai`'s own bare "ai/<version>" user-agent value silently REPLACES
  //      (not appends to) whatever custom User-Agent this module configured,
  //      the opposite of createOpenAICompatible's own internal
  //      `withUserAgentSuffix` behavior (which appends).
  // `x-opencode-session` was NOT observed to be clobbered the same way (the
  // `ai` layer never sets that key), but it is forced here too so there is
  // exactly ONE mechanism responsible for both required OpenCode headers,
  // rather than one path that happens to survive and one that needed a
  // workaround.
  const safeSessionId = sanitizeSessionId(sessionId);
  const baseFetch = options.fetch ?? globalThis.fetch;
  const forcedHeadersFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("user-agent", OPENCODE_USER_AGENT);
    headers.set("x-opencode-session", safeSessionId);
    return baseFetch(input, { ...init, headers });
  };

  // createOpenAICompatible sets `Authorization: Bearer <apiKey>` itself from
  // `apiKey` (verified against node_modules/@ai-sdk/openai-compatible/dist/
  // index.js's createOpenAICompatible: `headers = {...options.apiKey &&
  // {Authorization: \`Bearer ${options.apiKey}\`}, ...options.headers}`) —
  // so it is NOT duplicated here. Authorization was NOT observed to be
  // clobbered by the `ai` package (only `user-agent` was), but it still
  // flows through the same forced-headers fetch above unaffected, since
  // `Headers` merging there only touches the two keys `.set()` names.
  const openaiCompatible = createOpenAICompatible({
    name: provider,
    baseURL: OPENCODE_BASE_URLS[provider],
    apiKey,
    fetch: forcedHeadersFetch,
    // Without this, @ai-sdk/openai-compatible never sends
    // `stream_options: {include_usage: true}` on the outgoing
    // /chat/completions request (verified against node_modules/@ai-sdk/
    // openai-compatible/dist/index.js — both the stream and generate paths
    // gate that body field on `this.config.includeUsage`), so an
    // OpenAI-compatible streaming response carries no usage block at all
    // unless a client explicitly asks for it. src/routes/chat.ts reads
    // `usage.inputTokens ?? 0` — every OpenCode turn would silently record
    // zero tokens in raw_traces and the agent_turn_completed PostHog event,
    // which is exactly the prompt-cache/cost measurement this repo treats
    // as load-bearing (see modelRef.ts's header and CLAUDE.md).
    includeUsage: true,
  });

  return openaiCompatible(modelId);
}
