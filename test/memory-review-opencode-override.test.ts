import { describe, expect, it, vi } from "vitest";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { loadLocalConfig } from "../src/local/config.js";
import {
  capturingGenerateModel,
  fakeReviewCounterStore,
  reviewInput,
  textResult,
  throwingGenerateModel,
  toolCallResult,
} from "./reviewFakes.js";

// Regression (defect 2): the background review is a helper role, like
// ANALYSIS_MODEL/VISION_MODEL/STRUCTURED_MODEL — per
// docs/specs/2026-09-18-opencode-byok-design.md, helper roles deliberately
// stay on OpenRouter and never spend the user's own OpenCode key.
// `maybeRunReview` used to pass the CHAT turn's `modelOverride` straight
// into `createModel(config, input.modelOverride)` with no `opencodeApiKey`
// — but `MaybeRunReviewInput` never carries that key at all (see
// runReviewSafe's only caller, src/routes/chat.ts, which never threads
// `opencodeApiKey` into the review). createModel throws for any
// OpenCode-provider ref with no key (src/ai/provider.ts), and
// `runReviewSafe` only `console.error`s a rejected promise — so every user
// who picked an OpenCode model in the composer silently lost the entire
// memory/skill review loop on every turn.
//
// createModel itself is mocked (as in test/memory-review.test.ts) so this
// test never depends on real network access or a real OpenRouter/OpenCode
// call — only on WHICH model reference maybeRunReview resolves to pass it.
const capturedCreateModelCalls: Array<{
  modelOverride: string | undefined;
  options: unknown;
}> = [];

const holders = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("../src/ai/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return {
    ...actual,
    createModel: vi.fn((_config: unknown, modelOverride?: string, options?: unknown) => {
      capturedCreateModelCalls.push({ modelOverride, options });
      return holders.model;
    }),
  };
});

const reviewModel = (result: LanguageModelV4GenerateResult) => capturingGenerateModel([], result);

const MESSAGES: ModelMessage[] = [{ role: "user", content: "remember I like short answers" }];

function input(overrides: Record<string, unknown> = {}) {
  return reviewInput(
    { store: fakeReviewCounterStore({ memoryReviewDue: true }), modelMessages: MESSAGES },
    overrides,
  );
}

describe("maybeRunReview with a user-picked OpenCode modelOverride", () => {
  it("does not pass the OpenCode ref to createModel and does not throw — it falls back to CHAT_MODEL", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    const outcome = await maybeRunReview(
      input({ modelOverride: "opencode-go/glm-5.3-flash" }),
    );

    // Without the fix, createModel(config, "opencode-go/glm-5.3-flash")
    // throws synchronously inside the try block (no opencodeApiKey ever
    // reaches maybeRunReview), which the outer catch reports as "failed" —
    // that is the silent-death symptom the bug report describes.
    expect(outcome).toBe("ran");
    expect(capturedCreateModelCalls).toHaveLength(1);
    // The OpenCode ref must NOT have reached createModel — it must have
    // been swapped for `undefined` (createModel's own "use config.CHAT_MODEL"
    // default), not for the literal opencode string.
    expect(capturedCreateModelCalls[0].modelOverride).toBeUndefined();
  });

  it("still passes an OpenRouter modelOverride through unchanged", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    const outcome = await maybeRunReview(
      input({ modelOverride: "google/gemini-2.5-flash" }),
    );

    expect(outcome).toBe("ran");
    expect(capturedCreateModelCalls).toHaveLength(1);
    expect(capturedCreateModelCalls[0].modelOverride).toBe("google/gemini-2.5-flash");
  });
});

