import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./structuredModelFakes.js")).mockProviderModule(await importOriginal()),
);

import { createModel } from "./structuredModelFakes.js";

const { cleanSuggestion, generatePromptSuggestion } = await import("../src/ai/prompt-suggestion.js");
const { buildApp } = await import("../src/app.js");

function textModel(text: string, onPrompt?: (p: string) => void): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (opts: { prompt: unknown }) => {
      onPrompt?.(JSON.stringify(opts.prompt));
      return {
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        content: [{ type: "text", text }],
      };
    },
  });
}

const messages = [
  { role: "user", text: "сделай кнопку покруглее" },
  { role: "assistant", text: "Готово. Нужно что-то ещё?" },
];

async function post(body: unknown) {
  const app = await buildApp(makeConfig(), { logger: false });
  const res = await app.inject({ method: "POST", url: "/api/prompt-suggestion", payload: body as object });
  await app.close();
  return res;
}

describe("POST /api/prompt-suggestion", () => {
  it("returns a trimmed suggestion", async () => {
    createModel.mockReturnValueOnce(textModel("  сделай шрифт крупнее  \n"));
    const res = await post({ messages });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggestion: "сделай шрифт крупнее" });
  });

  it("maps NONE to null", async () => {
    createModel.mockReturnValueOnce(textModel("NONE"));
    const res = await post({ messages });
    expect(res.json()).toEqual({ suggestion: null });
  });

  it("strips surrounding quotes and keeps only the first line", async () => {
    createModel.mockReturnValueOnce(textModel('"make it blue"\nbecause reasons'));
    const res = await post({ messages });
    expect(res.json()).toEqual({ suggestion: "make it blue" });
  });

  it("drops over-long output", async () => {
    createModel.mockReturnValueOnce(textModel("x".repeat(301)));
    const res = await post({ messages });
    expect(res.json()).toEqual({ suggestion: null });
  });

  it("responds 200 null when the model errors", async () => {
    createModel.mockReturnValueOnce(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await post({ messages });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggestion: null });
  });

  it("400s on an invalid body", async () => {
    expect((await post({ messages: [] })).statusCode).toBe(400);
    expect((await post({ messages: [{ role: "system", text: "x" }] })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });

  it("400s when there is no user message", async () => {
    const res = await post({ messages: [{ role: "assistant", text: "hi" }] });
    expect(res.statusCode).toBe(400);
  });

  it("sends the conversation, including the user's messages, to the model", async () => {
    let captured = "";
    createModel.mockReturnValueOnce(textModel("ok", (p) => (captured = p)));
    await post({ messages });
    expect(captured).toContain("сделай кнопку покруглее");
    expect(captured).toContain("Нужно что-то ещё?");
  });

  it("rejects oversized bodies", async () => {
    const many = Array.from({ length: 21 }, () => ({ role: "user", text: "hi" }));
    expect((await post({ messages: many })).statusCode).toBe(400);
    expect((await post({ messages: [{ role: "user", text: "x".repeat(2001) }] })).statusCode).toBe(400);
  });
});

describe("cleanSuggestion quotes", () => {
  it("keeps quotes around a trailing word", () => {
    expect(cleanSuggestion('change the title to "Welcome"')).toBe('change the title to "Welcome"');
  });
  it("unwraps fully wrapped text", () => {
    expect(cleanSuggestion('"make it blue"')).toBe("make it blue");
    expect(cleanSuggestion("\u201cmake it blue\u201d")).toBe("make it blue");
    expect(cleanSuggestion("\u00abmake it blue\u00bb")).toBe("make it blue");
    expect(cleanSuggestion('"\'make it blue\'"')).toBe("make it blue");
  });
});

describe("generatePromptSuggestion abort", () => {
  it("passes the caller's abort signal to the model call", async () => {
    let seen: AbortSignal | undefined;
    createModel.mockReturnValueOnce(
      new MockLanguageModelV3({
        doGenerate: async (opts: { abortSignal?: AbortSignal }) => {
          seen = opts.abortSignal;
          await new Promise((_r, rej) => {
            if (seen?.aborted) rej(seen.reason);
            seen?.addEventListener("abort", () => rej(seen!.reason));
          });
          throw new Error("unreachable");
        },
      }),
    );
    const controller = new AbortController();
    const p = generatePromptSuggestion(messages, makeConfig(), controller.signal);
    controller.abort();
    await expect(p).rejects.toBeDefined();
    expect(seen?.aborted).toBe(true);
  });
});
