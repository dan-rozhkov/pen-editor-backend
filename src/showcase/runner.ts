import { generateText, stepCountIs, type ToolSet } from "ai";
import type { Config } from "../config.js";
import { prepareChatTurn } from "../ai/chatTurn.js";
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

// The message the agent receives. Starts with the `/prototype` slash command
// so prepareChatTurn/resolveTaskPolicy route it through the embed-only
// policy and the prototype skill (src/skills/prototype.md) — the same
// machinery /api/chat uses, never a hand-rolled prompt.
export function buildShowcasePrompt(theme: string): string {
  return (
    `/prototype мобильное приложение — ${theme}, до 5 экранов одного пользовательского флоу, ` +
    `единый визуальный стиль.`
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

function instrumentTools(
  tools: ToolSet,
  onScreens: (screens: ShowcaseScreenDraft[]) => Array<{ id: string; name: string }>,
): ToolSet {
  const instrumented: ToolSet = { ...tools };

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
): Promise<ShowcaseRunResult> {
  const prompt = buildShowcasePrompt(theme);
  const messages: Array<Record<string, unknown>> = [
    { id: "showcase-1", role: "user", parts: [{ type: "text", text: prompt }] },
  ];

  const prepared = await prepareChatTurn({
    config,
    messages,
    modelOverride: SHOWCASE_MODEL_ID,
  });

  const screens: ShowcaseScreenDraft[] = [];

  const tools = instrumentTools(prepared.tools, (extracted) => {
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
