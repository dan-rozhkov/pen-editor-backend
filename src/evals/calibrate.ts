// Pure logic for judge calibration: compare human labels against the taste
// check's verdicts, per rule. No I/O here — calibrateRun.ts does the loading.

import { dirname, resolve } from "node:path";
import type { TasteCheckScreenResult } from "../ai/tasteCheck.js";

export type Verdict = "pass" | "fail";
export type HumanLabel = Verdict | "unknown";

/** Rules with fewer labelled screens than this are flagged. */
export const MIN_LABELS_PER_RULE = 10;

export interface LabelledScreen {
  file: string;
  task: string;
  labels: Record<string, HumanLabel>;
}

export interface LabelsFile {
  runDir: string;
  rules: string[];
  screens: LabelledScreen[];
}

/** A relative runDir is relative to the labels file's own directory (the run dir). */
export function resolveRunDir(labelsPath: string, runDir: string): string {
  return resolve(dirname(labelsPath), runDir);
}

export function groupByTask<T extends { task: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(item.task, [...(out.get(item.task) ?? []), item]);
  return out;
}

/** screen key -> rule id -> judge verdict. A missing screen has no verdict. */
export type JudgeVerdicts = Record<string, Record<string, Verdict>>;

export interface RuleStats {
  rule: string;
  /** Screens with a human label other than unknown AND a judge verdict. */
  n: number;
  agreement: number | null;
  /** null when expected agreement is 1 (kappa is undefined) or n is 0. */
  kappa: number | null;
  /** Judge pass, human fail. */
  falsePass: number;
  /** Judge fail, human pass. */
  falseFail: number;
  notEnoughLabels: boolean;
}

/**
 * A finding for rule X on a screen means the judge said "fail" for X; a
 * checked screen with no finding means "pass". A screen the check failed or
 * skipped is absent from `results` and so gets no verdict at all.
 */
export function findingsToVerdicts(
  results: TasteCheckScreenResult[],
  ruleIds: string[],
): JudgeVerdicts {
  const out: JudgeVerdicts = {};
  for (const screen of results) {
    const failed = new Set(screen.findings.map((f) => f.rule));
    const perRule: Record<string, Verdict> = {};
    for (const rule of ruleIds) perRule[rule] = failed.has(rule) ? "fail" : "pass";
    out[screen.id] = perRule;
  }
  return out;
}

export function computeRuleStats(
  rule: string,
  pairs: Array<{ human: Verdict; judge: Verdict }>,
): RuleStats {
  const n = pairs.length;
  let agree = 0;
  let falsePass = 0;
  let falseFail = 0;
  let humanFail = 0;
  let judgeFail = 0;
  for (const { human, judge } of pairs) {
    if (human === judge) agree++;
    else if (judge === "pass") falsePass++;
    else falseFail++;
    if (human === "fail") humanFail++;
    if (judge === "fail") judgeFail++;
  }
  if (n === 0) {
    return { rule, n, agreement: null, kappa: null, falsePass, falseFail, notEnoughLabels: true };
  }
  const po = agree / n;
  const pHumanFail = humanFail / n;
  const pJudgeFail = judgeFail / n;
  const pe = pHumanFail * pJudgeFail + (1 - pHumanFail) * (1 - pJudgeFail);
  const kappa = pe >= 1 ? null : (po - pe) / (1 - pe);
  return {
    rule,
    n,
    agreement: po,
    kappa,
    falsePass,
    falseFail,
    notEnoughLabels: n < MIN_LABELS_PER_RULE,
  };
}

export function calibrate(
  labels: LabelsFile,
  verdicts: JudgeVerdicts,
  keyOf: (screen: LabelledScreen) => string,
): RuleStats[] {
  return labels.rules.map((rule) => {
    const pairs: Array<{ human: Verdict; judge: Verdict }> = [];
    for (const screen of labels.screens) {
      const human = screen.labels[rule];
      const judge = verdicts[keyOf(screen)]?.[rule];
      if ((human !== "pass" && human !== "fail") || !judge) continue;
      pairs.push({ human, judge });
    }
    return computeRuleStats(rule, pairs);
  });
}

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(0)}%`;
}

export function formatTable(stats: RuleStats[]): string {
  const header = ["rule", "n", "agree", "kappa", "false-pass", "false-fail", "note"];
  const rows = stats.map((s) => [
    s.rule,
    String(s.n),
    pct(s.agreement),
    s.kappa === null ? "n/a" : s.kappa.toFixed(2),
    String(s.falsePass),
    String(s.falseFail),
    s.notEnoughLabels ? "not enough labels" : "",
  ]);
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all
    .map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd())
    .join("\n");
}
