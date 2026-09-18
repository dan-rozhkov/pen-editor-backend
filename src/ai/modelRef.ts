// Parsing a "<provider>:<modelId>" model reference.
//
// This lives in its OWN module, deliberately free of any runtime import, and
// must stay that way. src/config.ts needs bareModelId (getModels /
// getDefaultModel must report the bare id — see the central invariant below),
// and config.ts is imported ACROSS REPOSITORIES: pen-editor's
// src/lib/__tests__/modelContract.test.ts loads this backend's DEFAULT_MODELS
// straight from the sibling checkout to pin the frontend's fallback list
// against it. When these helpers still lived in src/ai/provider.ts, that
// import dragged in "ai" and "@openrouter/ai-sdk-provider" — packages the
// frontend does not install — and the cross-repo test died on module
// resolution rather than on the contract it exists to check. The backend's
// own CI cannot catch that regression, because the backend HAS those
// packages. So: keep this file importless.

// OpenRouter was, for a while, the only provider. A DeepSeek-direct branch
// existed briefly (its own API key, its own AI SDK integration) and is gone:
// it never passed a live smoke, and it cost three silent divergences from the
// OpenRouter path (reasoning defaults, tool-result images flattened to
// base64 text, no structured outputs). Those lessons are why OpenCode BYOK
// (docs/specs/2026-09-18-opencode-byok-design.md) is deliberately narrow:
// only the /chat/completions family, no structured outputs there either, and
// providerHandlesToolResultImages below treats it as untrusted by default
// rather than assuming parity with OpenRouter.
//
// "opencode-go" and "opencode" are two different upstream bases (Go: a flat
// $10/mo subscription; Zen: pay-as-you-go) that happen to share the
// /chat/completions request/response shape, which is why they get separate
// provider ids instead of collapsing into one "opencode" — see
// src/ai/opencode.ts (a later task) for the base-URL table.
export type ModelProviderId = "openrouter" | "opencode" | "opencode-go";

export interface ModelRef {
  provider: ModelProviderId;
  modelId: string;
}

// The only legacy COLON prefix parseModelRef recognizes. Deliberately NOT a
// blind `ref.split(":")[0]` — OpenRouter model ids themselves routinely
// contain a colon (e.g. "openai/gpt-4o:extended", "meta/llama:free" for a
// provider-specific variant suffix), so splitting on the first colon would
// chop a legitimate OpenRouter id in half and silently misroute or corrupt
// it. Recognizing only this exact prefix means any colon appearing later in
// the string (as in those examples) is left alone and stays part of modelId.
const LEGACY_COLON_PROVIDER_PREFIXES: ModelProviderId[] = ["openrouter"];

// The SLASH prefixes OpenCode's own config uses to name its two bases
// ("opencode-go/<id>", "opencode/<id>"). Order matters: "opencode-go/" MUST
// be checked before "opencode/", or "opencode-go/glm-5.3" would match the
// shorter "opencode/" prefix first and parse as provider "opencode" with
// modelId "go/glm-5.3" — wrong provider AND a mangled model id.
const SLASH_PROVIDER_PREFIXES: ModelProviderId[] = ["opencode-go", "opencode"];

// Parses a model reference. Recognizes:
//   - the legacy colon form "openrouter:<modelId>"
//   - the slash forms "opencode-go/<modelId>" and "opencode/<modelId>"
// A string with no recognized prefix (including one with an unrelated colon
// in it, like "openai/gpt-4o:extended", or one that merely starts with
// "opencode" text that isn't followed by "/") is a bare OpenRouter id — the
// whole string becomes modelId. Both the colon and slash forms exist because
// already-deployed env values (Render's CHAT_MODEL is
// "openrouter:deepseek/deepseek-v4.1-flash") and CLI overrides like
// `npm run showcase:generate -- --model=google/gemini-3.7-flash` must keep
// working unchanged, while OpenCode's own docs name models with the slash
// form.
//
// A "deepseek:" reference is NOT silently accepted as a bare id: see
// rejectDeepSeekModelRef in src/config.ts, which fails the boot loudly rather
// than passing "deepseek:deepseek-flash" to OpenRouter as a model name. The
// COLON forms "opencode:" / "opencode-go:" get the same loud-failure
// treatment (not handled here — see src/config.ts): only the slash form is a
// real OpenCode reference, so a colon-prefixed one must not be silently
// treated as a bare OpenRouter id either.
export function parseModelRef(ref: string): ModelRef {
  for (const provider of LEGACY_COLON_PROVIDER_PREFIXES) {
    const prefix = `${provider}:`;
    if (ref.startsWith(prefix)) {
      return { provider, modelId: ref.slice(prefix.length) };
    }
  }
  for (const provider of SLASH_PROVIDER_PREFIXES) {
    const prefix = `${provider}/`;
    if (ref.startsWith(prefix)) {
      return { provider, modelId: ref.slice(prefix.length) };
    }
  }
  return { provider: "openrouter", modelId: ref };
}

