import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { pickTheme } from "../src/showcase/themes.js";
import { bareModelId } from "../src/ai/provider.js";
import { TASTE_RULES } from "../src/ai/tasteCheck.js";
import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Mocks: same seam as test/chat-route.test.ts — the provider and MCP layer
// are mocked so the runner never touches the network. runShowcaseGeneration
// goes through prepareChatTurn -> createModel/getMCPTools, so mocking those
// two modules is enough to control what "the LLM" does in each test.
// ---------------------------------------------------------------------------

const holders = vi.hoisted(() => ({
  model: undefined as unknown,
}));

vi.mock("../src/ai/provider.js", async (importOriginal) => {
  // Only createModel is faked — bareModelId (and anything else the module
  // exports) must stay the REAL implementation, since src/showcase/runner.ts
  // calls bareModelId on the model id it returns as ShowcaseRunResult.model.
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return { ...actual, createModel: vi.fn(() => holders.model) };
});

const imageGenMock = vi.hoisted(() => ({ generateImage: vi.fn() }));
vi.mock("../src/services/imageGen.js", () => imageGenMock);

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCallResult(
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `call-${toolName}-${Math.random()}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: USAGE,
    warnings: [],
  };
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

// MockLanguageModelV3's array form of `doGenerate` indexes by
// `doGenerateCalls.length` *after* pushing the current call — i.e. 1-based,
// not 0-based — so passing the results array directly skips index 0 and
// eventually reads past the end. A plain counter avoids that off-by-one.
function mockModel(results: LanguageModelV3GenerateResult[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return result;
    },
  });
}

// Same shape as mockModel, but an entry may be an Error to throw instead of
// a result — used to simulate a retryable mid-turn failure (e.g. one that
// happens after batch_design already ran for that attempt).
function mockModelWithFailure(
  results: Array<LanguageModelV3GenerateResult | Error>,
): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  });
}

describe("runShowcaseGeneration", () => {
  let runShowcaseGeneration: typeof import("../src/showcase/runner.js").runShowcaseGeneration;
  let MAX_GENERATED_IMAGES: number;
  let SHOWCASE_MODEL_ID: string;

  beforeAll(async () => {
    await loadSkills();
    ({ runShowcaseGeneration, MAX_GENERATED_IMAGES, SHOWCASE_MODEL_ID } = await import(
      "../src/showcase/runner.js"
    ));
  });

  beforeEach(() => {
    holders.model = mockModel([textResult("ok")]);
    imageGenMock.generateImage.mockReset();
  });

  it("collects embed screens produced via batch_design", async () => {
    holders.model = mockModel([
      toolCallResult("batch_design", {
        operations: [
          's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>Home</div>"})',
          's2=I(document, {type: "embed", name: "Profile", htmlContent: "<div>Profile</div>"})',
        ].join("\n"),
      }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(result.theme).toBe("fitness tracker");
    // Bare — no provider prefix — since this is what gets written into
    // showcase_screens.model (see src/ai/provider.ts's central invariant).
    expect(result.model).toBe(bareModelId(SHOWCASE_MODEL_ID));
    expect(result.screens).toEqual([
      { name: "Home", htmlContent: "<div>Home</div>" },
      { name: "Profile", htmlContent: "<div>Profile</div>" },
    ]);
  });

  it("does not mix screens from a failed attempt into the retried attempt's result", async () => {
    // Attempt 1: batch_design records a screen, then the next step throws a
    // retryable error (simulating a flaky model aborting mid-turn, as
    // minimax-m3 is known to do). Attempt 2 (fresh accumulators) records a
    // different screen and finishes cleanly. Only attempt 2's screen should
    // survive — attempt 1's must not leak into the final result.
    holders.model = mockModelWithFailure([
      toolCallResult("batch_design", {
        operations:
          's1=I(document, {type: "embed", name: "AttemptA", htmlContent: "<div>A</div>"})',
      }),
      new Error("503 Service Unavailable"),
      toolCallResult("batch_design", {
        operations:
          's1=I(document, {type: "embed", name: "AttemptB", htmlContent: "<div>B</div>"})',
      }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(result.screens).toEqual([{ name: "AttemptB", htmlContent: "<div>B</div>" }]);
  });

  it("does not hang or throw when the model calls an unavailable tool like get_screenshot-equivalent stubs", async () => {
    holders.model = mockModel([
      toolCallResult("get_editor_state", { include_schema: false }),
      toolCallResult("batch_design", {
        operations: 's1=I(document, {type: "embed", name: "Only", htmlContent: "<div>Only</div>"})',
      }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "мобильный банк");

    expect(result.screens).toEqual([{ name: "Only", htmlContent: "<div>Only</div>" }]);
  });

  it("does not offer get_screenshot, remove_background, or vectorize_image — no browser, no scene graph", async () => {
    // The system prompt recommends get_screenshot for verifying a finished
    // screen, so advertising it here would buy a guaranteed-wasted step in
    // every autonomous run.
    // remove_background/vectorize_image assume a scene graph node (node_id)
    // or native vector layers to act on, and this mode only ever produces
    // raw embed HTML — same reasoning chatTurn.ts's embed-only gate applies
    // for prototype/slides turns.
    // analyze_image is backend-executed and stays.
    // FAL_KEY is set so the absence below is proved by the runner's own
    // deletion, not by chatTurn.ts's separate FAL_KEY gate.
    const offered: string[][] = [];
    let call = 0;
    const results = [textResult("done")];
    holders.model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        offered.push((options.tools ?? []).map((t) => t.name));
        const result = results[Math.min(call, results.length - 1)];
        call += 1;
        return result;
      },
    });

    await runShowcaseGeneration(makeConfig({ FAL_KEY: "test-fal-key" }), "мобильный банк");

    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) {
      expect(names).not.toContain("get_screenshot");
      expect(names).not.toContain("remove_background");
      expect(names).not.toContain("vectorize_image");
      expect(names).toContain("analyze_image");
    }
  });

  it("truncates to at most 5 screens when the model produces more", async () => {
    const operations = Array.from(
      { length: 7 },
      (_, i) =>
        `s${i}=I(document, {type: "embed", name: "Screen ${i}", htmlContent: "<div>${i}</div>"})`,
    ).join("\n");

    holders.model = mockModel([
      toolCallResult("batch_design", { operations }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "каршеринг");

    expect(result.screens).toHaveLength(5);
    expect(result.screens.map((s) => s.name)).toEqual([
      "Screen 0",
      "Screen 1",
      "Screen 2",
      "Screen 3",
      "Screen 4",
    ]);
  });


  it("keeps every unnamed embed screen instead of clobbering them via replace-by-name", async () => {
    // extractEmbedScreens defaults an unnamed embed's name to "Untitled"
    // (src/showcase/extractEmbeds.ts, DEFAULT_SCREEN_NAME). Replace-by-name
    // must never treat that filler as a real identity — otherwise every
    // unnamed screen after the first looks like a re-emission of the same
    // "Untitled" screen and clobbers it instead of being appended.
    const operations = Array.from(
      { length: 5 },
      (_, i) => `s${i}=I(document, {type: "embed", htmlContent: "<div>${i}</div>"})`,
    ).join("\n");

    holders.model = mockModel([
      toolCallResult("batch_design", { operations }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "каршеринг");

    expect(result.screens).toHaveLength(5);
    expect(result.screens.every((s) => s.name === "Untitled")).toBe(true);
  });

  it("puts a generated image URL in front of the model instead of a placeholder", async () => {
    imageGenMock.generateImage.mockResolvedValue({
      url: "https://s3.test/generated.png",
      mimeType: "image/png",
    });
    holders.model = mockModel([
      toolCallResult("generate_image", { prompt: "hero shot of a running trail at dawn" }),
      textResult("done"),
    ]);

    await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(imageGenMock.generateImage).toHaveBeenCalledOnce();
    const [, prompt] = imageGenMock.generateImage.mock.calls[0];
    expect(prompt).toContain("running trail");
  });

  // A timed-out image must not take the run down with it, and must not leave a
  // hole in the design — the agent needs a usable URL back either way.
  it("answers with a placeholder URL when image generation fails", async () => {
    imageGenMock.generateImage.mockRejectedValue(new Error("timed out"));
    holders.model = mockModel([
      toolCallResult("generate_image", { prompt: "hero shot" }),
      toolCallResult("batch_design", {
        operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>x</div>"})',
      }),
      textResult("done"),
    ]);

    const result = await runShowcaseGeneration(makeConfig(), "fitness tracker");

    // The run completed and still produced its screen.
    expect(result.screens).toHaveLength(1);
  });

  it("stops generating past the per-run image budget", async () => {
    imageGenMock.generateImage.mockResolvedValue({
      url: "https://s3.test/generated.png",
      mimeType: "image/png",
    });
    // Always answer with another generate_image call; the cap — not the model
    // — has to be what stops the spend.
    holders.model = mockModel([
      toolCallResult("generate_image", { prompt: "another one" }),
    ]);

    await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(imageGenMock.generateImage.mock.calls.length).toBe(MAX_GENERATED_IMAGES);
  });

  it("returns an empty screens array without throwing when nothing was produced", async () => {
    holders.model = mockModel([textResult("I could not complete this task.")]);

    const result = await runShowcaseGeneration(makeConfig(), "трекер расходов");

    expect(result.screens).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Finding #3: an attempt that finishes cleanly without ever calling
  // batch_design (the minimax-m3 failure mode the retry exists for) must be
  // retried like a thrown transient error, not silently accepted as "0
  // screens" on the very first try.
  // -------------------------------------------------------------------------

  it("finding #3: retries an attempt that harvested zero screens, and returns the retried attempt's screens", async () => {
    let calls = 0;
    const results: LanguageModelV3GenerateResult[] = [
      // Attempt 1: a single clean-finish step, no batch_design call at all.
      textResult("nothing to see here"),
      // Attempt 2: a real screen, then a clean finish.
      toolCallResult("batch_design", {
        operations:
          's1=I(document, {type: "embed", name: "Recovered", htmlContent: "<div>ok</div>"})',
      }),
      textResult("done"),
    ];
    holders.model = new MockLanguageModelV3({
      doGenerate: async () => {
        const result = results[Math.min(calls, results.length - 1)];
        calls++;
        return result;
      },
    });

    const result = await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(result.screens).toEqual([{ name: "Recovered", htmlContent: "<div>ok</div>" }]);
    expect(calls).toBe(3);
  });

  it("finding #3: an empty harvest on every attempt still ends the run without throwing (today's behavior), after exhausting the retry budget", async () => {
    let calls = 0;
    holders.model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return textResult("I could not complete this task.");
      },
    });

    const result = await runShowcaseGeneration(makeConfig(), "трекер расходов");

    expect(result.screens).toEqual([]);
    // Initial attempt + 2 retries (DEFAULT_AGENT_RETRY.maxRetries) = 3 model
    // calls, each a single clean-finish step.
    expect(calls).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Finding #2: the generated-image budget must be shared across every
  // attempt of one run, not reset per attempt.
  // ---------------------------------------------------------------------------

  it("finding #2: keeps the image budget spent across a retried attempt instead of resetting it", async () => {
    imageGenMock.generateImage.mockResolvedValue({
      url: "https://s3.test/generated.png",
      mimeType: "image/png",
    });

    const attempt1ImageCalls = Array.from({ length: MAX_GENERATED_IMAGES }, (_, i) =>
      toolCallResult("generate_image", { prompt: `image ${i}` }),
    );
    holders.model = mockModelWithFailure([
      ...attempt1ImageCalls,
      // Burns attempt 1's budget on 8 real generations, then a retryable
      // failure forces a fresh attempt.
      new Error("503 Service Unavailable"),
      // Attempt 2: one more generate_image call — must be served a
      // placeholder from the SAME (already-spent) budget, not a 9th real
      // generation — then a real screen so the run doesn't also trip
      // finding #3's empty-harvest retry.
      toolCallResult("generate_image", { prompt: "one more after retry" }),
      toolCallResult("batch_design", {
        operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>x</div>"})',
      }),
      textResult("done"),
    ]);

    await runShowcaseGeneration(makeConfig(), "fitness tracker");

    expect(imageGenMock.generateImage.mock.calls.length).toBe(MAX_GENERATED_IMAGES);
  });

  // -------------------------------------------------------------------------
  // Taste-check integration (src/ai/tasteCheck.ts wired into batch_design's
  // execute — see the module's own header comment in runner.ts).
  // -------------------------------------------------------------------------
  describe("taste-check integration", () => {
    function jevResponse(overrides: Record<string, number> = {}) {
      const answers: Record<string, unknown> = {};
      for (const rule of TASTE_RULES) {
        answers[rule.id] = { type: "noul", noul: overrides[rule.id] ?? 0 };
      }
      return new Response(
        JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    /** Extracts the JSON-parsed batch_design tool result from the prompt
     * fed into the model's NEXT step (the tool-result message the runner's
     * batch_design execute() just produced). */
    function batchDesignResult(prompt: unknown): Record<string, unknown> {
      const messages = prompt as ModelMessage[];
      const toolMessage = [...messages].reverse().find((m) => m.role === "tool");
      const part = (toolMessage!.content as Array<{ toolName: string; output: { value: string } }>).find(
        (p) => p.toolName === "batch_design",
      );
      return JSON.parse(part!.output.value) as Record<string, unknown>;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("replaces a screen in place when the model re-emits it with the same name, instead of duplicating it", async () => {
      holders.model = mockModel([
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>A</div>"})',
        }),
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>B (fixed)</div>"})',
        }),
        textResult("done"),
      ]);

      const result = await runShowcaseGeneration(makeConfig(), "fitness tracker");

      expect(result.screens).toEqual([{ name: "Home", htmlContent: "<div>B (fixed)</div>" }]);
    });

    it("does not call Jev at all when TASTE_CHECK_MODE is off (default)", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      holders.model = mockModel([
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>x</div>"})',
        }),
        textResult("done"),
      ]);

      await runShowcaseGeneration(makeConfig({ TYPESAFE_API_KEY: "key" }), "fitness tracker");

      expect(fetchSpy).not.toHaveBeenCalled();
      // Off mode must skip runTasteCheck entirely — not just fail-open inside
      // it — so there is no "[tasteCheck] ..." log line at all in that case.
      const tasteCheckLogs = logSpy.mock.calls.filter((call) =>
        String(call[0]).startsWith("[tasteCheck]"),
      );
      expect(tasteCheckLogs).toHaveLength(0);
      logSpy.mockRestore();
    });

    it("never taste-checks a screen that was dropped beyond the screen cap", async () => {
      // 7 screens in one batch_design call: only the first MAX_SHOWCASE_SCREENS
      // (5) are recorded, the rest are dropped. Jev must only be asked about
      // the 5 that were actually kept.
      const fetchMock = vi.fn(async () => jevResponse());
      vi.stubGlobal("fetch", fetchMock);
      const operations = Array.from(
        { length: 7 },
        (_, i) => `s${i}=I(document, {type: "embed", name: "Screen ${i}", htmlContent: "<div>${i}</div>"})`,
      ).join("\n");
      const prompts: unknown[] = [];
      let call = 0;
      const results = [toolCallResult("batch_design", { operations }), textResult("done")];
      holders.model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          const result = results[Math.min(call, results.length - 1)];
          call++;
          return result;
        },
      });

      await runShowcaseGeneration(
        makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "shadow" }),
        "каршеринг",
      );

      // checkOneScreen (src/ai/tasteCheck.ts) issues one evaluate() call per
      // screen — 5 kept screens -> 5 calls, none of them for the 2 dropped.
      expect(fetchMock).toHaveBeenCalledTimes(5);
      const sentNames = fetchMock.mock.calls.map((call) => {
        const body = JSON.parse((call[1] as { body: string }).body) as {
          state: { screen?: { name?: string } };
        };
        return body.state.screen?.name;
      });
      expect(sentNames.sort()).toEqual(
        ["Screen 0", "Screen 1", "Screen 2", "Screen 3", "Screen 4"].sort(),
      );
    });

    it("appends tasteCheck feedback to the batch_design result in enforce mode when Jev finds an issue", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jevResponse({ gradient_text: 0.9 })));
      const prompts: unknown[] = [];
      let call = 0;
      const results = [
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>x</div>"})',
        }),
        textResult("done"),
      ];
      holders.model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          const result = results[Math.min(call, results.length - 1)];
          call++;
          return result;
        },
      });

      await runShowcaseGeneration(
        makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "enforce" }),
        "fitness tracker",
      );

      const secondStepResult = batchDesignResult(prompts[1]);
      expect(secondStepResult.tasteCheck).toContain("Home");
      expect(secondStepResult.tasteCheck).toContain("round 1/2");
    });

    it("stops checking a screen name after MAX_TASTE_CHECK_ROUNDS (2) even if the model keeps re-emitting it", async () => {
      const fetchMock = vi.fn(async () => jevResponse({ emoji_icons: 0.9 }));
      vi.stubGlobal("fetch", fetchMock);
      const prompts: unknown[] = [];
      let call = 0;
      const results = [
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>v1</div>"})',
        }),
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>v2</div>"})',
        }),
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>v3</div>"})',
        }),
        textResult("done"),
      ];
      holders.model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          const result = results[Math.min(call, results.length - 1)];
          call++;
          return result;
        },
      });

      await runShowcaseGeneration(
        makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "enforce" }),
        "fitness tracker",
      );

      // Round 1 (after v1) and round 2 (after v2) both check; the third
      // re-emission (v3) has already used up its 2 rounds and must not
      // trigger a THIRD Jev call.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const thirdStepResult = batchDesignResult(prompts[3]);
      expect(thirdStepResult.tasteCheck).toBeUndefined();
    });

    it("keeps working unchanged when TYPESAFE_API_KEY is unset, even with TASTE_CHECK_MODE=enforce", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      holders.model = mockModel([
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>x</div>"})',
        }),
        textResult("done"),
      ]);

      const result = await runShowcaseGeneration(
        makeConfig({ TYPESAFE_API_KEY: undefined, TASTE_CHECK_MODE: "enforce" }),
        "fitness tracker",
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.screens).toEqual([{ name: "Home", htmlContent: "<div>x</div>" }]);
    });

    it("never taste-checks an unnamed (default-name) screen", async () => {
      // TASTE_CHECK_FIX_HINT tells the model to fix a flagged screen "by
      // re-emitting it with batch_design (same screen name)" — but an
      // unnamed screen is always APPENDED, never replaced (see the
      // replace-by-name comment in runner.ts), so a re-emission would just
      // publish a second, unfixed copy. Unnamed screens must therefore never
      // reach Jev at all.
      const fetchMock = vi.fn(async () => jevResponse());
      vi.stubGlobal("fetch", fetchMock);
      holders.model = mockModel([
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", htmlContent: "<div>x</div>"})',
        }),
        textResult("done"),
      ]);

      const result = await runShowcaseGeneration(
        makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "enforce" }),
        "fitness tracker",
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.screens).toEqual([{ name: "Untitled", htmlContent: "<div>x</div>" }]);
    });

    it("collapses duplicate explicit names within ONE batch_design call to a single Jev check and a single round", async () => {
      const fetchMock = vi.fn(async () => jevResponse());
      vi.stubGlobal("fetch", fetchMock);
      const prompts: unknown[] = [];
      let call = 0;
      const results = [
        toolCallResult("batch_design", {
          operations: [
            's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>v1</div>"})',
            's2=I(document, {type: "embed", name: "Home", htmlContent: "<div>v2 (final)</div>"})',
          ].join("\n"),
        }),
        textResult("done"),
      ];
      holders.model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          const result = results[Math.min(call, results.length - 1)];
          call++;
          return result;
        },
      });

      const result = await runShowcaseGeneration(
        makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "enforce" }),
        "fitness tracker",
      );

      // Storage itself already collapses the duplicate to one stored screen
      // (last-wins).
      expect(result.screens).toEqual([{ name: "Home", htmlContent: "<div>v2 (final)</div>" }]);
      // Exactly one Jev evaluate() call for the pair, not two.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sentHtml = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
        state: { screen?: { html?: string } };
      };
      expect(sentHtml.state.screen?.html).toContain("v2 (final)");
      // One round spent, not two — round label on the returned feedback says
      // "1", and it must still be eligible for one more automated round.
      const secondStepResult = batchDesignResult(prompts[1]);
      expect(secondStepResult.tasteCheck).toBeUndefined(); // no findings from the clean jevResponse()
    });

    it("resets taste-check rounds for a retried attempt instead of carrying them over from the discarded one", async () => {
      // Attempt 1 gets its screen checked (spending round 1 of
      // MAX_TASTE_CHECK_ROUNDS), then the turn fails with a retryable error.
      // Attempt 2 is a fresh conversation — the model re-emits "Home" again,
      // and that check must ALSO land as round 1, not round 2, because the
      // whole attempt (and its round counter) was discarded, not resumed.
      const fetchMock = vi.fn(async () => jevResponse({ emoji_icons: 0.9 }));
      vi.stubGlobal("fetch", fetchMock);
      const prompts: unknown[] = [];
      let call = 0;
      const results: Array<LanguageModelV3GenerateResult | Error> = [
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>attempt1</div>"})',
        }),
        new Error("503 Service Unavailable"),
        toolCallResult("batch_design", {
          operations: 's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>attempt2</div>"})',
        }),
        textResult("done"),
      ];
      holders.model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(options.prompt);
          const result = results[Math.min(call, results.length - 1)];
          call++;
          if (result instanceof Error) throw result;
          return result;
        },
      });

      const result = await runShowcaseGeneration(
        makeConfig({ TYPESAFE_API_KEY: "key", TASTE_CHECK_MODE: "enforce" }),
        "fitness tracker",
      );

      expect(result.screens).toEqual([{ name: "Home", htmlContent: "<div>attempt2</div>" }]);
      // Both attempts' checks happened — attempt 1's before it failed,
      // attempt 2's after the retry.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Attempt 2's own batch_design result (the tool result fed into its
      // very next step, the LAST prompt the model saw) must say "round 1",
      // proving its round counter was NOT carried over from attempt 1 as
      // "round 2".
      const attempt2Result = batchDesignResult(prompts[prompts.length - 1]);
      expect(attempt2Result.tasteCheck).toContain("round 1/2");
    });
  });
});

describe("buildShowcasePrompt", () => {
  // Imported the same lazy way as runShowcaseGeneration above: runner.js pulls
  // in the skills registry at module load.
  let buildShowcasePrompt: typeof import("../src/showcase/runner.js").buildShowcasePrompt;

  beforeAll(async () => {
    await loadSkills();
    ({ buildShowcasePrompt } = await import("../src/showcase/runner.js"));
  });

  it("omits the palette clause when there is nothing to avoid", () => {
    const prompt = buildShowcasePrompt("sleep tracker");
    expect(prompt).not.toContain("Palette:");
    expect(buildShowcasePrompt("sleep tracker", { avoidHueFamilies: [] })).toBe(prompt);
  });

  it("names the hue families recent apps used and demands a different one", () => {
    const prompt = buildShowcasePrompt("sleep tracker", {
      avoidHueFamilies: ["terracotta/amber", "green/emerald"],
    });
    expect(prompt).toContain("terracotta/amber, green/emerald");
    expect(prompt).toContain("DIFFERENT family");
    // Narrowing the palette space must not read as "the banned colors are
    // back on the table" — the first rotated run answered the clause with
    // electric violet, the one accent the skill bans outright.
    expect(prompt).toContain("does NOT suspend any rule in the skill");
    expect(prompt).toMatch(/ban on purple/i);
    // Rotation and the skill's Calibration axis can pull against each other:
    // told to rotate off terracotta, a run can pick sage/forest green, keep
    // the warm ground, and land back in the same cluster the skill calls the
    // reassuring-naturals axis. The clause has to close that door itself —
    // the rotation is the only mechanism that knows an accent was forced.
    expect(prompt).toMatch(/reassuring-naturals axis/i);
    expect(prompt).toMatch(/re-pick the ground together with the accent/i);
    // The clause is phrased as the requester's requirement, and the skill's
    // naturals blocker exempts a design when "the brief asked for warmth in
    // its own words" — so the clause has to disclaim being that brief, or a
    // run can read it as a licence to keep the cream ground and pass both
    // checks at once.
    expect(prompt).toMatch(/never exempts the design/i);
    // The clause must not push the theme or the imagery instructions out.
    expect(prompt).toContain("/prototype mobile app — sleep tracker");
    expect(prompt).toContain("generate_image");
  });

  it("defaults to the mobile subject phrase when no platform is given", () => {
    expect(buildShowcasePrompt("sleep tracker")).toContain(
      "/prototype mobile app — sleep tracker",
    );
    expect(buildShowcasePrompt("sleep tracker", { platform: "mobile" })).toContain(
      "/prototype mobile app — sleep tracker",
    );
  });

  it("uses the desktop web app subject phrase for platform: desktop", () => {
    // This exact phrase is what routes src/skills/prototype.md into its
    // "Otherwise (default desktop)" device preset (1440x1024) instead of the
    // mobile/phone branch (390x844) — the skill matches on wording, not a
    // flag, so the literal string is load-bearing.
    const prompt = buildShowcasePrompt("sleep tracker", { platform: "desktop" });
    expect(prompt).toContain("/prototype desktop web app — sleep tracker");
    expect(prompt).not.toContain("mobile app");
    // The rest of the prompt (screen count, style, imagery) stays identical.
    expect(prompt).toContain("up to 5 screens of a single user flow");
    expect(prompt).toContain("generate_image");
  });
});

describe("pickTheme", () => {
  const themes = ["a", "b", "c"];

  it("avoids themes in the recent list when possible", () => {
    const theme = pickTheme(themes, ["a", "b"], () => 0.4);
    expect(theme).toBe("c");
  });

  it("falls back to the full list when every theme is recent", () => {
    const theme = pickTheme(themes, ["a", "b", "c"], () => 0.4);
    expect(themes).toContain(theme);
  });

  it("is deterministic given a fixed random() value", () => {
    expect(pickTheme(themes, [], () => 0)).toBe("a");
    expect(pickTheme(themes, [], () => 0.99)).toBe("c");
  });
});
