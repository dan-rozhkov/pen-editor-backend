import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TASTE_RULES } from "../src/ai/tasteCheck.js";
import {
  DEFAULT_EVAL_MODEL,
  appendHistory,
  formatTable,
  suiteMeans,
  UsageError,
  parseEvalArgs,
  summarize,
  writeRunArtifacts,
} from "../src/evals/cli.js";
import { resolveRunDir } from "../src/evals/calibrate.js";
import { DEFAULT_TRIAL_TIMEOUT_MS } from "../src/evals/types.js";
import { EVAL_TASKS } from "../src/evals/tasks.js";
import type { TrialResult } from "../src/evals/types.js";

describe("eval CLI args", () => {
  it("defaults to the opencode-go deepseek-v4-pro model and a 10 minute trial timeout", () => {
    expect(parseEvalArgs([])).toMatchObject({ model: DEFAULT_EVAL_MODEL, k: 3, concurrency: 2, suite: "all" });
    expect(parseEvalArgs([]).trialTimeoutMs).toBe(DEFAULT_TRIAL_TIMEOUT_MS);
    expect(parseEvalArgs(["--trial-timeout-ms=5000"]).trialTimeoutMs).toBe(5000);
    expect(DEFAULT_EVAL_MODEL).toBe("opencode-go/deepseek-v4-pro");
  });

  it.each(["google/gemini-3.7-flash", "openrouter:google/gemini-3.7-flash", "opencode/deepseek-v4-pro"])(
    "rejects non-opencode-go model %s",
    (model) => {
      expect(() => parseEvalArgs([`--model=${model}`])).toThrow(UsageError);
    },
  );

  it("rejects an opencode-go id outside the chat-completions allowlist", () => {
    expect(() => parseEvalArgs(["--model=opencode-go/minimax-m3"])).toThrow(UsageError);
  });

  it("parses flags and rejects bad numbers and suites", () => {
    expect(parseEvalArgs(["--suite=regression", "--task=reg-quotes", "--k=5", "--concurrency=1"])).toMatchObject({
      suite: "regression",
      taskId: "reg-quotes",
      k: 5,
      concurrency: 1,
    });
    expect(() => parseEvalArgs(["--k=0"])).toThrow(UsageError);
    expect(() => parseEvalArgs(["--trial-timeout-ms=0"])).toThrow(UsageError);
    expect(() => parseEvalArgs(["--suite=nope"])).toThrow(UsageError);
  });
});

const trial = (taskId: string, n: number, status: TrialResult["status"], passed: boolean, html = ""): TrialResult => ({
  taskId,
  trial: n,
  status,
  passed,
  transcript: { toolCalls: [], finalText: "", steps: 0, finishReason: "stop" },
  outcome: {
    embeds: html ? [{ name: "Home Screen", htmlContent: html }] : [],
    issuedImageUrls: [],
    batchOperations: [],
    generatedImageCalls: 0,
  },
  graders: [],
});

describe("eval run output", () => {
  it("excludes infra errors from n and counts them separately", () => {
    const stats = summarize(
      [trial("a", 1, "completed", true), trial("a", 2, "completed", false), trial("a", 3, "infra_error", false)],
      2,
    );
    expect(stats.a).toMatchObject({ n: 2, c: 1, infra: 1, passAt1: 0.5, passPowK: 0 });
  });

  it("writes trials, screens and a labels template in the agreed format", () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    writeRunArtifacts(dir, [trial("reg-quotes", 1, "completed", true, "<html></html>")]);
    expect(readdirSync(join(dir, "trials"))).toEqual(["reg-quotes-1.json"]);
    expect(readdirSync(join(dir, "screens"))).toEqual(["reg-quotes-1-home-screen.html"]);
    const template = JSON.parse(readFileSync(join(dir, "labels.template.json"), "utf8"));
    expect(template.runDir).toBe(".");
    expect(template.rules).toEqual(TASTE_RULES.map((r) => r.id));
    expect(template.screens).toEqual([
      {
        file: "screens/reg-quotes-1-home-screen.html",
        task: "reg-quotes",
        labels: Object.fromEntries(TASTE_RULES.map((r) => [r.id, "unknown"])),
      },
    ]);
  });
});

describe("calibrate labels template", () => {
  it("resolves its screens from a cwd-relative run dir, the way calibrateRun does", () => {
    const abs = mkdtempSync(join(tmpdir(), "evals-rel-"));
    const rel = join("evals", "runs", "2026-x");
    const runDir = join(abs, rel);
    writeRunArtifacts(runDir, [trial("reg-quotes", 1, "completed", true, "<html></html>")]);
    const labelsPath = resolve(runDir, "labels.template.json");
    const template = JSON.parse(readFileSync(labelsPath, "utf8"));
    const resolved = resolveRunDir(labelsPath, template.runDir);
    expect(resolved).toBe(resolve(runDir));
    expect(existsSync(join(resolved, template.screens[0].file))).toBe(true);
    expect(dirname(labelsPath)).toBe(resolved);
  });
});

describe("pass^k with too few completed trials", () => {
  const stats = summarize(
    [
      trial("a", 1, "completed", true),
      trial("a", 2, "infra_error", false),
      trial("a", 3, "infra_error", false),
      trial("b", 1, "completed", true),
      trial("b", 2, "completed", true),
      trial("b", 3, "completed", false),
      trial("c", 1, "skipped", false),
    ],
    3,
  );

  it("reports null for n < k and n = 0, keeping the infra count", () => {
    expect(stats.a).toMatchObject({ n: 1, infra: 2, passAt1: 1, passPowK: null });
    expect(stats.b.passPowK).toBe(0);
    expect(stats.c).toMatchObject({ n: 0, skipped: 1, passAt1: null, passPowK: null });
  });

  it("excludes null from suite means and shows n/a in the table and history", () => {
    const regression = suiteMeans(stats, () => "regression").regression;
    expect(regression.passAt1).toBeCloseTo((1 + 2 / 3) / 2, 10);
    expect(regression.passPowK).toBe(0);
    expect(suiteMeans({ c: stats.c }, () => "capability").capability).toEqual({ passAt1: null, passPowK: null });
    expect(formatTable(stats, 3).split("\n")[1]).toMatch(/a\s+1\s+1\s+2\s+0\s+100%\s+n\/a/);
    const path = join(mkdtempSync(join(tmpdir(), "evals-h-")), "history.jsonl");
    appendHistory(path, { date: "d", sha: "s", model: "m", k: 3, suite: "all", stats });
    const entry = JSON.parse(readFileSync(path, "utf8"));
    expect(entry.tasks.a).toEqual({ n: 1, c: 1, infra: 2, "pass@1": 1, "pass^k": null });
  });
});

describe("eval task set", () => {
  it("has unique ids, a source and graders on every task", () => {
    expect(new Set(EVAL_TASKS.map((t) => t.id)).size).toBe(EVAL_TASKS.length);
    expect(EVAL_TASKS.every((t) => t.source.length > 0 && t.graders.length > 0)).toBe(true);
    expect(EVAL_TASKS).toHaveLength(12);
    expect(EVAL_TASKS.filter((t) => t.mode === "research").every((t) => t.prompt.startsWith("/research "))).toBe(true);
  });
});
