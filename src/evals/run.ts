import { join } from "node:path";
import { loadConfig } from "../config.js";
import { loadSkills } from "../ai/skills.js";
import { createSystemOne } from "../services/systemone.js";
import { runAsScript } from "../showcase/cli.js";
import { installFetchGuard } from "./fetchGuard.js";
import { runTrial } from "./harness.js";
import { EVAL_TASKS, selectTasks } from "./tasks.js";
import {
  UsageError,
  appendHistory,
  formatTable,
  gitSha,
  parseEvalArgs,
  pct,
  runDirName,
  suiteMeans,
  summarize,
  writeRunArtifacts,
  type EvalArgs,
} from "./cli.js";
import type { EvalTask, TrialResult } from "./types.js";

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function main(): Promise<void> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`[evals] ${err.message}`);
    process.exit(2);
  }
  // The OpenCode key is read ONLY here; it is never part of src/config.ts.
  const opencodeApiKey = process.env.OPENCODE_GO_API_KEY;
  // Optional per-user Mobbin token: without it the research task stays skipped (no_mcp_tools).
  const mobbinAccessToken = process.env.MOBBIN_ACCESS_TOKEN || undefined;
  if (!opencodeApiKey) {
    console.error("[evals] OPENCODE_GO_API_KEY is required (the evals run on OpenCode Go, never OpenRouter)");
    process.exit(2);
  }
  // config.ts still demands the key to boot; the fetch guard makes any real use visible.
  process.env.OPENROUTER_API_KEY ||= "evals-dummy-never-used";
  const config = loadConfig();
  installFetchGuard();
  await loadSkills();
  const systemOne = createSystemOne(config);

  const tasks = selectTasks(args.suite, args.taskId);
  if (tasks.length === 0) {
    console.error(`[evals] no task matches (known: ${EVAL_TASKS.map((t) => t.id).join(", ")})`);
    process.exit(2);
  }
  if (!systemOne) console.warn("[evals] TYPESAFE_API_KEY unset: taste-clean grader will be skipped");

  const jobs: Array<{ task: EvalTask; trial: number }> = tasks.flatMap((task) =>
    Array.from({ length: args.k }, (_, i) => ({ task, trial: i + 1 })),
  );
  const results: TrialResult[] = [];
  await pool(jobs, args.concurrency, async ({ task, trial }) => {
    const r = await runTrial({ task, trial, config, model: args.model, opencodeApiKey, mobbinAccessToken, systemOne, timeoutMs: args.trialTimeoutMs });
    results.push(r);
    console.log(`[evals] ${task.id} #${trial}: ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.status === "completed" ? (r.passed ? " pass" : " FAIL") : ""}`);
  });
  results.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.trial - b.trial);

  const now = new Date();
  const runDir = join("evals", "runs", runDirName(now, args.model));
  writeRunArtifacts(runDir, results);
  const stats = summarize(results, args.k);
  appendHistory(join("evals", "history.jsonl"), {
    date: now.toISOString(),
    sha: gitSha(),
    model: args.model,
    k: args.k,
    suite: args.suite,
    stats,
  });

  const suiteOf = (id: string) => EVAL_TASKS.find((t) => t.id === id)!.suite;
  console.log("\n" + formatTable(stats, args.k));
  for (const [suite, m] of Object.entries(suiteMeans(stats, suiteOf))) {
    console.log(`${suite}: mean pass@1 ${pct(m.passAt1)}, mean pass^${args.k} ${pct(m.passPowK)}`);
  }
  console.log(`\nrun dir: ${runDir}`);
}

runAsScript(import.meta.url, "evals", main);
