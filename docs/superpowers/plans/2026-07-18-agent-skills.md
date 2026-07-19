# Agent Skills — Universal Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-mode switch (`edits`/`prototype`/`research`) with a universal entry where the agent self-loads a "mode" as a skill via a `load_skill` tool driven by a skill catalog in the system prompt; research becomes a plain reference-finding skill (no toolset swap).

**Architecture:** Backend: `prototype`/`research` mode-prompts move into Markdown skill files; `CORE_PROMPT` absorbs the edits-mode rules plus a rendered skill catalog and a prototype-routing rule; a new backend-executed `load_skill` tool (registered as a separate tool group, NOT in `penTools`) returns a skill's content; `chat.ts` drops the research toolset-swap/503 branch and always exposes the full toolset. Frontend: delete the mode dropdown and chat presets, stop sending `agentMode`, and remove `agentMode` from the chat state layer.

**Tech Stack:** Fastify + Vercel AI SDK v6 (`streamText`, `tool`) + zod (backend); Vite + React 19 + Zustand + Vitest (frontend).

## Global Constraints

- Backend is ESM `moduleResolution: NodeNext`: **every relative import in `.ts` must include the `.js` extension**.
- `load_skill` MUST NOT be added to `penTools` — it is registered as its own tool group (like `getWebTools`). This keeps `tools-contract.test.ts` / `toolContract.test.ts` untouched (no cross-repo merge-order constraint applies).
- Backend `agentMode` stays an **optional, ignored legacy field** on the request body and trace rows — do not remove it from the zod schema or trace payload. Old clients sending `agentMode: "research"` must still get a 200.
- Skill files live in `pen-editor-backend/src/skills/` and are read from `src/skills` in both `tsx` and compiled `dist` runs (the build copies them). Frontmatter format is strict: `---\n...\n---\n<body>` with `name:` and `description:` lines.
- No emoji in any generated content or skill copy.
- Backend green bar: `npm run lint && npm test && npm run build`. Frontend green bar: `npm run lint && npm test && npm run build`.
- Commit within each subproject separately (two independent git repos; the root is not a repo).

---

## Task 1: Extract `prototype` and `research` skill files

**Files:**
- Create: `pen-editor-backend/src/skills/prototype.md`
- Create: `pen-editor-backend/src/skills/research.md`
- Test: `pen-editor-backend/test/skills.test.ts` (extend)

**Interfaces:**
- Produces: two loadable skills named `prototype` and `research`, discoverable via `getSkill("prototype")` / `getSkill("research")` and `getAllSkills()`.

- [ ] **Step 1: Write the failing test** — append to `test/skills.test.ts`:

```ts
it("loads the prototype and research mode skills", async () => {
  await loadSkills();
  const proto = getSkill("prototype");
  expect(proto).toBeDefined();
  expect(proto!.description.length).toBeGreaterThan(0);
  // A distinctive snippet from the prototype mode content.
  expect(proto!.content).toContain("PROTOTYPE mode");

  const research = getSkill("research");
  expect(research).toBeDefined();
  expect(research!.content).toContain("design research agent");
});
```