// Whether `provider`'s AI SDK integration can carry an IMAGE found inside a
// tool-result part (e.g. get_screenshot's output) through to the model as a
// real image, as opposed to flattening it into a giant base64 JSON string
// inside a plain text tool message.
//
// OpenRouter: verified directly against the provider's installed source
// (node_modules/@openrouter/ai-sdk-provider/dist/index.js:3142-3151,
// mapToolResultContentParts): for ToolResultPart["output"].type === "content"
// — the shape get_screenshot returns — an "image-data" part becomes a real
// `{type: "image_url", image_url: {...}}` chat content part.
//
// OpenCode (both "opencode" and "opencode-go" route through
// @ai-sdk/openai-compatible — see src/ai/opencode.ts): verified false
// against that package's installed source
// (node_modules/@ai-sdk/openai-compatible/dist/index.js:~290, the `case
// "tool":` branch) — for ToolResultPart["output"].type === "content", it
// does `JSON.stringify(output.value)` and sends the result as plain text
// tool-message content. A get_screenshot result would arrive as a giant
// base64 JSON string described as "text", exactly the @ai-sdk/deepseek
// failure mode this axis exists to catch (see the module header above).
//
// src/ai/vision-messages.ts's applyVisionPreprocessing treats this as a
// second, independent axis from "can the model see at all" — a provider
// that stringifies tool-result images needs get_screenshot's output run
// through the same vision-fallback description path a vision-less model's
// user attachments already get.
export function providerHandlesToolResultImages(provider: ModelProviderId): boolean {
  return provider === "openrouter";
}

// Whether `provider` is one of the two OpenCode routes (Go's flat
// subscription or Zen's pay-as-you-go base) rather than OpenRouter. Used by
// later tasks (createModel's branch, the chat route's key-required 400,
// CHAT_MODEL boot validation) wherever OpenRouter-specific behavior — a
// server-side API key, reasoning-effort support, structured outputs — must
// be skipped for either OpenCode route uniformly.
export function isOpenCodeProvider(provider: ModelProviderId): boolean {
  return provider === "opencode" || provider === "opencode-go";
}

// The legacy colon prefix bareModelId strips — kept as its own constant
// (rather than reusing LEGACY_COLON_PROVIDER_PREFIXES) so this function's
// behavior doesn't silently change if that list ever grows a second colon
// entry; see the comment below for why only this one is stripped.
const LEGACY_COLON_PREFIX = "openrouter:";

// The id that must be the only thing that ever reaches a client, a log
// line, or a database column (GET /api/models, raw_traces,
// showcase_screens.model, etc).
//
// Strips ONLY the legacy colon prefix "openrouter:" — every other form,
// including a slash-prefixed OpenCode reference like
// "opencode-go/glm-5.3-flash", is returned VERBATIM, prefix and all. This is
// a deliberate change from the old behavior (which returned
// parseModelRef(ref).modelId for every provider, stripping any prefix).
//
// Why: this id makes a round trip — GET /api/models -> a user's pick in the
// composer -> the POST /api/chat body -> createModel -> and it is what ends
// up in raw_traces.model. For the legacy "openrouter:" colon form that round
// trip is safe to strip, because parseModelRef's fallback (bare id -> bare
// OpenRouter id) reconstructs the exact same provider on the way back in.
// It is NOT safe for the slash forms: parseModelRef only recognizes
// "opencode-go" as a provider when the "opencode-go/" prefix is still
// attached to the string. Strip it here and the id that reaches the client
// is indistinguishable from a bare OpenRouter id — the next request carrying
// it back would silently route to OpenRouter with a model name that doesn't
// exist there, with no error anywhere on the way. So the slash prefix is
// kept as part of the "bare" id on purpose: for OpenCode routes, "bare" and
// "provider-qualified" are the same string.
export function bareModelId(ref: string): string {
  if (ref.startsWith(LEGACY_COLON_PREFIX)) {
    return ref.slice(LEGACY_COLON_PREFIX.length);
  }
  return ref;
}
