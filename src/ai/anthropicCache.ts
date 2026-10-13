import type { ModelMessage, SystemModelMessage } from "ai";

// Anthropic models served through OpenRouter cache a prompt only at an
// explicit `cache_control` breakpoint; with none, the cache-read share is 0%
// (measured on anthropic/claude-haiku-5.5, 2026-10-13). Other families
// (OpenAI, DeepSeek, ...) cache any shared prefix on their own.
//
// The breakpoints are placed by hand, NOT with OpenRouter's top-level
// "automatic" cache_control (tried in 2844a1d): automatic caching puts the
// breakpoint on the LAST block, and on a chat turn that block is the
// `<canvas_context>` message chatTurn.ts appends — rebuilt by the browser on
// every request. Anthropic writes the cache only at a breakpoint, so every
// write landed on a prefix ending in a canvas snapshot that never recurs, and
// the bench read 0 tokens from cache on every step.
//
// Two breakpoints (Anthropic allows four):
// - the system prompt, so tools + system cache across conversations;
// - the last message of the stable history, right before canvas_context,
//   so each tool-loop request reads everything up to the previous one
//   (Anthropic looks back up to 20 blocks for an earlier breakpoint).
export function usesAnthropicPromptCache(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}

const CACHE_CONTROL = { type: "ephemeral" } as const;

type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;

function withCacheControl(options: ProviderOptions | undefined): ProviderOptions {
  return {
    ...options,
    openrouter: { ...options?.openrouter, cacheControl: CACHE_CONTROL },
  };
}

export function cachedSystemPrompt(system: string): SystemModelMessage {
  return { role: "system", content: system, providerOptions: withCacheControl(undefined) };
}

/**
 * Returns a copy of `messages` with a cache breakpoint on the last message.
 * A tool message is marked on its LAST result part only: OpenRouter turns
 * every result of a tool message into its own `tool` message and copies a
 * message-level cache_control onto each, so five parallel tool results would
 * become five breakpoints and Anthropic rejects more than four.
 */
export function markCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  if (!last) return messages;
  let marked: ModelMessage;
  if (last.role === "tool") {
    // Approval responses carry no providerOptions and never reach the wire.
    let index = last.content.length - 1;
    while (index >= 0 && last.content[index].type !== "tool-result") index--;
    const part = last.content[index];
    if (part?.type !== "tool-result") return messages;
    const parts = [...last.content];
    parts[index] = { ...part, providerOptions: withCacheControl(part.providerOptions) };
    marked = { ...last, content: parts };
  } else {
    marked = { ...last, providerOptions: withCacheControl(last.providerOptions) } as ModelMessage;
  }
  return [...messages.slice(0, -1), marked];
}