(Reuse the existing `loadSkills`/`getSkill` imports already at the top of `skills.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- skills`
Expected: FAIL — `getSkill("prototype")` is `undefined`.

- [ ] **Step 3: Create `src/skills/prototype.md`**

Frontmatter, then the **exact** prototype-mode body. The body is the current value of `PROTOTYPE_MODE_PROMPT` in `src/ai/system-prompt.ts` (the `join("\n\n")` of `PROTOTYPE_MODE_CORE`, `PROTOTYPE_REFERENCE_IMAGES`, `PROTOTYPE_DESIGN_BASELINE`, `PROTOTYPE_TYPOGRAPHY`, `PROTOTYPE_COLOR_RULES`, `PROTOTYPE_LAYOUT_RULES`, `PROTOTYPE_MATERIALITY`, `PROTOTYPE_UI_STATES`, `PROTOTYPE_FORM_PATTERNS`, `PROTOTYPE_AI_TELLS`, `PROTOTYPE_CREATIVE_ARSENAL`, `PROTOTYPE_CONTENT_RULES`, `PROTOTYPE_PREFLIGHT`). Copy that assembled Markdown verbatim as the file body. Prepend:

```markdown
---
name: prototype
description: Build a single static HTML embed mockup/prototype from a request or screenshot (device presets, component-tag reuse, anti-slop taste rules). Load this when creating something new on the canvas or when an embed is selected.
---
```

Note: the source content is already Markdown (`## Agent Mode: prototype`, `### ...`, fenced ```html blocks). Keep it byte-for-byte; do not restyle. Leave the literal text `## Agent Mode: prototype` as-is (the test matches `PROTOTYPE mode`, which appears in the `PROTOTYPE_MODE_CORE` intro line "You are in PROTOTYPE mode.").

- [ ] **Step 4: Create `src/skills/research.md`**

Frontmatter, then the **exact** value of `RESEARCH_MODE_PROMPT` from `src/ai/system-prompt.ts` as the body, with ONE edit: soften the hard prohibition line so it reads as reference-finding guidance rather than a locked mode. Replace:

```
You do NOT create or modify designs. You ONLY research and analyze.
```

with:

```
Your focus is finding and analyzing real-world references. You normally research and report rather than edit the canvas, but the design tools remain available if the user explicitly asks you to apply findings.
```

Prepend:

```markdown
---
name: research
description: Find and analyze real-world design references via the Refero tools, then report structured findings (pattern analysis, steal list, key findings). Load this when the user wants references, inspiration, or competitive design research.
---
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- skills`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd pen-editor-backend
git add src/skills/prototype.md src/skills/research.md test/skills.test.ts
git commit -m "feat(skills): add prototype and research mode skills"
```

---

## Task 2: Refactor `system-prompt.ts` — universal core + skill catalog

**Files:**
- Modify: `pen-editor-backend/src/ai/system-prompt.ts`
- Test: `pen-editor-backend/test/system-prompt.test.ts`, `pen-editor-backend/test/system-prompt-image.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildSystemPrompt(canvasContext?: string, skills?: { name: string; description: string }[]): string` — new second parameter is a skill catalog (default `[]`). The old `agentMode` second parameter is REMOVED. `AGENT_MODES` / `AgentMode` remain exported unchanged (still used by the request-body zod enum for legacy compatibility).

- [ ] **Step 1: Rewrite the failing tests** — replace the body of `test/system-prompt.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { AGENT_MODES, buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("AGENT_MODES", () => {
  it("remains exported for legacy request-body validation", () => {
    expect(AGENT_MODES).toEqual(["edits", "prototype", "research"]);
  });
});

describe("buildSystemPrompt", () => {
  it("always returns the core prompt (no mode branching)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("expert design agent for the Pencil editor");
    // Mode-specific prompt blocks no longer live in the system prompt.
    expect(prompt).not.toContain("## Agent Mode: prototype");
    expect(prompt).not.toContain("You are in PROTOTYPE mode");
  });

  it("carries the edits-flow rules that used to live in EDITS_MODE_PROMPT", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("get_variables");
    // Default behaviour still forbids inserting embeds unless a skill directs it.
    expect(prompt.toLowerCase()).toContain("embed");
  });

  it("renders a skill catalog when skills are provided", () => {
    const prompt = buildSystemPrompt(undefined, [
      { name: "prototype", description: "Build a mockup." },
      { name: "polish", description: "Final visual pass." },
    ]);
    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("prototype");
    expect(prompt).toContain("Build a mockup.");
    expect(prompt).toContain("polish");
  });

  it("includes the prototype routing rule", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('type: "embed"');
    expect(prompt.toLowerCase()).toContain("create");
  });

  it("omits the catalog section when no skills are provided", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("Available Skills");
  });

  it("appends canvas context after the core prompt", () => {
    const prompt = buildSystemPrompt("<canvas state here>");
    expect(prompt).toContain("## Current Canvas Context");
    expect(prompt).toContain("<canvas state here>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- system-prompt`
Expected: FAIL (old signature/branches).

- [ ] **Step 3: Rewrite `system-prompt.ts`**

Keep `AGENT_MODES`/`AgentMode` exports. Delete `EDITS_MODE_PROMPT`, `PROTOTYPE_MODE_PROMPT`, `RESEARCH_MODE_PROMPT`, and every `PROTOTYPE_*` const (now in `prototype.md`). Fold the behavioral rules from the old `EDITS_MODE_PROMPT` (mandatory flow, component reuse, embed restriction) into `CORE_PROMPT`, softened so a loaded skill can override the embed restriction. Add a skill-catalog renderer and the routing rule. New top of file:

```ts
export const AGENT_MODES = ["edits", "prototype", "research"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

export function buildSystemPrompt(
  canvasContext?: string,
  skills: SkillCatalogEntry[] = [],
): string {
  const parts: string[] = [CORE_PROMPT];

  if (skills.length > 0) {
    parts.push(renderSkillCatalog(skills));
  }

  if (canvasContext) {
    parts.push(`\n## Current Canvas Context\n\n${canvasContext}`);
  }

  return parts.join("\n");
}

function renderSkillCatalog(skills: SkillCatalogEntry[]): string {
  const lines = skills
    .map((s) => `- \`${s.name}\` — ${s.description}`)
    .join("\n");
  return `
## Available Skills

You can load extra task-specific instructions on demand. When the user's request matches one of the skills below, call the \`load_skill\` tool with its \`name\` BEFORE doing the work, then follow the returned instructions for the rest of the turn. Load at most one skill unless a task clearly spans several.

${lines}

### Routing rule: when to load \`prototype\`
Load the \`prototype\` skill (instead of the default native-node edit flow) whenever EITHER condition holds:
- an \`embed\` node is selected — check \`selectedNodes\` in the Canvas Context for an entry with \`type: "embed"\`; OR
- the user asks to CREATE something new on the canvas — a new screen, page, dashboard, mockup, prototype, or "build / create / design a ...".

Use the default edit flow (native canvas nodes, no \`load_skill\`) only for modifying existing native nodes.`;
}
```

Then extend the existing `CORE_PROMPT` string: append the mandatory-flow, component-reuse, and embed-default rules previously in `EDITS_MODE_PROMPT`, rephrasing the embed line as a default rather than an absolute (e.g. "By default, build with native canvas nodes and do NOT insert new `embed` nodes — unless a loaded skill (such as `prototype`) directs you to."). Preserve all other `CORE_PROMPT` content verbatim.

- [ ] **Step 4: Update `system-prompt-image.test.ts`**

The old test asserted image-tool docs appear "in prototype mode too" via `buildSystemPrompt(undefined, "prototype")`. Image docs live in `CORE_PROMPT` (`## Generating Images`). Replace the prototype-mode variant with a single default-prompt assertion:

```ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("buildSystemPrompt — image tools", () => {
  it("documents the image generation tools in the core prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("generate_image");
    expect(prompt).toContain("generate_frame_image");
  });
});
```

(Match the exact tool names/strings present in the current `## Generating Images` section; adjust the assertions to real substrings if these differ.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- system-prompt`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd pen-editor-backend
git add src/ai/system-prompt.ts test/system-prompt.test.ts test/system-prompt-image.test.ts
git commit -m "refactor(system-prompt): universal core + skill catalog, drop mode branching"
```

---

## Task 3: Add the `load_skill` tool

**Files:**
- Modify: `pen-editor-backend/src/ai/skills.ts`
- Test: `pen-editor-backend/test/skills.test.ts` (extend)

**Interfaces:**
- Consumes: `getSkill`, `getAllSkills` (same module).
- Produces: `getSkillTools(): Record<string, unknown>` returning `{ load_skill }`. `load_skill` input `{ name: string }`; on hit returns `{ name, instructions }`, on miss returns `{ error }` listing available names.

- [ ] **Step 1: Write the failing test** — append to `test/skills.test.ts`:

```ts
import { getSkillTools } from "../src/ai/skills.js"; // add to existing imports

describe("getSkillTools / load_skill", () => {
  it("returns the skill instructions for a known skill", async () => {
    await loadSkills();
    const tools = getSkillTools() as {
      load_skill: { execute: (a: { name: string }) => Promise<unknown> };
    };
    const out = (await tools.load_skill.execute({ name: "prototype" })) as {
      name: string;
      instructions: string;
    };
    expect(out.name).toBe("prototype");
    expect(out.instructions).toContain("PROTOTYPE mode");
  });

  it("returns an error listing available skills for an unknown name", async () => {
    await loadSkills();
    const tools = getSkillTools() as {
      load_skill: { execute: (a: { name: string }) => Promise<unknown> };
    };
    const out = (await tools.load_skill.execute({ name: "nope" })) as {
      error: string;
    };
    expect(out.error).toContain("nope");
    expect(out.error).toContain("prototype");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- skills`
Expected: FAIL — `getSkillTools` is not exported.

- [ ] **Step 3: Implement `getSkillTools`** in `src/ai/skills.ts` (add imports `import { tool } from "ai";` and `import { z } from "zod";` at the top):

```ts
export function getSkillTools(): Record<string, unknown> {
  const load_skill = tool({
    description:
      "Load a skill's full instructions by name. Call this when the user's task matches a skill listed in the 'Available Skills' catalog in your system prompt. Returns the skill's instructions to follow for the current turn.",
    inputSchema: z.object({
      name: z
        .string()
        .describe("The exact skill name from the Available Skills catalog."),
    }),
    execute: async ({ name }: { name: string }) => {
      const skill = getSkill(name);
      if (!skill) {
        const available = getAllSkills()
          .map((s) => s.name)
          .join(", ");
        return {
          error: `Unknown skill "${name}". Available skills: ${available}`,
        };
      }
      return { name: skill.name, instructions: skill.content };
    },
  });
  return { load_skill };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- skills`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd pen-editor-backend
git add src/ai/skills.ts test/skills.test.ts
git commit -m "feat(skills): add backend-executed load_skill tool"
```

---

## Task 4: Wire `chat.ts` — universal toolset, drop research branch

**Files:**
- Modify: `pen-editor-backend/src/routes/chat.ts`
- Test: `pen-editor-backend/test/chat-route.test.ts`

**Interfaces:**
- Consumes: `getSkillTools` (Task 3), `buildSystemPrompt(canvasContext, skills)` (Task 2), `getAllSkills` (already imported).

- [ ] **Step 1: Rewrite the failing test** — in `test/chat-route.test.ts`, replace the entire `describe("POST /api/chat — research mode", ...)` block (the 503 test) with:

```ts
describe("POST /api/chat — universal toolset", () => {
  it("no longer 503s without MCP when a legacy research mode is requested", async () => {
    holders.mcpTools = {};
    holders.model = mockModel(textStreamChunks("done"));
    const res = await postChat(server.url, {
      messages: [userMessage("research pricing pages")],
      agentMode: "research", // legacy field — ignored now
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("exposes the load_skill tool and the skill catalog to the model", async () => {
    holders.mcpTools = {};
    const model = mockModel(textStreamChunks("done"));
    holders.model = model;
    const res = await postChat(server.url, {
      messages: [userMessage("make me a dashboard")],
    });
    expect(res.status).toBe(200);
    await res.text();

    const call = model.doStreamCalls[0];
    // The catalog is injected into the system prompt.
    const systemText = JSON.stringify(call.prompt).includes("Available Skills")
      || String((call as { system?: string }).system ?? "").includes("Available Skills");
    expect(systemText).toBe(true);
    // load_skill is registered in the toolset.
    const toolNames = (call.tools ?? []).map(
      (t: { name?: string }) => t.name,
    );
    expect(toolNames).toContain("load_skill");
  });
});
```

Note: if `mockModel`/`doStreamCalls` expose `system` and `tools` differently, adjust the two assertions to the actual shape — the intent is (a) 200 without MCP, and (b) `load_skill` present + catalog in the system prompt. Confirm the exact accessor by reading one existing assertion on `model.doStreamCalls[0]` in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- chat-route`
Expected: FAIL — currently returns 503 / `load_skill` absent.

- [ ] **Step 3: Edit `chat.ts`.** Apply these changes:

1. Import the skill tool and keep `getAllSkills`:

```ts
import { detectSkillCommand, getAllSkills, getSkill, getSkillTools } from "../ai/skills.js";
```

2. Collapse `MAX_AGENT_STEPS`:

```ts
const MAX_AGENT_STEPS = 12;
```

3. Build the system prompt with the catalog:

```ts
const skillCatalog = getAllSkills().map((s) => ({
  name: s.name,
  description: s.description,
}));
const system = buildSystemPrompt(canvasContext, skillCatalog);
```

4. Remove the research branch entirely. Delete:

```ts
const isResearch = agentMode === "research";
if (isResearch && Object.keys(mcpTools).length === 0) {
  return reply.status(503).send({ ... });
}
const tools = isResearch ? (mcpTools as ToolSet) : { ...penTools, ...getWebTools(config), ...mcpTools };
const maxSteps = isResearch ? MAX_AGENT_STEPS.research : MAX_AGENT_STEPS.default;
```

Replace with:

```ts
const tools = {
  ...penTools,
  ...getWebTools(config),
  ...mcpTools,
  ...getSkillTools(),
} as ToolSet;
const maxSteps = MAX_AGENT_STEPS;
```

5. Keep `agentMode` destructured from `parsed.data` (default `"edits"`) and keep it in `buildTraceRow`'s `agentMode` field — it is now a legacy passthrough. Leave `chatBodySchema`'s `agentMode: z.enum(AGENT_MODES).optional()` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- chat-route`
Expected: PASS. Then full backend suite: `npm test`. Expected: PASS.

- [ ] **Step 5: Verify build + lint**

Run: `npm run lint && npm run build`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
cd pen-editor-backend
git add src/routes/chat.ts test/chat-route.test.ts
git commit -m "feat(chat): universal toolset with load_skill, drop research mode branch"
```

---

## Task 5: Remove the mode dropdown and chat presets (frontend UI)

**Files:**
- Delete: `pen-editor/src/components/chat/chatPresets.ts`
- Delete: `pen-editor/src/components/chat/__tests__/chatPresets.test.ts`
- Modify: `pen-editor/src/components/chat/ChatPanel.tsx`
- Test: `pen-editor/src/components/chat/__tests__/ChatPanel.test.tsx`, `.../ChatPanel.multisession.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: a `ChatPanel` with no mode `<Select>` and no preset list; model selector stays. `agentMode` store reads/writes are removed from this component (the field itself is removed in Task 6).

- [ ] **Step 1: Delete preset files**

```bash
cd pen-editor
git rm src/components/chat/chatPresets.ts src/components/chat/__tests__/chatPresets.test.ts
```

- [ ] **Step 2: Strip presets + mode dropdown from `ChatPanel.tsx`**

Remove: the `CHAT_PRESETS`/`ChatPreset` imports; `MODE_OPTIONS`; the `PresetList` component and its `data-testid="preset-list"` block; the `showPresets` prop threading and the `applyPreset`/`onSelect` handler (which called `setAgentMode`/`setModel`); the mode `<Select value={agentMode} ...>`; and the `agentMode`/`setAgentMode` store selectors used only for that control. Keep the model `<Select>`. If an empty-state previously rendered `PresetList`, replace it with nothing (or the existing placeholder text).

- [ ] **Step 3: Update ChatPanel tests**

In `ChatPanel.test.tsx` and `ChatPanel.multisession.test.tsx`, remove assertions that query `preset-list` / `preset-*` testids or the mode dropdown, and any `setAgentMode` expectations. Keep model-selection and messaging assertions.

- [ ] **Step 4: Run the tests + typecheck**

Run: `npm test -- ChatPanel`
Expected: PASS.
Run: `npm run build`
Expected: may still FAIL only if `agentMode` store members are already gone — but Task 6 removes those; if `ChatPanel` no longer references `agentMode`, build should pass now. If build fails solely due to remaining `agentMode` references elsewhere, that is expected and resolved in Task 6.

- [ ] **Step 5: Commit**

```bash
cd pen-editor
git add -A src/components/chat
git commit -m "feat(chat): remove mode dropdown and presets from chat UI"
```

---

## Task 6: Remove `agentMode` from the chat state layer (frontend)

**Files:**
- Modify: `pen-editor/src/store/chatStore.ts`
- Modify: `pen-editor/src/hooks/useDesignChat.ts`
- Modify: `pen-editor/src/lib/launchNodeAgentChat.ts`, `launchEmbedAgentChat.ts`, `launchFrameAgentChat.ts`
- Test: `pen-editor/src/hooks/__tests__/useDesignChat.test.ts`, `.../launchEmbedAgentChat.test.ts`, `.../sendCommentToAgent.test.ts`, `.../ChatPanel.multisession.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildCanvasContext` returns a body WITHOUT `agentMode`; `chatStore` no longer defines `agentMode`, `AgentMode`, `setAgentMode`, `setTabAgentMode`, `normalizeAgentMode`, `DEFAULT_AGENT_MODE`, or the per-tab `agentMode`; launchers drop their `agentMode` parameter.

- [ ] **Step 1: Update the failing test first** — in `useDesignChat.test.ts`, change the assertion on `buildCanvasContext()`'s return so it no longer expects `agentMode`, and assert its absence:

```ts
const body = buildCanvasContext() as Record<string, unknown>;
expect(body).not.toHaveProperty("agentMode");
expect(typeof body.canvasContext).toBe("string");
expect(typeof body.model).toBe("string");
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- useDesignChat`
Expected: FAIL (still emits `agentMode`).

- [ ] **Step 3: Remove `agentMode` from `chatStore.ts`**

Delete: `AgentMode` type; `agentMode` from `ChatTab` and `ChatState`; `DEFAULT_AGENT_MODE`; `normalizeAgentMode`; `setAgentMode`; `setTabAgentMode`; every `agentMode` initializer in tab constructors and switch/persist logic; and the `localStorage` read/write of `"chat-agent-mode"`. Keep `model`, `parallelCount`, tabs, and their persistence intact.

- [ ] **Step 4: Remove `agentMode` from `useDesignChat.ts`**

In `resolveSessionConfig`, drop `agentMode` from the returned object and its type. In `buildCanvasContext`, remove `agentMode` from the destructure and from the returned body object. Keep `model` and `canvasContext` (which already includes `selectedNodes[].type` — the signal the backend routing rule reads).

- [ ] **Step 5: Simplify the launchers**

Remove the `agentMode` parameter from `launchNodeAgentChat` (drop `opts.agentMode` and the `setTabAgentMode` call), `launchEmbedAgentChat`, and `launchFrameAgentChat`. Their callers (frame/embed/node agent buttons) now launch a plain chat; the backend routing rule selects `prototype` from the selected node type / new-canvas intent.

- [ ] **Step 6: Update remaining tests**

In `launchEmbedAgentChat.test.ts`, `sendCommentToAgent.test.ts`, and `ChatPanel.multisession.test.tsx`, remove `agentMode`/`setTabAgentMode` expectations and any `AgentMode` imports/typings.

- [ ] **Step 7: Run full frontend suite + build + lint**

Run: `npm test`
Expected: PASS.
Run: `npm run lint && npm run build`
Expected: 0 errors, no dangling `agentMode` references.

- [ ] **Step 8: Commit**

```bash
cd pen-editor
git add -A
git commit -m "refactor(chat): remove agentMode from chat state layer"
```

---

## Task 7: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Backend green bar**

Run (in `pen-editor-backend`): `npm run lint && npm test && npm run build`
Expected: all pass.

- [ ] **Step 2: Frontend green bar**

Run (in `pen-editor`): `npm run lint && npm test && npm run build`
Expected: all pass.

- [ ] **Step 3: Contract job locally (optional but recommended)**

Run (in `pen-editor`): `CONTRACT_REQUIRE_BACKEND=1 npm test -- toolContract`
Expected: PASS — `load_skill` is not in `penTools`, so the penTools↔registry contract is unaffected.

- [ ] **Step 4: Manual smoke (live dev, not CI)**

Start backend (`npm run dev`) and frontend (`npm run dev`). In the editor chat: (a) "build a pricing page" on an empty canvas → confirm the model calls `load_skill("prototype")` (visible in agent step logs / `ENABLE_AGENT_LOGGING`) and inserts one embed; (b) select an existing embed and ask to tweak it → confirm `prototype` is loaded; (c) "find reference dashboards" → confirm `load_skill("research")` and Refero usage when MCP is configured; (d) a plain native-node edit ("rename these layers") → confirm NO skill is loaded (default flow). Confirm the chat UI shows a single input with a model selector, no mode dropdown, no presets.

---

## Self-Review notes

- **Spec coverage:** modes→skills (T1), catalog + routing rule + edits-content fold (T2), `load_skill` (T3), toolset/branch removal + legacy `agentMode` (T4), presets + dropdown removal (T5), state-layer `agentMode` removal (T6), DoD verification (T7). All DoD bullets map to a task.
- **Contract:** `load_skill` deliberately outside `penTools`; no cross-repo merge-order constraint (unlike `penTools` changes).
- **Legacy safety:** `agentMode` stays optional on the backend body/trace; only the frontend stops sending it.
- **Type consistency:** `SkillCatalogEntry {name, description}` produced by T2, consumed by T4's `getAllSkills().map(...)`; `getSkillTools()` produced by T3, consumed by T4.