// The user's own provider: a byok/ model is reviewed on the user's model with
// the credentials of the turn that picked it (Sideform Light has no other).
describe("maybeRunReview with a byok/ modelOverride", () => {
  const CREDS = { baseUrl: "https://llm.example.com/v1", apiKey: "sk-user-very-secret" };
  const localConfig = () => ({ ...loadLocalConfig({}), MEMORY_REVIEW_INTERVAL: 1 });

  it("hosted: a byok model WITH credentials still falls back to CHAT_MODEL (never spends the user's key)", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    const outcome = await maybeRunReview(input({ modelOverride: "byok/my-model", byok: CREDS }));

    expect(outcome).toBe("ran");
    expect(capturedCreateModelCalls).toEqual([{ modelOverride: undefined, options: undefined }]);
  });

  it("hosted: a byok model without credentials keeps the old fallback (CHAT_MODEL)", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));

    for (const byok of [undefined, { baseUrl: "", apiKey: "k" }, { baseUrl: CREDS.baseUrl, apiKey: "  " }]) {
      expect(await maybeRunReview(input({ modelOverride: "byok/my-model", byok }))).toBe("ran");
    }
    expect(capturedCreateModelCalls.map((c) => c.modelOverride)).toEqual([undefined, undefined, undefined]);
    expect(capturedCreateModelCalls.every((c) => c.options === undefined)).toBe(true);
  });

  it("local mode: no usable model skips the review cleanly, without touching counters, audit or logs", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const store = fakeReviewCounterStore({ memoryReviewDue: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const extra of [{}, { modelOverride: "byok/my-model" }, { modelOverride: "opencode-go/x" }]) {
      expect(await maybeRunReview(input({ config: localConfig(), store, ...extra }))).toBe("disabled");
    }
    expect(capturedCreateModelCalls).toEqual([]);
    expect(store.bumpCounters).not.toHaveBeenCalled();
    expect(store.writeAudit).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("local mode: byok model + credentials runs the review on the user's model", async () => {
    capturedCreateModelCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeReviewCounterStore({ memoryReviewDue: true });

    const outcome = await maybeRunReview(input({ config: localConfig(), store, modelOverride: "byok/my-model", byok: CREDS }));

    expect(outcome).toBe("ran");
    expect(store.bumpCounters).toHaveBeenCalledTimes(1);
    expect(capturedCreateModelCalls).toEqual([{ modelOverride: "byok/my-model", options: { byok: CREDS } }]);
  });

  it("never writes the credentials into the audit row or the log, even when the provider echoes them", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = throwingGenerateModel(`401 for key ${CREDS.apiKey} at ${CREDS.baseUrl}`);
    const store = fakeReviewCounterStore({ memoryReviewDue: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await maybeRunReview(input({ config: localConfig(), store, modelOverride: "byok/my-model", byok: CREDS }));

    expect(outcome).toBe("disabled");
    const audited = JSON.stringify((store.writeAudit as ReturnType<typeof vi.fn>).mock.calls);
    expect(audited).toContain("failed");
    expect(audited).not.toContain(CREDS.apiKey);
    expect(audited).not.toContain(CREDS.baseUrl);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(CREDS.apiKey);
    spy.mockRestore();
  });

  it("never writes the credentials into the audit row of a successful run", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textResult("Nothing to save."));
    const store = fakeReviewCounterStore({ memoryReviewDue: true });
    await maybeRunReview(input({ config: localConfig(), store, modelOverride: "byok/my-model", byok: CREDS }));
    const audited = JSON.stringify((store.writeAudit as ReturnType<typeof vi.fn>).mock.calls);
    expect(audited).toContain("nothing-saved");
    expect(audited).not.toContain(CREDS.apiKey);
  });

  it("browser-mode tools (browse_agent, ask_user, schedule_*) are stubbed during the review, never run", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const clientSide = (name: string) => tool({ description: name, inputSchema: z.object({ goal: z.string() }) });
    const turnTools = Object.fromEntries(["browse_agent", "ask_user", "schedule_create", "trace_read"].map((n) => [n, clientSide(n)]));
    const calls: Array<{ prompt: unknown }> = [];
    holders.model = capturingGenerateModel(
      calls as never,
      toolCallResult("browse_agent", { goal: "open a site" }),
      toolCallResult("schedule_create", { goal: "every day" }),
      textResult("Nothing to save."),
    );
    const store = fakeReviewCounterStore({ memoryReviewDue: true });
    const outcome = await maybeRunReview(input({ config: localConfig(), store, turnTools, modelOverride: "byok/my-model", byok: CREDS }));
    expect(outcome).toBe("ran");
    const audited = JSON.stringify((store.writeAudit as ReturnType<typeof vi.fn>).mock.calls);
    expect(audited).toContain("browse_agent");
    expect(audited).toContain("nothing-saved");
    // The model got the harmless stub text back for both off-script calls.
    const lastPrompt = JSON.stringify(calls[calls.length - 1].prompt);
    expect(lastPrompt.match(/not available during a background self-improvement review/g)).toHaveLength(2);
  });
});
