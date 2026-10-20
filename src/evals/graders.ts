import type { Config } from "../config.js";
import { CREATE_OP_RE, isCreateOp, nodeTypeOfCreateOp, splitBatchDesignStatements } from "../ai/tools.js";
import { MAX_SCREENS_PER_REQUEST, runTasteCheck, type TasteCheckScreenResult } from "../ai/tasteCheck.js";
import type { SystemOneClient } from "../services/systemone.js";
import { extractEmbedNodes } from "../showcase/extractEmbeds.js";
import { showcaseViewport } from "../showcase/platform.js";
import { MAX_GENERATED_IMAGES } from "../showcase/runner.js";
import type { EvalTask, GraderResult, GraderSpec, Outcome, Transcript } from "./types.js";

export interface GraderContext {
  task: EvalTask;
  outcome: Outcome;
  transcript: Transcript;
  /** research tasks: did the prepared turn carry any MCP tools. */
  hadMcpTools: boolean;
  systemOne: SystemOneClient | null;
  config: Config;
}

const STOCK_HOSTS = ["picsum.photos", "images.unsplash.com"];
// Not images: stylesheets / fonts / icon CDNs referenced through url() or @import.
const NON_IMAGE_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
];
const MAX_NEAR_DISTANCE = 3;

const pass = (id: GraderResult["id"], detail = "ok"): GraderResult => ({ id, status: "pass", detail });
const fail = (id: GraderResult["id"], detail: string): GraderResult => ({ id, status: "fail", detail });
const skipped = (id: GraderResult["id"], detail: string): GraderResult => ({ id, status: "skipped", detail });

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function firstIndex(transcript: Transcript, pred: (name: string, args: unknown) => boolean): number {
  const hit = transcript.toolCalls.find((c) => pred(c.name, c.args));
  return hit ? hit.index : -1;
}

function gradeEmbedsPresent(min: number, ctx: GraderContext): GraderResult {
  const n = ctx.outcome.embeds.length;
  return n >= min ? pass("embeds-present", `${n} embeds`) : fail("embeds-present", `${n} embeds, need ${min}`);
}

function gradeEmbedOnly(ctx: GraderContext): GraderResult {
  const bad: string[] = [];
  for (const ops of ctx.outcome.batchOperations) {
    for (const statement of splitBatchDesignStatements(ops)) {
      if (!isCreateOp(statement)) continue;
      if (statement.trim().match(CREATE_OP_RE)?.[1] !== "I") continue;
      const type = nodeTypeOfCreateOp(statement) ?? "frame";
      if (type !== "embed") bad.push(type);
    }
  }
  return bad.length === 0 ? pass("embed-only") : fail("embed-only", `non-embed inserts: ${bad.join(", ")}`);
}

function gradeBoxSize(spec: Extract<GraderSpec, { type: "box-size" }>, ctx: GraderContext): GraderResult {
  const want =
    spec.width !== undefined && spec.height !== undefined
      ? { width: spec.width, height: spec.height }
      : showcaseViewport(spec.platform ?? "mobile");
  if (ctx.outcome.embeds.length === 0) return fail("box-size", "no embeds");
  const bad = ctx.outcome.embeds.filter((e) => e.width !== want.width || e.height !== want.height);
  return bad.length === 0
    ? pass("box-size", `all ${want.width}x${want.height}`)
    : fail("box-size", bad.map((e) => `${e.name}: ${e.width}x${e.height}`).join("; ") + ` (want ${want.width}x${want.height})`);
}

function gradeFilmstrip(ctx: GraderContext): GraderResult {
  const embeds = ctx.outcome.embeds;
  if (embeds.length < 2) return fail("filmstrip", `${embeds.length} embeds`);
  if (embeds.some((e) => e.x === undefined || e.y === undefined)) return fail("filmstrip", "embed without numeric x/y");
  if (new Set(embeds.map((e) => e.y)).size !== 1) return fail("filmstrip", "slides do not share one y");
  for (let i = 1; i < embeds.length; i++) {
    if ((embeds[i].x as number) <= (embeds[i - 1].x as number)) {
      return fail("filmstrip", `x does not strictly increase at slide ${i + 1}`);
    }
  }
  return pass("filmstrip");
}

