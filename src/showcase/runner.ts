import { generateText, stepCountIs, type ToolSet } from "ai";
import type { Config } from "../config.js";
import { prepareChatTurn } from "../ai/chatTurn.js";
import { withAgentRetry } from "../ai/retry.js";
import { generateImage } from "../services/imageGen.js";
import { extractEmbedScreens } from "./extractEmbeds.js";
import { repairGeneratedImageUrls } from "./repairImageUrls.js";
import { DEFAULT_SHOWCASE_PLATFORM, type ShowcasePlatform } from "./platform.js";

// Hard cap on screens kept per run — matches the showcase's product shape
// (a short flow, not a whole app). Anything beyond this is dropped and
// logged, never silently discarded without a trace.
export const MAX_SHOWCASE_SCREENS = 5;

// Already in DEFAULT_MODELS (src/config.ts), and fine for a batch/offline
// generation job that isn't latency-sensitive.
//
// History: moonshotai/kimi-k2.5 between 2026-07-28 and 2026-07-29, then
// deepseek/deepseek-v4-pro, then its dated 0813 snapshot on 2026-08-15,
// and google/gemini-3.7-flash the same day. Both deepseek stints were
// motivated against: the model clusters on warm-cream/terracotta palettes
// and skips prototype.md's THESIS/OWN-WORLD direction contract. Override
// per run with `--model=`.
//
// This is the showcase default only. `/api/chat` reads OPENROUTER_MODEL
// and is untouched by anything here.
export const SHOWCASE_MODEL_ID = "google/gemini-3.7-flash";

// Generous but bounded step budget: ask_user -> get_editor_state ->
// get_guidelines -> batch_design (+ a retry or two) comfortably fits.
export const SHOWCASE_MAX_STEPS = 16;


export interface ShowcaseScreenDraft {
  name: string;
  htmlContent: string;
}

export interface ShowcaseRunResult {
  theme: string;
  prompt: string;
  model: string;
  screens: ShowcaseScreenDraft[];
}

// Hard ceiling on generated images per run, enforced here rather than left to
// the prompt. Each one is its own model call with a 90s timeout, so a screen
// full of avatars or a photo gallery could otherwise stretch a run into tens
// of minutes. Past the cap the tool keeps working — it just answers with a
// placeholder URL, so the agent still gets a usable image instead of an error
// it has to design around.
export const MAX_GENERATED_IMAGES = 8;

