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

// OpenRouter is the only provider. A DeepSeek-direct branch existed briefly
// (its own API key, its own AI SDK integration) and is gone: it never passed
// a live smoke, and it cost three silent divergences from the OpenRouter path
// (reasoning defaults, tool-result images flattened to base64 text, no
// structured outputs). The provider concept is kept — as a one-member union —
// only because the prefix appears in deployed env values and because
// providerHandlesToolResultImages below is a real axis of the vision pass.
export type ModelProviderId = "openrouter";

export interface ModelRef {
  provider: ModelProviderId;
  modelId: string;
}

// The only prefix parseModelRef recognizes. Deliberately NOT a blind
// `ref.split(":")[0]` — OpenRouter model ids themselves routinely contain a
// colon (e.g. "openai/gpt-4o:extended", "meta/llama:free" for a
// provider-specific variant suffix), so splitting on the first colon would
// chop a legitimate OpenRouter id in half and silently misroute or corrupt
// it. Recognizing only this exact prefix means any colon appearing later in
// the string (as in those examples) is left alone and stays part of modelId.
const KNOWN_PROVIDER_PREFIXES: ModelProviderId[] = ["openrouter"];

// Parses a model reference of the form "openrouter:<modelId>". A string with
// no recognized prefix (including one with an unrelated colon in it, like
// "openai/gpt-4o:extended") is a bare OpenRouter id — the whole string
// becomes modelId. Both forms exist because already-deployed env values
// (Render's CHAT_MODEL is "openrouter:deepseek/deepseek-v4.1-flash") and CLI
// overrides like `npm run showcase:generate -- --model=google/gemini-3.7-flash`
// must keep working unchanged.
//
// A "deepseek:" reference is NOT silently accepted as a bare id: see
// rejectDeepSeekModelRef in src/config.ts, which fails the boot loudly rather
// than passing "deepseek:deepseek-flash" to OpenRouter as a model name.
export function parseModelRef(ref: string): ModelRef {
  for (const provider of KNOWN_PROVIDER_PREFIXES) {
    const prefix = `${provider}:`;
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
// Verified directly against the provider's installed source
// (node_modules/@openrouter/ai-sdk-provider/dist/index.js:3142-3151,
// mapToolResultContentParts): for ToolResultPart["output"].type === "content"
// — the shape get_screenshot returns — an "image-data" part becomes a real
// `{type: "image_url", image_url: {...}}` chat content part.
//
// Kept as a function even though it is now always true: it is the second
// axis src/ai/vision-messages.ts decides on, and an integration that
// stringifies tool-result images is a real failure mode we have already hit
// once (@ai-sdk/deepseek did exactly that), with no error to notice it by.
export function providerHandlesToolResultImages(provider: ModelProviderId): boolean {
  return provider === "openrouter";
}

// The bare model id — with any recognized provider prefix stripped — that
// must be the only thing that ever reaches a client, a log line, or a
// database column. The provider prefix is an internal routing detail of
// createModel and must never leak into GET /api/models, raw_traces,
// showcase_screens.model, etc.
export function bareModelId(ref: string): string {
  return parseModelRef(ref).modelId;
}