function gradeHtmlComplete(ctx: GraderContext): GraderResult {
  // Compared per call: harvesting replaces by name, so the total of embed ops
  // can legitimately exceed the number of final embeds (a re-emitted screen).
  let inserts = 0;
  let extracted = 0;
  for (const ops of ctx.outcome.batchOperations) {
    for (const statement of splitBatchDesignStatements(ops)) {
      if (isCreateOp(statement) && (nodeTypeOfCreateOp(statement) ?? "frame") === "embed") inserts++;
    }
    extracted += extractEmbedNodes(ops).length;
  }
  const harvested = ctx.outcome.embeds.length;
  if (inserts !== extracted || harvested === 0) {
    return fail("html-complete", `${inserts} embed inserts, ${extracted} with parseable html, ${harvested} kept`);
  }
  const open = ctx.outcome.embeds.filter((e) => !/<\/(html|body)>/i.test(e.htmlContent));
  if (open.length > 0) return fail("html-complete", `not closed: ${open.map((e) => e.name).join(", ")}`);
  return pass("html-complete", `${harvested} complete`);
}

const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;

export function imageUrlsIn(html: string): string[] {
  const urls: string[] = [];
  for (const re of [IMG_SRC_RE, CSS_URL_RE]) {
    for (const m of html.matchAll(re)) if (/^https?:\/\//i.test(m[1])) urls.push(m[1]);
  }
  return urls;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function gradeImageUrls(ctx: GraderContext): GraderResult {
  const issued = new Set(ctx.outcome.issuedImageUrls);
  const problems: string[] = [];
  for (const embed of ctx.outcome.embeds) {
    for (const url of new Set(imageUrlsIn(embed.htmlContent))) {
      const host = hostOf(url);
      if (issued.has(url)) continue;
      if (NON_IMAGE_HOSTS.includes(host) || /\.(css|woff2?|ttf|otf)(\?|$)/i.test(url)) continue;
      // Near-miss BEFORE the stock-host allowlist: in evals every issued URL is
      // a picsum placeholder, so a typo of one would otherwise pass as "stock".
      const near = [...issued].find((u) => levenshtein(u, url) <= MAX_NEAR_DISTANCE);
      if (near) {
        problems.push(`${url} looks like a mistyped copy of ${near}`);
        continue;
      }
      if (STOCK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
      problems.push(`${url} was never issued`);
    }
  }
  return problems.length === 0 ? pass("image-urls-issued") : fail("image-urls-issued", problems.join("; "));
}

function gradeImageBudget(ctx: GraderContext): GraderResult {
  const n = ctx.outcome.generatedImageCalls;
  return n <= MAX_GENERATED_IMAGES
    ? pass("image-budget", `${n}/${MAX_GENERATED_IMAGES}`)
    : fail("image-budget", `${n} generate_image calls, cap ${MAX_GENERATED_IMAGES}`);
}

function gradeAsked(ctx: GraderContext, want: boolean): GraderResult {
  const id = want ? "asked-first" : "not-asked";
  const ask = firstIndex(ctx.transcript, (n) => n === "ask_user");
  const batch = firstIndex(ctx.transcript, (n) => n === "batch_design");
  if (!want) return ask === -1 ? pass(id) : fail(id, `ask_user called (call #${ask})`);
  if (ask === -1) return fail(id, "ask_user never called");
  if (batch !== -1 && batch < ask) return fail(id, "batch_design ran before ask_user");
  return pass(id);
}

function gradeSkillFirst(skill: string, ctx: GraderContext): GraderResult {
  const load = firstIndex(ctx.transcript, (n, a) => n === "load_skill" && (a as { name?: string } | null)?.name === skill);
  const batch = firstIndex(ctx.transcript, (n) => n === "batch_design");
  if (ctx.outcome.injectedSkill === skill) return pass("skill-loaded-first", `injected by prepareChatTurn (${ctx.outcome.skillSource})`);
  if (load === -1) return fail("skill-loaded-first", `load_skill("${skill}") never called`);
  if (batch !== -1 && batch < load) return fail("skill-loaded-first", "batch_design ran before the skill loaded");
  return pass("skill-loaded-first");
}

function gradeGroundedRefs(ctx: GraderContext): GraderResult {
  if (!ctx.hadMcpTools) return skipped("grounded-refs", "no_mcp_tools");
  const urls = [...new Set(ctx.transcript.finalText.match(/https?:\/\/[^\s)\]>"'`]+/g) ?? [])].map((u) =>
    u.replace(/[.,;:]+$/, ""),
  );
  if (urls.length === 0) return fail("grounded-refs", "final text cites no URLs");
  const corpus = ctx.transcript.toolCalls.map((c) => c.result).join("\n");
  const ungrounded = urls.filter((u) => !corpus.includes(u));
  return ungrounded.length === 0
    ? pass("grounded-refs", `${urls.length} urls grounded`)
    : fail("grounded-refs", `not in any tool result: ${ungrounded.join(", ")}`);
}

async function gradeTaste(ctx: GraderContext): Promise<GraderResult> {
  if (!ctx.systemOne) return skipped("taste-clean", "no TYPESAFE_API_KEY");
  if (ctx.outcome.embeds.length === 0) return fail("taste-clean", "no embeds to check");
  // TASTE_CHECK_MODE defaults to "off", which makes runTasteCheck skip every screen.
  const config = { ...ctx.config, TASTE_CHECK_MODE: "shadow" as const };
  // runTasteCheck keeps at most MAX_SCREENS_PER_REQUEST screens per call.
  const all = ctx.outcome.embeds.map((e, i) => ({ id: `s${i + 1}`, name: e.name, html: e.htmlContent }));
  const results: TasteCheckScreenResult[] = [];
  for (let i = 0; i < all.length; i += MAX_SCREENS_PER_REQUEST) {
    const result = await runTasteCheck(ctx.systemOne, config, {
      screens: all.slice(i, i + MAX_SCREENS_PER_REQUEST),
      brief: ctx.task.prompt,
    });
    if (result.outcome !== "checked") return skipped("taste-clean", `taste check ${result.outcome}`);
    results.push(...result.screens);
  }
  const result = { screens: results };
  const found = result.screens.flatMap((s) => s.findings.map((f) => `${s.name ?? s.id}: ${f.rule}`));
  return found.length === 0 ? pass("taste-clean") : fail("taste-clean", found.join("; "));
}

export async function runGrader(spec: GraderSpec, ctx: GraderContext): Promise<GraderResult> {
  switch (spec.type) {
    case "embeds-present":
      return gradeEmbedsPresent(spec.min, ctx);
    case "embed-only":
      return gradeEmbedOnly(ctx);
    case "box-size":
      return gradeBoxSize(spec, ctx);
    case "filmstrip":
      return gradeFilmstrip(ctx);
    case "html-complete":
      return gradeHtmlComplete(ctx);
    case "image-urls-issued":
      return gradeImageUrls(ctx);
    case "image-budget":
      return gradeImageBudget(ctx);
    case "asked-first":
      return gradeAsked(ctx, true);
    case "not-asked":
      return gradeAsked(ctx, false);
    case "skill-loaded-first":
      return gradeSkillFirst(spec.skill, ctx);
    case "grounded-refs":
      return gradeGroundedRefs(ctx);
    case "taste-clean":
      return gradeTaste(ctx);
  }
}

export async function runGraders(ctx: GraderContext): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  for (const spec of ctx.task.graders) results.push(await runGrader(spec, ctx));
  return results;
}

/** A trial passes when no grader fails and at least one did not skip. */
export function trialPassed(results: GraderResult[]): boolean {
  return results.every((r) => r.status !== "fail") && results.some((r) => r.status !== "skipped");
}
