import type { Config } from "../config.js";
import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneQuestion,
} from "../services/systemone.js";

// Jev-backed "taste check" for a generated prototype screen. When the design
// agent emits an HTML embed via batch_design, we ask Jev whether the screen
// exhibits one of the recognizable "AI slop" patterns src/skills/
// frontend-design.md already tells the model not to produce, and — in
// enforce mode — hand the findings back to the agent as feedback so it can
// fix the screen itself. House style mirrors src/ai/imageRelevance.ts and
// src/ai/skillRouting.ts: fail-open, off/shadow/enforce, one log line with
// an `outcome` field distinguishing "nothing happened" from "nothing
// worked".
//
// Each RULE is a single, self-contained Noul question ("does this hold at
// all?", per docs.typesafe.ai/primitives/noul.md) rather than folded into a
// Choice — nine independent yes/no judgments about the same screen, not one
// question with nine mutually exclusive answers (a screen can have more
// than one of these problems at once).

export interface TasteRule {
  id: string;
  title: string;
  fix: string;
}

export const TASTE_RULES: TasteRule[] = [
  {
    id: "ai_palette",
    title: "the \"AI color palette\"",
    fix: "replace the cyan/purple/neon-on-dark default with a deliberate, cohesive palette that isn't the generic AI look",
  },
  {
    id: "gradient_text",
    title: "gradient text on headings or metrics",
    fix: "remove the gradient fill (background-clip: text) from headings/metrics and use a solid color instead",
  },
  {
    id: "nested_cards",
    title: "cards nested inside other cards",
    fix: "flatten the hierarchy — remove the inner card's own border/shadow/background so it reads as content, not a container inside a container",
  },
  {
    id: "identical_card_grid",
    title: "an identical card grid (icon + heading + text, repeated)",
    fix: "break the uniformity — vary card sizes/emphasis or replace the grid with a layout that isn't the same template repeated",
  },
  {
    id: "side_stripe_border",
    title: "a rounded element with a thick colored border on only one side",
    fix: "remove the one-sided accent border and find a more intentional way to draw attention to the element",
  },
  {
    id: "emoji_icons",
    title: "emoji used as UI icons",
    fix: "replace the emoji with a real icon (e.g. the Phosphor web font) or an inline SVG",
  },
  {
    id: "glassmorphism",
    title: "glassmorphism (decorative backdrop blur / glass cards / glow borders)",
    fix: "remove the decorative blur/glass/glow treatment unless it serves a real functional purpose",
  },
  {
    id: "everything_centered",
    title: "essentially all content, including body text and lists, centered",
    fix: "left-align body text and lists; reserve centering for elements that actually call for it",
  },
  {
    id: "all_buttons_primary",
    title: "every action styled as an equally prominent primary button",
    fix: "give secondary/tertiary actions a ghost, text-link, or outline style so one primary action stands out",
  },
];

function tasteQuestion(rule: TasteRule): string {
  return (
    `Look at the HTML in \`screen.html\` (with \`brief\` for context on what this screen is supposed to be). ` +
    `Does it exhibit ${rule.title}? This is a known "AI slop" visual pattern reviewers want removed from ` +
    `AI-generated interfaces. If \`brief\` explicitly asks for this specific pattern, that is NOT a violation — ` +
    `answer no in that case. Otherwise answer yes only if the pattern is actually present in the HTML/CSS, not ` +
    `merely plausible for this kind of screen.`
  );
}

// No documented hard limit on System One's `state` size or per-request byte
// count (docs.typesafe.ai/api.md and .../primitives/noul.md, checked
// 2026-09-23, list Choice's 255-option cap and Score's 2-10 level cap but
// say nothing about payload size). This is therefore a self-imposed
// judgment call, not a vendor-documented ceiling: a typical prototype
// screen's HTML runs 30-40KB (inline styles, several sections, some inline
// SVG), and 60,000 chars comfortably covers that while keeping one
// evaluate() call's request bounded. (History: this was 20,000 until
// 2026-09-23 — well under a typical screen's size, so truncation was
// routinely cutting into the body and mostly leaving `<head>` CSS. Paired
// with the normalization below, which strips the bulk that isn't visual
// signal anyway before the cap is even applied.)
export const MAX_SCREEN_HTML_CHARS = 60_000;
const TRUNCATION_MARKER = "\n<!-- truncated for taste check -->";

