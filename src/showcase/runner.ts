import { generateText, stepCountIs, type ToolSet } from "ai";
import type { Config } from "../config.js";
import { prepareChatTurn } from "../ai/chatTurn.js";
import { generateImage } from "../services/imageGen.js";
import { extractEmbedScreens } from "./extractEmbeds.js";

// Hard cap on screens kept per run — matches the showcase's product shape
// (a short flow, not a whole app). Anything beyond this is dropped and
// logged, never silently discarded without a trace.
export const MAX_SHOWCASE_SCREENS = 5;

// deepseek/deepseek-v4-pro is already in DEFAULT_MODELS (src/config.ts) and
// is text-only/cheap — fine for a batch/offline generation job that isn't
// latency-sensitive.
export const SHOWCASE_MODEL_ID = "deepseek/deepseek-v4-pro";

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
// The imagery clause deliberately overrides the skill's picsum.photos default
// for large images only. It lives in the user message, not in the skill file,
// because the skill is shared with production chat — where making every
// prototype request wait on image generation would be a very different
// product decision. Placed after the injected skill instructions, it reads as
// the requester's requirement rather than a contradiction of them.
export function buildShowcasePrompt(theme: string): string {
  return (
    `/prototype мобильное приложение — ${theme}, до 5 экранов одного пользовательского флоу, ` +
    `единый визуальный стиль.\n\n` +
    `Картинки: для КРУПНЫХ изображений — hero, обложка, карточка контента, продуктовое фото — ` +
    `не ставь picsum. Вызови generate_image с подробным описанием кадра в стиле этого приложения ` +
    `и подставь возвращённый url в <img src> или background-image. ` +
    `Мелочь (аватарки, микро-превью, иконки) оставляй как предписывает скилл — picsum или инициалы. ` +
    `Не больше ${MAX_GENERATED_IMAGES} генераций на весь прогон: сначала самые заметные кадры. ` +
    `Если инструмент вернул note про placeholder — используй присланный url как есть и не вызывай его снова.`
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
function makeGenerateImageTool(config: Config) {
  let generated = 0;

  return async ({ prompt }: { prompt: string }) => {
    if (generated >= MAX_GENERATED_IMAGES) {
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
    // calls in parallel, so reading `generated` back after the await reports
    // the final count for every one of them.
    const slot = (generated += 1);
    try {
      const { url } = await generateImage(config, prompt);
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
): ToolSet {
  const instrumented: ToolSet = { ...tools };
  const generateImageExecute = makeGenerateImageTool(config);

  for (const name of Object.keys(instrumented)) {
    const entry = instrumented[name] as { execute?: unknown };
    if (typeof entry.execute === "function") continue; // static tool, leave as-is

    if (name === "batch_design") {
      instrumented[name] = {
        ...instrumented[name],
        execute: async (args: { operations: string }) => {
          const extracted = extractEmbedScreens(args.operations);
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

// Runs one autonomous /prototype turn for `theme` and returns whatever embed
// screens the agent produced (0 to MAX_SHOWCASE_SCREENS — never throws just
// because the count is off that range; callers decide what "success" means).
export async function runShowcaseGeneration(
  config: Config,
  theme: string,
  modelId: string = SHOWCASE_MODEL_ID,
): Promise<ShowcaseRunResult> {
  const prompt = buildShowcasePrompt(theme);
  const messages: Array<Record<string, unknown>> = [
    { id: "showcase-1", role: "user", parts: [{ type: "text", text: prompt }] },
  ];

  const prepared = await prepareChatTurn({
    config,
    messages,
    modelOverride: modelId,
  });

  const screens: ShowcaseScreenDraft[] = [];

  const tools = instrumentTools(config, prepared.tools, (extracted) => {
    const created: Array<{ id: string; name: string }> = [];
    for (const screen of extracted) {
      if (screens.length >= MAX_SHOWCASE_SCREENS) {
        console.warn(
          `[showcase] dropping extra screen "${screen.name}" beyond the ${MAX_SHOWCASE_SCREENS}-screen cap`,
        );
        continue;
      }
      const id = `screen-${screens.length + 1}`;
      screens.push(screen);
      created.push({ id, name: screen.name });
    }
    return created;
  });

  await generateText({
    model: prepared.model,
    system: prepared.system,
    messages: prepared.modelMessages,
    tools,
    stopWhen: stepCountIs(SHOWCASE_MAX_STEPS),
  });

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