// The message the agent receives. Starts with the `/prototype` slash command
// so prepareChatTurn/resolveTaskPolicy route it through the embed-only policy
// and the prototype skill (src/skills/prototype.md) — the same machinery
// /api/chat uses, never a hand-rolled prompt.
//
// The imagery RULE itself now lives in the skill file (src/skills/prototype.md,
// "Images"): generated photography is what a prototype ships with everywhere,
// chat included, and picsum is the fallback. What stays here is the part that
// is genuinely run-specific — the hard MAX_GENERATED_IMAGES ceiling, which
// only the headless runner enforces (it is the thing counting the calls).
// Placed after the injected skill instructions, it reads as the requester's
// requirement rather than a contradiction of them.
export function buildShowcasePrompt(
  theme: string,
  options: { avoidHueFamilies?: string[]; platform?: ShowcasePlatform } = {},
): string {
  // "desktop web app" rather than "mobile app" is what steers
  // src/skills/prototype.md into its "Otherwise (default desktop)" device
  // preset (width: 1440, height: 1024) instead of the mobile/phone branch
  // (390x844) — the skill matches on the subject phrase, not a flag, so the
  // wording here is what does the routing, without editing the skill itself.
  const platform = options.platform ?? DEFAULT_SHOWCASE_PLATFORM;
  const subject = platform === "desktop" ? "desktop web app" : "mobile app";
  // Palette rotation (src/showcase/palette.ts). The skill's own Calibration
  // check can only make one design self-aware; it cannot see that the last six
  // apps in the gallery all shipped a terracotta/amber accent. This clause
  // carries that gallery-level fact into the turn, the same way `themes.ts`
  // keeps a run off the last 10 themes. Phrased as the requester's constraint,
  // and only when there is something to avoid — an empty gallery (or an
  // unreachable S3) simply drops it rather than sending "avoid: nothing".
  const avoid = options.avoidHueFamilies ?? [];
  const paletteClause = avoid.length
    ? `\n\nPalette: the last apps published in this gallery used these accent hue families — ` +
      `${avoid.join(", ")}. Pick an accent from a DIFFERENT family, and let the ground follow ` +
      `from it rather than defaulting to a warm neutral. This is a hard requirement of this ` +
      `request, not a preference: two apps side by side in the same warm palette read as one ` +
      `template. It does NOT suspend any rule in the skill — in particular the ban on purple / ` +
      `"AI violet" still stands, so a "different family" means a different one the skill already ` +
      `allows, and the accent still carries no glow. If every remaining family feels wrong for ` +
      `this product, change the value or temperature within one of them rather than reaching for ` +
      `a banned color. Everything else about choosing the visual world stays as the skill prescribes.`
    : "";
  return (
    `/prototype ${subject} — ${theme}, up to 5 screens of a single user flow, ` +
    `one consistent visual style. Write all UI copy in English.${paletteClause}\n\n` +
    `Imagery: follow the skill's rule — meaningful photos come from generate_image, ` +
    `micro imagery stays on picsum. The budget for this run is a hard ${MAX_GENERATED_IMAGES} generations: ` +
    `spend them on the most prominent shots first. If the tool returns a note about a placeholder, ` +
    `use the url it sent as is and do not call it again.`
  );
}

// Every client-executed tool the model might call has no `execute` — that's
// intentional (see CLAUDE.md's split-execution architecture), but it means a
// bare generateText() loop stalls the moment the model calls one, because
// there's nothing to run and no result to feed back. This wires up:
//   - batch_design: a real (if minimal) execute that harvests embed screens
//     via extractEmbedScreens and reports back created-node ids/bindings in
//     roughly the shape the frontend handler uses, so the model can keep
//     referencing them.
//   - every other tool without an execute: a stub that reports itself
//     unavailable, so the model can route around it (e.g. skip
//     get_screenshot) instead of the run silently hanging.
//   - tools that already have execute (get_guidelines, get_style_guide*, MCP,
//     web-search) are left untouched.
// The prototype skill's mandatory flow calls these before writing any HTML.
// Answering "unavailable" derails it — the agent is told to read the canvas
// and gather a brief, and gets an error instead. A showcase run really is a
// blank document, so the honest answer is the one the frontend handler gives
// for an empty file, in the same shape. Kept literally identical to
// pen-editor/src/lib/tools/getEditorState.ts and getVariables.ts.
const EMPTY_DOCUMENT_STATE = JSON.stringify({
  pages: [{ id: "page-1", name: "Page 1" }],
  activePageId: "page-1",
  roots: [],
  selectedIds: [],
  selectedNodes: [],
  reusableComponents: [],
  documentComponents: [],
  viewport: { scale: 1, x: 0, y: 0 },
});

// `ask_user` pauses the turn for a human in chat. There is no human here, and
// the skill offers exactly one legitimate way through: its brief form carries
// a "Decide for me" option. So answer as a user who delegates every choice,
// rather than reporting the tool broken — which would either stall the flow
// or push the agent to skip the brief step entirely.
const DELEGATED_BRIEF_ANSWER =
  "Decide for me — use your own judgment for every question above, " +
  "and pick whatever produces the strongest, most opinionated result. " +
  "Do not ask again; proceed straight to building.";