export const MAX_SCREENS_PER_REQUEST = 8;
const MAX_CONCURRENT_SCREEN_CHECKS = 4;

// A screen (by its round-tracking key) gets at most this many automated
// taste-check rounds — shared by the runner (src/showcase/runner.ts, which
// stops re-checking a screen past this many re-emissions) and the route's
// own zod validation of the `round` field below. Was a separate literal `2`
// duplicated in both places (plus the feedback text's own "(round X/2)"
// wording); this is now the one source of truth for all three.
export const MAX_TASTE_CHECK_ROUNDS = 2;

// Data-URI payloads (inline images/fonts) and long inline SVG path data are
// pure bulk for a taste check — Jev is judging the rendered visual pattern
// (palette, card nesting, alignment, icon style...), not decoding a base64
// blob or a path's control points. Stripping them before truncation means
// the MAX_SCREEN_HTML_CHARS budget is spent on markup/CSS that actually
// carries visual signal instead of being eaten by one inline asset.
const DATA_URI_RE = /data:[^"')\s]+/g;
const LONG_SVG_PATH_D_RE = /d="[^"]{200,}"/g;

function normalizeHtmlForTasteCheck(html: string): string {
  return html
    .replace(DATA_URI_RE, "data:…")
    .replace(LONG_SVG_PATH_D_RE, 'd="…"')
    .replace(/\s+/g, " ")
    .trim();
}

