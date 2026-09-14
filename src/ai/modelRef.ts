// Parsing a "<provider>:<modelId>" model reference.
//
// This lives in its OWN module, deliberately free of any runtime import, and
// must stay that way. src/config.ts needs bareModelId (getModels /
// getDefaultModel must report the bare id — see the central invariant below),
// and config.ts is imported ACROSS REPOSITORIES: pen-editor's
// src/lib/__tests__/modelContract.test.ts loads this backend's DEFAULT_MODELS
// straight from the sibling checkout to pin the frontend's FALLBACK_MODEL
// against it. When these helpers still lived in src/ai/provider.ts, that
// import dragged in "ai", "@ai-sdk/deepseek" and "@openrouter/ai-sdk-provider"
// — packages the frontend does not install — and the cross-repo test died on
// module resolution rather than on the contract it exists to check. The
// backend's own CI cannot catch that regression, because the backend HAS
// those packages. So: keep this file importless.

export type ModelProviderId = "deepseek" | "openrouter";

export interface ModelRef {
  provider: ModelProviderId;
  modelId: string;
}

// The only prefixes parseModelRef recognizes. Deliberately NOT a blind
// `ref.split(":")[0]` — OpenRouter model ids themselves routinely contain a
// colon (e.g. "openai/gpt-4o:extended", "meta/llama:free" for a
// provider-specific variant suffix), so splitting on the first colon would
// chop a legitimate OpenRouter id in half and silently misroute or corrupt
// it. Recognizing only these two exact prefixes means any colon appearing
// later in the string (as in those examples) is left alone and stays part
// of modelId.
const KNOWN_PROVIDER_PREFIXES: ModelProviderId[] = ["deepseek", "openrouter"];

// Parses a model reference of the form "<provider>:<modelId>". A string with
// no recognized prefix (including one with an unrelated colon in it, like
// "openai/gpt-4o:extended") is treated as a LEGACY bare OpenRouter id — the
// whole string becomes modelId and provider defaults to "openrouter". This
// legacy path exists so already-deployed env values (Render's CHAT_MODEL,
// formerly OPENROUTER_MODEL) and CLI overrides like
// `npm run showcase:generate -- --model=google/gemini-3.7-flash` keep
// working unchanged after this provider split landed.
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
// Verified directly against each provider's installed source (both handle
// ToolResultPart["output"].type === "content", the shape get_screenshot
// returns):
//   - @openrouter/ai-sdk-provider (node_modules/@openrouter/ai-sdk-provider/
//     dist/index.js:3142-3151, mapToolResultContentParts): an "image-data"
//     part becomes a real `{type: "image_url", image_url: {...}}` chat
//     content part.
//   - @ai-sdk/deepseek (node_modules/@ai-sdk/deepseek/dist/index.js:387-390):
//     the "content" case falls into `contentValue = JSON.stringify(output.
//     value)`, which serializes the image-data part (base64 payload
//     included) as text and sends THAT as the tool message's string content.
//     There is no branch that promotes it to an image part.
//
// This says nothing about images in USER messages — DeepSeek reads those
// natively (see deepseekFilePartProviderOptions.imageDetail). It is
// specifically about the tool-result path, which is why
// src/ai/vision-messages.ts consults it separately from modelSupportsVision.
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