const EMULATED_CLIENT_TOOLS: Record<string, () => Promise<string>> = {
  get_editor_state: async () => EMPTY_DOCUMENT_STATE,
  get_variables: async () => JSON.stringify({ variables: [] }),
  ask_user: async () => DELEGATED_BRIEF_ANSWER,
};

// Deterministic stand-in used once the image budget is spent, and when a
// generation fails. Mirrors what the prototype skill asks for by default, so
// the HTML still ends up with a real <img> rather than a gap.
function placeholderImageUrl(prompt: string): string {
  const seed = encodeURIComponent(prompt.slice(0, 40).replace(/\s+/g, "-"));
  return `https://picsum.photos/seed/${seed}/800/600`;
}

// In the browser, generate_image posts to /api/generate-image and hands the
// model back {url}. Here we call the same service directly, so the agent can
// put a real generated image into an embed's HTML exactly as it would in chat.
// A failure is reported as a usable placeholder rather than an error: a broken
// image in a showcase screen is worse than a generic one, and the run must not
// die because one image timed out.
// `budget` is a single object shared (by reference) across every attempt of
// one showcase run — see the doc comment on `imageBudget` in
// runShowcaseGeneration for why this can no longer be a `let generated = 0`
// local to this function. (Finding #2: it used to be exactly that, so each
// retry attempt bought its own fresh MAX_GENERATED_IMAGES budget — up to 3x
// the prompt's advertised per-run ceiling across 2 retries.)
function makeGenerateImageTool(
  config: Config,
  budget: { generated: number },
  onIssuedUrl: (url: string) => void,
) {
  return async ({ prompt }: { prompt: string }) => {
    if (budget.generated >= MAX_GENERATED_IMAGES) {
      console.warn(
        `[showcase] image budget spent (${MAX_GENERATED_IMAGES}) — serving a placeholder for: ${prompt.slice(0, 60)}`,
      );
      return JSON.stringify({
        url: placeholderImageUrl(prompt),
        prompt,
        note: `Image budget for this run is spent (${MAX_GENERATED_IMAGES} generated). This is a placeholder — use it as-is and do not call generate_image again.`,
      });
    }

    // Claim the slot synchronously, before the await: the model issues these
    // calls in parallel, so reading `budget.generated` back after the await
    // reports the final count for every one of them.
    const slot = (budget.generated += 1);
    try {
      const { url } = await generateImage(config, prompt);
      onIssuedUrl(url);
      console.log(`[showcase] generated image ${slot}/${MAX_GENERATED_IMAGES}: ${prompt.slice(0, 60)}`);
      return JSON.stringify({ url, prompt });
    } catch (err) {
      console.warn(
        `[showcase] image generation failed (${(err as Error).message}) — serving a placeholder`,
      );
      return JSON.stringify({
        url: placeholderImageUrl(prompt),
        prompt,
        note: "Generation failed; this is a placeholder URL. Use it as-is and continue.",
      });
    }
  };
}

