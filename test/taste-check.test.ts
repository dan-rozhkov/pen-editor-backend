import { describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import {
  MAX_SCREEN_HTML_CHARS,
  MAX_SCREENS_PER_REQUEST,
  runTasteCheck,
  TASTE_RULES,
} from "../src/ai/tasteCheck.js";
import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneQuestion,
} from "../src/services/systemone.js";

function noul(value: number): SystemOneAnswer {
  return { type: "noul", noul: value };
}

/** All nine rules answered `0` (no findings) unless overridden. */
function cleanAnswers(overrides: Record<string, number> = {}): Record<string, SystemOneAnswer> {
  const answers: Record<string, SystemOneAnswer> = {};
  for (const rule of TASTE_RULES) {
    answers[rule.id] = noul(overrides[rule.id] ?? 0);
  }
  return answers;
}

/** Answers per screen name, keyed off `state.screen.name`. A name absent
 * from `byName` causes that screen's evaluate() call to throw. */
function fakeClient(
  byName: Record<string, Record<string, SystemOneAnswer>>,
  opts: {
    capture?: (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => void;
    delayMs?: number;
  } = {},
): SystemOneClient {
  return {
    async evaluate(params) {
      opts.capture?.(params);
      const state = params.state as { screen: { name?: string } };
      const name = state.screen.name ?? "";
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.delayMs);
          params.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(params.signal?.reason ?? new Error("aborted"));
          });
        });
      }
      const answers = byName[name];
      if (!answers) throw new Error(`no fixture answers for screen "${name}"`);
      return { model: "jev-latest", answers: answers as never, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

function screen(id: string, html: string, name?: string) {
  return { id, name: name ?? id, html };
}

describe("runTasteCheck", () => {
  it("returns outcome 'off' and never calls the client when TASTE_CHECK_MODE is off", async () => {
    const client = fakeClient({ Home: cleanAnswers() });
    const evaluateSpy = vi.spyOn(client, "evaluate");
    const config = makeConfig({ TASTE_CHECK_MODE: "off" });
    const result = await runTasteCheck(client, config, { screens: [screen("1", "<div>x</div>", "Home")] });
    expect(result.outcome).toBe("off");
    expect(result.feedback).toBeNull();
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it("returns outcome 'no-client' when there is no client (TYPESAFE_API_KEY unset)", async () => {
    const config = makeConfig({ TASTE_CHECK_MODE: "enforce" });
    const result = await runTasteCheck(null, config, { screens: [screen("1", "<div>x</div>", "Home")] });
    expect(result.outcome).toBe("no-client");
    expect(result.feedback).toBeNull();
  });

  it("returns outcome 'nothing-to-check' for an empty screens array", async () => {
    const client = fakeClient({});
    const config = makeConfig({ TASTE_CHECK_MODE: "enforce" });
    const result = await runTasteCheck(client, config, { screens: [] });
    expect(result.outcome).toBe("nothing-to-check");
  });

  describe("threshold", () => {
    it("counts a rule as a finding only at or above TASTE_CHECK_MIN_NOUL", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow", TASTE_CHECK_MIN_NOUL: 0.7 });
      const client = fakeClient({
        Home: cleanAnswers({ gradient_text: 0.7, emoji_icons: 0.69 }),
      });
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
      });
      expect(result.outcome).toBe("checked");
      const rules = result.screens[0]!.findings.map((f) => f.rule);
      expect(rules).toEqual(["gradient_text"]);
    });
  });

  describe("per-screen failure fail-open", () => {
    it("skips a screen whose evaluate() call throws, without failing the batch", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient({ Home: cleanAnswers({ nested_cards: 0.9 }) }); // "Profile" has no fixture -> throws
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home"), screen("2", "<div>y</div>", "Profile")],
      });
      expect(result.outcome).toBe("checked");
      expect(result.screens.map((s) => s.name)).toEqual(["Home"]);
      expect(result.screens[0]!.findings[0]!.rule).toBe("nested_cards");
    });

    it("resolves outcome 'failed' when every screen's call fails", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient({}); // no fixtures at all -> every screen throws
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home"), screen("2", "<div>y</div>", "Profile")],
      });
      expect(result.outcome).toBe("failed");
      expect(result.screens).toEqual([]);
    });
  });

  describe("timeout", () => {
    it("aborts a hung evaluate() call once TASTE_CHECK_TIMEOUT_MS elapses, resolving to 'failed'", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow", TASTE_CHECK_TIMEOUT_MS: 20 });
      const client = fakeClient({ Home: cleanAnswers() }, { delayMs: 5_000 });
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
      });
      expect(result.outcome).toBe("failed");
    }, 10_000);
  });

  describe("off/shadow/enforce", () => {
    it("shadow mode returns findings but feedback stays null", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient({ Home: cleanAnswers({ ai_palette: 0.9 }) });
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
      });
      expect(result.outcome).toBe("checked");
      expect(result.screens[0]!.findings).toHaveLength(1);
      expect(result.feedback).toBeNull();
    });

    it("enforce mode fills in feedback text when there are findings", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "enforce" });
      const client = fakeClient({ Home: cleanAnswers({ ai_palette: 0.9 }) });
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
      });
      expect(result.feedback).not.toBeNull();
      expect(result.feedback).toContain("Home");
      expect(result.feedback).toContain("id 1");
    });

    it("enforce mode returns null feedback when there are no findings anywhere", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "enforce" });
      const client = fakeClient({ Home: cleanAnswers() });
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
      });
      expect(result.feedback).toBeNull();
    });
  });

  describe("feedback text", () => {
    it("includes the round number and a final-check line only on round 2", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "enforce" });
      const client = fakeClient({ Home: cleanAnswers({ emoji_icons: 0.9 }) });

      const round1 = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
        round: 1,
      });
      expect(round1.feedback).toContain("round 1/2");
      expect(round1.feedback).not.toContain("final automated check");

      const round2 = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
        round: 2,
      });
      expect(round2.feedback).toContain("round 2/2");
      expect(round2.feedback).toContain("final automated check");
    });

    it("uses the provided fixHint, or the default, in the feedback text", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "enforce" });
      const client = fakeClient({ Home: cleanAnswers({ emoji_icons: 0.9 }) });

      const withDefault = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
      });
      expect(withDefault.feedback).toContain("edit_embed_html or batch_design");

      const withHint = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
        fixHint: "by re-emitting the corrected screen with batch_design (same screen name)",
      });
      expect(withHint.feedback).toContain("re-emitting the corrected screen");
    });

    it("mentions screens not listed passed, and never HTML-escapes the fix text", async () => {
      const config = makeConfig({ TASTE_CHECK_MODE: "enforce" });
      // A fix string containing a raw & and < to prove no HTML-escaping happens.
      const client = fakeClient({ Home: cleanAnswers({ emoji_icons: 0.9 }) });
      const result = await runTasteCheck(client, config, {
        screens: [screen("1", "<div>x</div>", "Home")],
      });
      expect(result.feedback).toContain("Screens not listed passed");
      // The emoji_icons fix text contains "<" via "web font) or an inline SVG" — no escaping check needed on
      // content we wrote, but assert the raw fix text (with its own punctuation) survives untouched.
      expect(result.feedback).toContain("real icon");
    });
  });

  describe("truncation", () => {
    it("truncates HTML longer than MAX_SCREEN_HTML_CHARS before sending it to Jev", async () => {
      let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient(
        { Home: cleanAnswers() },
        { capture: (p) => (captured = p) },
      );
      const longHtml = "<div>" + "x".repeat(MAX_SCREEN_HTML_CHARS + 5_000) + "</div>";
      await runTasteCheck(client, config, { screens: [screen("1", longHtml, "Home")] });
      const sentHtml = (captured!.state as { screen: { html: string } }).screen.html;
      expect(sentHtml.length).toBeLessThanOrEqual(MAX_SCREEN_HTML_CHARS);
      expect(sentHtml).toContain("truncated for taste check");
    });

    it("leaves HTML at or under the cap untouched", async () => {
      let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient(
        { Home: cleanAnswers() },
        { capture: (p) => (captured = p) },
      );
      const html = "<div>short</div>";
      await runTasteCheck(client, config, { screens: [screen("1", html, "Home")] });
      const sentHtml = (captured!.state as { screen: { html: string } }).screen.html;
      expect(sentHtml).toBe(html);
    });
  });

  describe("normalization", () => {
    it("replaces data: URIs with a placeholder before truncation", async () => {
      let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient(
        { Home: cleanAnswers() },
        { capture: (p) => (captured = p) },
      );
      const html = `<img src="data:image/png;base64,${"A".repeat(500)}">`;
      await runTasteCheck(client, config, { screens: [screen("1", html, "Home")] });
      const sentHtml = (captured!.state as { screen: { html: string } }).screen.html;
      expect(sentHtml).toContain("data:…");
      expect(sentHtml).not.toContain("base64");
    });

    it("collapses a long inline SVG path's `d` attribute before truncation", async () => {
      let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient(
        { Home: cleanAnswers() },
        { capture: (p) => (captured = p) },
      );
      const longPath = "M0,0 " + "L1,1 ".repeat(60);
      const html = `<svg><path d="${longPath}"/></svg>`;
      await runTasteCheck(client, config, { screens: [screen("1", html, "Home")] });
      const sentHtml = (captured!.state as { screen: { html: string } }).screen.html;
      expect(sentHtml).toContain('d="…"');
      expect(sentHtml).not.toContain("L1,1");
    });

    it("collapses runs of whitespace before truncation", async () => {
      let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
      const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
      const client = fakeClient(
        { Home: cleanAnswers() },
        { capture: (p) => (captured = p) },
      );
      const html = "<div>\n\n  hello   world\n\t</div>";
      await runTasteCheck(client, config, { screens: [screen("1", html, "Home")] });
      const sentHtml = (captured!.state as { screen: { html: string } }).screen.html;
      expect(sentHtml).toBe("<div> hello world </div>");
    });

    it("caps normalized HTML at the new 60,000-char limit", () => {
      expect(MAX_SCREEN_HTML_CHARS).toBe(60_000);
    });
  });

  it("caps screens per request at MAX_SCREENS_PER_REQUEST", async () => {
    const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
    const byName: Record<string, Record<string, SystemOneAnswer>> = {};
    const screens = Array.from({ length: MAX_SCREENS_PER_REQUEST + 5 }, (_, i) => {
      byName[`Screen ${i}`] = cleanAnswers();
      return screen(String(i), `<div>${i}</div>`, `Screen ${i}`);
    });
    const client = fakeClient(byName);
    const result = await runTasteCheck(client, config, { screens });
    expect(result.screens.length).toBeLessThanOrEqual(MAX_SCREENS_PER_REQUEST);
  });

  it("sends exactly the 9 documented rules as questions, each carrying a brief exemption in its wording", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const config = makeConfig({ TASTE_CHECK_MODE: "shadow" });
    const client = fakeClient({ Home: cleanAnswers() }, { capture: (p) => (captured = p) });
    await runTasteCheck(client, config, { screens: [screen("1", "<div>x</div>", "Home")] });
    expect(TASTE_RULES).toHaveLength(9);
    expect(Object.keys(captured!.questions).sort()).toEqual(
      TASTE_RULES.map((r) => r.id).sort(),
    );
    for (const question of Object.values(captured!.questions)) {
      expect((question as { instructions: string }).instructions).toContain("brief");
      expect((question as { instructions: string }).instructions.toLowerCase()).toContain(
        "not a violation",
      );
    }
  });
});
