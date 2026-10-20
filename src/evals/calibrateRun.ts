// CLI: npm run evals:calibrate -- --labels=<file>
// Runs the taste check on human-labelled screens and reports per-rule
// agreement. Never calls OpenRouter (the System One client talks to
// TypeSafe only).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MAX_SCREENS_PER_REQUEST, TASTE_RULES, runTasteCheck, type TasteCheckScreenInput } from "../ai/tasteCheck.js";
import { loadConfig } from "../config.js";
import { createSystemOne } from "../services/systemone.js";
import { runAsScript } from "../showcase/cli.js";
import { EVAL_TASKS } from "./tasks.js";
import {
  calibrate,
  groupByTask,
  resolveRunDir,
  findingsToVerdicts,
  formatTable,
  type LabelledScreen,
  type LabelsFile,
} from "./calibrate.js";

const JSONL_PATH = resolve("evals/calibration.jsonl");

function parseLabelsArg(argv: string[]): string | null {
  const arg = argv.find((a) => a.startsWith("--labels="));
  return arg ? arg.slice("--labels=".length) || null : null;
}

async function main(): Promise<void> {
  const labelsArg = parseLabelsArg(process.argv.slice(2));
  if (!labelsArg) {
    console.error("[calibrate] usage: npm run evals:calibrate -- --labels=<file>");
    process.exit(1);
  }
  const labelsPath = resolve(labelsArg);
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as LabelsFile;
  const runDir = resolveRunDir(labelsPath, labels.runDir);

  // config demands a key; nothing here calls OpenRouter.
  process.env.OPENROUTER_API_KEY ||= "unused-by-calibrate";
  const baseConfig = loadConfig();
  // TASTE_CHECK_MODE defaults to "off", which would make runTasteCheck skip.
  const config = { ...baseConfig, TASTE_CHECK_MODE: "shadow" as const };

  const client = createSystemOne(config);
  if (!client) {
    console.error("[calibrate] TYPESAFE_API_KEY is not set; the judge cannot run.");
    process.exit(2);
  }

  const keyOf = (s: LabelledScreen): string => s.file;
  // A screen with no pass/fail label can never contribute to agreement: don't spend a judge call on it.
  const labelled = labels.screens.filter((s) => Object.values(s.labels).some((l) => l === "pass" || l === "fail"));
  const screens = labelled.map((s) => ({
    id: keyOf(s),
    task: s.task,
    input: { id: keyOf(s), name: s.file, html: readFileSync(resolve(runDir, s.file), "utf8") } as TasteCheckScreenInput,
  }));

  const known = new Set(TASTE_RULES.map((r) => r.id));
  const unknownRules = labels.rules.filter((r) => !known.has(r));
  if (unknownRules.length > 0) {
    console.error(`[calibrate] unknown taste rule ids: ${unknownRules.join(", ")}`);
    process.exit(1);
  }

  const results = [];
  // Same brief the taste-clean grader passes (the task prompt), so calibration
  // measures the judge as the harness uses it. One call per task, chunked at
  // runTasteCheck's per-request cap.
  for (const [task, group] of groupByTask(screens)) {
    const brief = EVAL_TASKS.find((t) => t.id === task)?.prompt;
    for (let i = 0; i < group.length; i += MAX_SCREENS_PER_REQUEST) {
      const res = await runTasteCheck(client, config, {
        screens: group.slice(i, i + MAX_SCREENS_PER_REQUEST).map((s) => s.input),
        brief,
      });
      results.push(...res.screens);
    }
  }

  const verdicts = findingsToVerdicts(results, labels.rules);
  const stats = calibrate(labels, verdicts, keyOf);
  console.log(formatTable(stats));
  const skipped = screens.length - results.length;
  if (skipped > 0) console.log(`\n${skipped} screen(s) got no verdict (check failed or skipped).`);

  mkdirSync(dirname(JSONL_PATH), { recursive: true });
  appendFileSync(
    JSONL_PATH,
    JSON.stringify({ date: new Date().toISOString(), labelsFile: labelsArg, rules: stats }) + "\n",
  );
}

runAsScript(import.meta.url, "calibrate", main);