function instrumentTools(
  config: Config,
  tools: ToolSet,
  onScreens: (screens: ShowcaseScreenDraft[]) => Array<{ id: string; name: string }>,
  // Shared across every attempt of one run — see runShowcaseGeneration's
  // doc comment on why these two must be created ONCE, outside the retry
  // closure, and threaded through here rather than allocated fresh per call
  // — a retried attempt must not get a fresh image budget, since the
  // prompt promises the model a hard per-run cap.
  imageBudget: { generated: number },
  issuedImageUrls: string[],
): ToolSet {
  const instrumented: ToolSet = { ...tools };
  const generateImageExecute = makeGenerateImageTool(config, imageBudget, (url) =>
    issuedImageUrls.push(url),
  );

  // There is no browser here, so a screenshot can never be taken — and unlike
  // the tools below, a stub that reports itself unavailable is not good enough:
  // the system prompt actively recommends get_screenshot for verifying a
  // finished screen, so leaving it advertised buys a guaranteed-wasted step in
  // every run. Drop it instead. (analyze_image stays: it is backend-executed
  // and works fine here, e.g. to look at a generated image.)
  delete instrumented.get_screenshot;

  // remove_background/vectorize_image assume a scene graph node (node_id) or
  // native vector layers (vectorize_image's mode: "layers") to act on —
  // showcase generation only ever produces raw HTML via batch_design's embed
  // capture, there is no canvas here at all. A stub would just burn a step;
  // chatTurn.ts's own embed-only gate deletes both for the same reason in
  // prototype/slides mode, which is effectively what every showcase turn is.
  delete instrumented.remove_background;
  delete instrumented.vectorize_image;

  for (const name of Object.keys(instrumented)) {
    const entry = instrumented[name] as { execute?: unknown };
    if (typeof entry.execute === "function") continue; // static tool, leave as-is

    if (name === "batch_design") {
      instrumented[name] = {
        ...instrumented[name],
        execute: async (args: { operations: string }) => {
          const extracted = extractEmbedScreens(args.operations).map((screen) => {
            const { html, repairs, unresolved } = repairGeneratedImageUrls(
              screen.htmlContent,
              issuedImageUrls,
            );
            for (const { from, to } of repairs) {
              console.warn(
                `[showcase] repaired a mistyped generated-image URL in "${screen.name}": ${from} -> ${to}`,
              );
            }
            for (const url of unresolved) {
              console.warn(
                `[showcase] screen "${screen.name}" references an image URL no generate_image call returned: ${url}`,
              );
            }
            return { ...screen, htmlContent: html };
          });
          const created = onScreens(extracted);
          return JSON.stringify({
            success: true,
            operationsExecuted: extracted.length,
            createdNodes: created,
            note:
              created.length > 0
                ? `Recorded ${created.length} embed screen(s) for the showcase run.`
                : 'No embed screens found in this batch — only type: "embed" I()/R() operations are captured.',
          });
        },
      };
      continue;
    }

    if (name === "generate_image") {
      instrumented[name] = { ...instrumented[name], execute: generateImageExecute };
      continue;
    }

    const emulated = EMULATED_CLIENT_TOOLS[name];
    instrumented[name] = {
      ...instrumented[name],
      execute:
        emulated ??
        (async () =>
          `Tool "${name}" is unavailable in autonomous showcase generation mode.`),
    };
  }

  return instrumented;
}

// Sentinel thrown (never surfaced to a caller — see runShowcaseGeneration's
// catch around withAgentRetry) when an attempt's generateText() call
// returned normally but harvested zero embed screens. Finding #3: this is
// exactly the minimax-m3 failure mode the retry was originally built for —
// the model quietly finishes the turn without ever calling batch_design —
// but `generateText` doesn't throw for it, so `withAgentRetry`'s default
// error-classification retry never covered it. Throwing this from inside
// the attempt closure turns that silent failure into a normal retryable
// error for `withAgentRetry`'s `shouldRetry` hook to recognize.
class EmptyHarvestError extends Error {
  constructor() {
    super("Attempt produced zero embed screens via batch_design.");
    this.name = "EmptyHarvestError";
  }
}