function truncateHtml(html: string): string {
  const normalized = normalizeHtmlForTasteCheck(html);
  if (normalized.length <= MAX_SCREEN_HTML_CHARS) return normalized;
  return (
    normalized.slice(0, MAX_SCREEN_HTML_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
  );
}

export interface TasteCheckScreenInput {
  id: string;
  name?: string;
  html: string;
}

export interface TasteFinding {
  rule: string;
  title: string;
  fix: string;
  noul: number;
}

export interface TasteCheckScreenResult {
  id: string;
  name?: string;
  findings: TasteFinding[];
}

export type TasteCheckOutcome =
  /** Jev was asked for at least one screen and answered. */
  | "checked"
  /** No Jev client at all (TYPESAFE_API_KEY unset). */
  | "no-client"
  /** config.TASTE_CHECK_MODE is "off". */
  | "off"
  /** No screens were passed in. */
  | "nothing-to-check"
  /** Jev was asked but every screen's call failed/timed out. */
  | "failed";

export interface RunTasteCheckInput {
  screens: TasteCheckScreenInput[];
  brief?: string;
  /** Which automated-check round this is (1 or 2) — only cosmetic, feeds the
   * feedback text's "(round X/2)" and the round-2 "final check" line. */
  round?: number;
  /** How the agent should apply fixes — defaults to
   * "with edit_embed_html or batch_design" when omitted. */
  fixHint?: string;
}

export interface RunTasteCheckResult {
  outcome: TasteCheckOutcome;
  screens: TasteCheckScreenResult[];
  /** English feedback text for the LLM, or null when there is nothing to
   * report (no findings anywhere, or mode isn't "enforce"). */
  feedback: string | null;
}

function isNoulAnswer(
  answer: SystemOneAnswer | undefined,
): answer is Extract<SystemOneAnswer, { type: "noul" }> {
  return !!answer && answer.type === "noul";
}

async function checkOneScreen(
  client: SystemOneClient,
  config: Config,
  screen: TasteCheckScreenInput,
  brief: string | undefined,
  signal: AbortSignal,
): Promise<TasteCheckScreenResult> {
  const state = {
    screen: { name: screen.name, html: truncateHtml(screen.html) },
    brief,
  };
  const questions: Record<string, SystemOneQuestion> = {};
  for (const rule of TASTE_RULES) {
    questions[rule.id] = { type: "noul", instructions: tasteQuestion(rule) };
  }

  const findings: TasteFinding[] = [];
  try {
    const { answers } = await client.evaluate({ state, questions, signal });
    for (const rule of TASTE_RULES) {
      const answer = answers[rule.id];
      if (!isNoulAnswer(answer)) continue; // malformed per-rule answer — skip, don't fail the screen
      if (answer.noul >= config.TASTE_CHECK_MIN_NOUL) {
        findings.push({ rule: rule.id, title: rule.title, fix: rule.fix, noul: answer.noul });
      }
    }
  } catch (err) {
    // Fail-open per screen: a timeout/transport/vendor error for ONE screen
    // must not throw the whole batch out. Rethrown rather than swallowed
    // here — the caller (runTasteCheck) awaits every screen via
    // Promise.allSettled, and a rejection there means the screen is simply
    // absent from `results` (dropped, not present with empty findings).
    console.warn(`[tasteCheck] screen "${screen.name ?? screen.id}" evaluate failed:`, err);
    throw err;
  }

  return { id: screen.id, name: screen.name, findings };
}

function buildFeedback(
  screens: TasteCheckScreenResult[],
  round: number | undefined,
  fixHint: string | undefined,
): string | null {
  const withFindings = screens.filter((s) => s.findings.length > 0);
  if (withFindings.length === 0) return null;

  const roundLabel = round ?? 1;
  const lines = withFindings.map((screen) => {
    const label = screen.name ? `"${screen.name}" (id ${screen.id})` : `id ${screen.id}`;
    const issues = screen.findings.map((f) => `${f.title.replace(/^the /, "")} — ${f.fix}`).join("; ");
    return `- Screen ${label}: ${issues}`;
  });

  const hint = fixHint ?? "with edit_embed_html or batch_design";
  const parts = [
    `Automated taste check (round ${roundLabel}/${MAX_TASTE_CHECK_ROUNDS}) found issues:`,
    ...lines,
    `Fix these on the affected screens ${hint}. Screens not listed passed. If the brief explicitly asked for a flagged pattern, keep it.`,
  ];
  if (roundLabel >= MAX_TASTE_CHECK_ROUNDS) {
    parts.push("This was the final automated check for these screens.");
  }
  return parts.join("\n");
}

/**
 * Runs the nine taste rules against each screen (one evaluate() call per
 * screen, up to MAX_CONCURRENT_SCREEN_CHECKS in flight, capped at
 * MAX_SCREENS_PER_REQUEST screens). A per-screen failure/timeout is
 * fail-open — that screen is simply skipped, never thrown out of the batch.
 * The whole call is bounded by config.TASTE_CHECK_TIMEOUT_MS via an
 * AbortSignal shared across every screen's evaluate() call.
 */
export async function runTasteCheck(
  client: SystemOneClient | null | undefined,
  config: Config,
  input: RunTasteCheckInput,
  opts: { signal?: AbortSignal } = {},
): Promise<RunTasteCheckResult> {
  const started = Date.now();
  const mode = config.TASTE_CHECK_MODE;

  const log = (outcome: TasteCheckOutcome, checked: number, findingsCount: number): void => {
    console.log(
      `[tasteCheck] ${JSON.stringify({
        mode,
        outcome,
        screens: input.screens.length,
        checked,
        findings: findingsCount,
        round: input.round ?? 1,
        ms: Date.now() - started,
      })}`,
    );
  };

  if (mode === "off") {
    log("off", 0, 0);
    return { outcome: "off", screens: [], feedback: null };
  }
  if (input.screens.length === 0) {
    log("nothing-to-check", 0, 0);
    return { outcome: "nothing-to-check", screens: [], feedback: null };
  }
  if (!client) {
    log("no-client", 0, 0);
    return { outcome: "no-client", screens: [], feedback: null };
  }

  const screens = input.screens.slice(0, MAX_SCREENS_PER_REQUEST);
  const timeoutSignal = AbortSignal.timeout(config.TASTE_CHECK_TIMEOUT_MS);
  const combinedSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

  const results: TasteCheckScreenResult[] = [];
  let checkedCount = 0;
  for (let i = 0; i < screens.length; i += MAX_CONCURRENT_SCREEN_CHECKS) {
    const batch = screens.slice(i, i + MAX_CONCURRENT_SCREEN_CHECKS);
    const settled = await Promise.allSettled(
      batch.map((screen) => checkOneScreen(client, config, screen, input.brief, combinedSignal)),
    );
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        checkedCount++;
      }
      // rejected: fail-open, that screen is simply absent from `results`.
    }
  }

  const findingsCount = results.reduce((sum, s) => sum + s.findings.length, 0);

  if (checkedCount === 0) {
    log("failed", 0, 0);
    return { outcome: "failed", screens: [], feedback: null };
  }

  log("checked", checkedCount, findingsCount);

  const feedback =
    mode === "enforce" ? buildFeedback(results, input.round, input.fixHint) : null;

  return { outcome: "checked", screens: results, feedback };
}
