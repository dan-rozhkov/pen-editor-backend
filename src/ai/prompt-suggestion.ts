import { generateText } from "ai";
import type { Config } from "../config.js";
import { createModel } from "./provider.js";

export interface SuggestionMessage {
  role: "user" | "assistant";
  text: string;
}

const SYSTEM_PROMPT = [
  "You predict the next message a USER will type in a chat with a design agent inside a canvas design editor.",
  "Output ONLY the predicted message text — no quotes, no prefix, no explanation.",
  "The user's previous messages are your style samples: match their language, tone, length, capitalization and punctuation exactly.",
  "If the agent's last message asked a question, predict the user's answer to it. Otherwise predict the user's most likely next task.",
  "Prefer short, concrete messages (usually under 12 words).",
  "Never suggest something the agent has already done.",
  "If you have no confident prediction, output exactly NONE.",
].join("\n");

const MAX_SUGGESTION_LENGTH = 300;
const TIMEOUT_MS = 8000;

function buildPrompt(messages: SuggestionMessage[]): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "USER" : "AGENT"}: ${m.text}`)
    .join("\n\n");
  return `Conversation so far:\n\n${transcript}\n\nPredict the USER's next message.`;
}

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "\u201c": "\u201d",
  "\u2018": "\u2019",
  "\u00ab": "\u00bb",
};

/** Strips wrapping quote pairs only; quotes inside or at one end stay. */
function unwrapQuotes(input: string): string {
  let text = input;
  while (text.length >= 2) {
    const close = QUOTE_PAIRS[text[0]!];
    if (close === undefined || text[text.length - 1] !== close) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Normalizes raw model output; null means "show no suggestion". */
export function cleanSuggestion(raw: string): string | null {
  let text = raw.trim();
  text = text.split(/\r?\n/)[0]?.trim() ?? "";
  text = unwrapQuotes(text);
  if (!text || /^none\.?$/i.test(text) || text.length > MAX_SUGGESTION_LENGTH) {
    return null;
  }
  return text;
}

export async function generatePromptSuggestion(
  messages: SuggestionMessage[],
  config: Config,
  signal?: AbortSignal,
): Promise<string | null> {
  const { text } = await generateText({
    // Helper-role model, never the chat model. Reasoning off: this is a
    // latency-critical one-liner (createModel handles OpenRouter families
    // that reject a missing reasoning setting).
    model: createModel(config, config.PROMPT_SUGGESTION_MODEL, {
      reasoningEffort: "none",
    }),
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(messages),
    maxOutputTokens: 120,
    temperature: 0.3,
    maxRetries: 0,
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS),
  });
  return cleanSuggestion(text);
}