// Runs one autonomous /prototype turn for `theme` and returns whatever embed
// screens the agent produced (0 to MAX_SHOWCASE_SCREENS — never throws just
// because the count is off that range; callers decide what "success" means).
export async function runShowcaseGeneration(
  config: Config,
  theme: string,
  modelId: string = SHOWCASE_MODEL_ID,
  options: { avoidHueFamilies?: string[]; platform?: ShowcasePlatform } = {},
): Promise<ShowcaseRunResult> {
  const prompt = buildShowcasePrompt(theme, options);
  const messages: Array<Record<string, unknown>> = [
    { id: "showcase-1", role: "user", parts: [{ type: "text", text: prompt }] },
  ];

  const prepared = await prepareChatTurn({
    config,
    messages,
    modelOverride: modelId,
  });

  // Spent-image-generations counter and the URLs generate_image has handed
  // out — created ONCE for the whole run, outside the retry closure below,
  // and threaded into instrumentTools() on every attempt. (Finding #2: these
  // used to be allocated fresh inside instrumentTools(), which is called
  // fresh per attempt — so each retry attempt quietly bought its own
  // MAX_GENERATED_IMAGES budget instead of sharing the run's single hard
  // ceiling, and the prompt's "hard 8 generations" promise to the model was
  // not actually enforced across retries.)
  const imageBudget = { generated: 0 };
  const issuedImageUrls: string[] = [];

  // minimax and other flaky models often abort the whole turn before ever
  // reaching batch_design (see selfimprove/showcase notes on minimax-m3) —
  // retry the turn itself rather than losing the whole generation run.
  // `attemptScreens` is (re)built INSIDE this closure, one fresh array per
  // attempt: if attempt 1 called batch_design and then failed on a later
  // step, its partial screens must not bleed into attempt 2 — only the last
  // attempt's screens are ever returned. `imageBudget`/`issuedImageUrls`
  // above are the opposite: they persist across every attempt of this run,
  // by design: the image budget is per RUN, not per attempt.
  let screens: ShowcaseScreenDraft[];
  try {
    screens = await withAgentRetry(
      async () => {
        const attemptScreens: ShowcaseScreenDraft[] = [];

        const tools = instrumentTools(
          config,
          prepared.tools,
          (extracted) => {
            const created: Array<{ id: string; name: string }> = [];
            for (const screen of extracted) {
              if (attemptScreens.length >= MAX_SHOWCASE_SCREENS) {
                console.warn(
                  `[showcase] dropping extra screen "${screen.name}" beyond the ${MAX_SHOWCASE_SCREENS}-screen cap`,
                );
                continue;
              }
              const id = `screen-${attemptScreens.length + 1}`;
              attemptScreens.push(screen);
              created.push({ id, name: screen.name });
            }
            return created;
          },
          imageBudget,
          issuedImageUrls,
        );

        await generateText({
          model: prepared.model,
          system: prepared.system,
          messages: prepared.modelMessages,
          tools,
          stopWhen: stepCountIs(SHOWCASE_MAX_STEPS),
          // withAgentRetry is the single retry policy here — without this, the
          // AI SDK's own default (2 internal retries) would stack on top of it.
          maxRetries: 0,
        });

        // Finding #3: a model that finishes cleanly without ever calling
        // batch_design is the failure this retry exists for, but it isn't a
        // thrown error — make it one so it's retryable like any other
        // transient failure.
        if (attemptScreens.length === 0) {
          throw new EmptyHarvestError();
        }

        return attemptScreens;
      },
      {
        // Retry an EmptyHarvestError like any other transient failure;
        // defer to the default provider-error classification for
        // everything else (undefined). See withAgentRetry's shouldRetry
        // doc comment.
        shouldRetry: (error) =>
          error instanceof EmptyHarvestError ? true : undefined,
      },
    );
  } catch (err) {
    // The retry budget is exhausted and the LAST attempt still harvested
    // nothing: today's behavior for that case is to return an empty screens
    // array (with the warning below), not to throw — a showcase run failing
    // outright over this is worse than the pre-existing "0 screens" outcome
    // callers already handle. Any other error still propagates as before.
    if (err instanceof EmptyHarvestError) {
      screens = [];
    } else {
      throw err;
    }
  }

  if (screens.length === 0) {
    console.warn(`[showcase] run for theme "${theme}" produced no embed screens`);
  } else if (screens.length < MAX_SHOWCASE_SCREENS) {
    console.log(
      `[showcase] run for theme "${theme}" produced ${screens.length}/${MAX_SHOWCASE_SCREENS} screens`,
    );
  }

  return {
    theme,
    prompt,
    model: prepared.selectedModelId,
    screens,
  };
}
