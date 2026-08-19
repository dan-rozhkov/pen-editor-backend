# Точечное редактирование HTML-прототипа — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать агенту два инструмента — `read_embed_html` и `edit_embed_html` — чтобы правка существующего HTML-экрана стоила сотни токенов вместо тысяч и не переписывала экран целиком.

**Architecture:** Классическая split-execution схема проекта: zod-схемы объявляются в `pen-editor-backend/src/ai/tools.ts` без `execute`, исполнение живёт во фронтенде (`pen-editor/src/lib/tools/`) против Zustand-стора. Вся строковая логика вынесена в чистые модули без зависимости от стора, чтобы тестироваться напрямую.

**Tech Stack:** TypeScript, zod v4 + AI SDK `tool()` (бэкенд, ESM — относительные импорты **с `.js`**), React 19 + Zustand + Vitest/happy-dom (фронтенд, алиас `@/` → `src/`).

**Spec:** `pen-editor-backend/docs/specs/2026-08-19-incremental-embed-html-editing-design.md`

## Global Constraints

- **Порядок мержа:** сначала весь бэкенд (Задачи 1–2) в `main` репозитория `pen-editor-backend`, только потом фронтенд (Задачи 3–6) в `main` репозитория `pen-editor`. Обратный порядок красит CI-джобу `contract` на каждый пуш фронтенда.
- **Имена инструментов ровно такие:** `read_embed_html`, `edit_embed_html`. Они должны совпадать байт-в-байт в `penTools`, в `toolHandlers` и в обоих списках `test/tools-contract.test.ts`.
- **Бэкенд — ESM/NodeNext:** относительные импорты пишутся с расширением `.js` даже в `.ts`.
- **Оба инструмента — клиент-исполняемые:** в `penTools` у них НЕ должно быть `execute`.
- **Совпадение якоря только точное.** Никакой нормализации пробелов, регистра или кавычек при поиске `oldString`.
- **Атомарность:** при любой ошибке `edit_embed_html` стор не изменяется вовсе.
- **Максимум 20 правок** за один вызов `edit_embed_html`.
- **Два репозитория рядом:** `~/prj/pen-editor-app/pen-editor` и `~/prj/pen-editor-app/pen-editor-backend`. `cd` в Bash не переживает вызовы — указывай абсолютный путь в каждой команде.
- Никогда не `git add -A`: в дереве могут работать другие сессии. Добавляй только перечисленные в задаче файлы.

---

### Task 1: Схемы инструментов на бэкенде

**Files:**
- Modify: `pen-editor-backend/src/ai/tools.ts` (добавить два инструмента в объект `penTools`, рядом с `rename_layers` на ~строке 774)
- Test: `pen-editor-backend/test/tools-contract.test.ts` (два списка имён: ~строка 42 и ~строка 82; новые describe-блоки в конце файла)

**Interfaces:**
- Consumes: ничего.
- Produces: `penTools.read_embed_html`, `penTools.edit_embed_html` — обе записи без `execute`. Формы входа, на которые опираются Задачи 4 и 6:
  - `edit_embed_html`: `{ nodeId: string, edits: Array<{ oldString: string, newString: string, replaceAll?: boolean }> }`
  - `read_embed_html`: `{ nodeId: string, mode: "outline" | "grep" | "full", pattern?: string, contextLines: number, maxDepth: number }`

- [ ] **Step 1: Написать падающие тесты контракта**

В `pen-editor-backend/test/tools-contract.test.ts` добавить `"read_embed_html"` и `"edit_embed_html"` в **оба** массива имён (в тот, что сравнивается с `Object.keys(penTools).sort()`, ~строка 42, и в список клиент-исполняемых инструментов, ~строка 82), затем дописать в конец файла:

```ts
describe("edit_embed_html schema", () => {
  const schema = (penTools.edit_embed_html as { inputSchema: z.ZodTypeAny }).inputSchema;

  it("accepts a minimal single edit", () => {
    const parsed = schema.parse({
      nodeId: "embed1",
      edits: [{ oldString: "#111", newString: "#222" }],
    });
    expect(parsed.edits[0].replaceAll).toBeUndefined();
  });

  it("rejects an empty edits array", () => {
    expect(() => schema.parse({ nodeId: "embed1", edits: [] })).toThrow();
  });

  it("rejects more than 20 edits", () => {
    const edits = Array.from({ length: 21 }, (_, i) => ({ oldString: `a${i}`, newString: "b" }));
    expect(() => schema.parse({ nodeId: "embed1", edits })).toThrow();
  });

  it("rejects an empty oldString but allows an empty newString (deletion)", () => {
    expect(() => schema.parse({ nodeId: "e", edits: [{ oldString: "", newString: "x" }] })).toThrow();
    expect(() => schema.parse({ nodeId: "e", edits: [{ oldString: "x", newString: "" }] })).not.toThrow();
  });
});

describe("read_embed_html schema", () => {
  const schema = (penTools.read_embed_html as { inputSchema: z.ZodTypeAny }).inputSchema;

  it("defaults to outline mode with sane context/depth", () => {
    const parsed = schema.parse({ nodeId: "embed1" });
    expect(parsed.mode).toBe("outline");
    expect(parsed.contextLines).toBe(2);
    expect(parsed.maxDepth).toBe(4);
  });

  it("requires a pattern in grep mode", () => {
    expect(() => schema.parse({ nodeId: "embed1", mode: "grep" })).toThrow();
    expect(() => schema.parse({ nodeId: "embed1", mode: "grep", pattern: "btn" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run test/tools-contract.test.ts`
Expected: FAIL — имена отсутствуют в `penTools`, `penTools.edit_embed_html` undefined.

- [ ] **Step 3: Добавить схемы в `src/ai/tools.ts`**

Вставить сразу после записи `rename_layers` (перед `boolean_operation`):

```ts
  read_embed_html: tool({
    description:
      "Read part of an existing embed node's HTML without pulling the whole document into context. " +
      "`outline` (default) returns the tag structure with attributes intact and text/deep subtrees elided — " +
      "use it to see how a screen is built. `grep` returns the lines matching a literal substring with surrounding " +
      "context — use it to get byte-exact anchors for edit_embed_html. `full` returns the entire HTML; avoid it " +
      "unless you are genuinely rewriting the screen. Always read before editing: edit_embed_html matches text exactly.",
    inputSchema: z
      .object({
        nodeId: z.string().describe("Id of the embed node to read."),
        mode: z
          .enum(["outline", "grep", "full"])
          .default("outline")
          .describe("outline = elided structure, grep = matches for `pattern`, full = entire HTML."),
        pattern: z
          .string()
          .optional()
          .describe("Literal substring to search for (not a regex). Required when mode is 'grep'."),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(2)
          .describe("Lines of context around each grep match."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(12)
          .default(4)
          .describe("Nesting depth kept in outline mode; deeper subtrees are summarized."),
      })
      .refine((a) => a.mode !== "grep" || (a.pattern ?? "").length > 0, {
        message: "pattern is required when mode is 'grep'",
      }),
  }),

  edit_embed_html: tool({
    description:
      "Apply targeted text edits to an existing embed node's HTML instead of rewriting the whole screen. " +
      "Each edit replaces an exact substring (`oldString`) with `newString`; an empty `newString` deletes the match. " +
      "ALWAYS use this — never batch_design `U(id, {htmlContent: ...})` — when changing part of a screen that already " +
      "exists: rewriting a whole screen costs thousands of tokens and silently drifts parts you were not asked to touch. " +
      "Read the fragment with read_embed_html first; matching is exact, with no whitespace normalization. " +
      "Each oldString must occur exactly once unless replaceAll is true. Edits apply in order and atomically — if any " +
      "edit fails to match, nothing is changed.",
    inputSchema: z.object({
      nodeId: z.string().describe("Id of the embed node to edit."),
      edits: z
        .array(
          z.object({
            oldString: z
              .string()
              .min(1)
              .describe("Exact substring to find. Must occur exactly once unless replaceAll is true."),
            newString: z.string().describe("Replacement text. An empty string deletes the matched fragment."),
            replaceAll: z
              .boolean()
              .optional()
              .describe("Replace every occurrence instead of requiring a unique match."),
          }),
        )
        .min(1)
        .max(20)
        .describe("Edits applied in order, each against the result of the previous one."),
    }),
  }),
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend && npx vitest run test/tools-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Прогнать линт и сборку**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend && npm run lint && npm run build`
Expected: 0 ошибок.

- [ ] **Step 6: Коммит**

```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
git add src/ai/tools.ts test/tools-contract.test.ts
git commit -m "feat: add read_embed_html and edit_embed_html tool schemas"
```

---

### Task 2: Промпт-гейт (бэкенд)

Без него модель продолжит переписывать экран целиком по привычке — новые инструменты просто не будут вызываться.

**Files:**
- Modify: `pen-editor-backend/src/ai/system-prompt.ts` (вставить секцию между `## Embed default` и `## Embed fit-to-canvas`, ~строка 340)
- Modify: `pen-editor-backend/src/skills/prototype.md`, `pen-editor-backend/src/skills/slides.md`
- Test: `pen-editor-backend/test/system-prompt.test.ts` (файл существует, дописать describe-блок в конец)

**Interfaces:**
- Consumes: имена инструментов из Задачи 1.
- Produces: ничего для кода; поведенческий контракт для модели.

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `pen-editor-backend/test/system-prompt.test.ts` (`buildSystemPrompt` уже импортирован в шапке файла, все аргументы необязательны):

```ts
describe("editing an existing embed", () => {
  it("routes partial screen edits to edit_embed_html, not batch_design", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("edit_embed_html");
    expect(prompt).toContain("read_embed_html");
    expect(prompt).toContain("Editing an existing embed");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend && npx vitest run test/system-prompt.test.ts`
Expected: FAIL — строки в промпте нет.

- [ ] **Step 3: Вставить секцию в `src/ai/system-prompt.ts`**

Перед строкой `## Embed fit-to-canvas` добавить:

```
## Editing an existing embed (CRITICAL)
When you change part of a screen that already exists, use \`read_embed_html\` to locate the fragment and \`edit_embed_html\` to replace it. Do NOT rewrite the screen with \`batch_design\` \`U(id, {htmlContent: "..."})\` — that costs thousands of tokens, risks a truncated generation, and silently drifts spacing, copy and ordering you were not asked to touch. \`U(id, {htmlContent})\` is only for replacing a screen wholesale with a different concept.
```

- [ ] **Step 4: Продублировать правило в скиллах**

В `src/skills/prototype.md` и `src/skills/slides.md` добавить в раздел про правки (или в конец, отдельным подзаголовком):

```markdown
## Editing screens you already made

Use `read_embed_html` (mode `grep`) to get the exact fragment, then `edit_embed_html` to replace it.
Rewriting the whole `htmlContent` through `batch_design` is reserved for replacing a screen with a
different concept — never for a tweak.
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend && npx vitest run && npm run lint && npm run build`
Expected: всё зелёное.

- [ ] **Step 6: Коммит и пуш бэкенда**

```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend
git add src/ai/system-prompt.ts src/skills/prototype.md src/skills/slides.md test/system-prompt.test.ts
git commit -m "feat: route partial screen edits to edit_embed_html in prompt and skills"
git push origin main
```

**СТОП-ГЕЙТ:** дождись зелёного CI на `pen-editor-backend`, и только после этого начинай Задачу 3. Фронтенд-задачи ломают `contract`-джобу, пока схемы не в `main`.

---

### Task 3: Движок anchor-правок (чистый модуль, фронтенд)

**Files:**
- Create: `pen-editor/src/lib/embedHtmlEdit/applyAnchorEdits.ts`
- Test: `pen-editor/src/lib/embedHtmlEdit/__tests__/applyAnchorEdits.test.ts`

**Interfaces:**
- Consumes: ничего (чистые строки, без стора).
- Produces:
  ```ts
  export interface AnchorEdit { oldString: string; newString: string; replaceAll?: boolean }
  export interface AnchorEditResult { html: string; replacements: number }
  export class AnchorEditError extends Error {}
  export function applyAnchorEdits(html: string, edits: AnchorEdit[]): AnchorEditResult
  ```
  Кидает `AnchorEditError` при промахе/неоднозначности; при успехе возвращает новую строку. Ничего не мутирует.

- [ ] **Step 1: Написать падающие тесты**

```ts
import { describe, it, expect } from "vitest";
import { applyAnchorEdits, AnchorEditError } from "../applyAnchorEdits";

describe("applyAnchorEdits", () => {
  it("replaces a unique anchor", () => {
    const result = applyAnchorEdits('<button class="cta">Buy</button>', [
      { oldString: ">Buy<", newString: ">Get started<" },
    ]);
    expect(result.html).toBe('<button class="cta">Get started</button>');
    expect(result.replacements).toBe(1);
  });

  it("applies edits in order, each against the previous result", () => {
    const result = applyAnchorEdits("a-b-c", [
      { oldString: "a", newString: "x" },
      { oldString: "x-b", newString: "y" },
    ]);
    expect(result.html).toBe("y-c");
    expect(result.replacements).toBe(2);
  });

  it("throws when the anchor is missing", () => {
    expect(() => applyAnchorEdits("<p>hi</p>", [{ oldString: "nope", newString: "x" }]))
      .toThrow(AnchorEditError);
  });

  it("throws when the anchor is ambiguous and reports the count", () => {
    expect(() => applyAnchorEdits("<i></i><i></i>", [{ oldString: "<i>", newString: "<b>" }]))
      .toThrow(/occurs 2 times/);
  });

  it("replaces every occurrence with replaceAll", () => {
    const result = applyAnchorEdits("#111 and #111", [
      { oldString: "#111", newString: "#222", replaceAll: true },
    ]);
    expect(result.html).toBe("#222 and #222");
    expect(result.replacements).toBe(2);
  });

  it("deletes the fragment when newString is empty", () => {
    const result = applyAnchorEdits("<p>keep</p><p>drop</p>", [
      { oldString: "<p>drop</p>", newString: "" },
    ]);
    expect(result.html).toBe("<p>keep</p>");
  });

  it("treats $& and $1 in newString as literal text", () => {
    const result = applyAnchorEdits("cost: X", [{ oldString: "X", newString: "$& $1" }]);
    expect(result.html).toBe("cost: $& $1");
  });

  it("does not normalize whitespace when matching", () => {
    expect(() => applyAnchorEdits("<p>  a  </p>", [{ oldString: "<p> a </p>", newString: "" }]))
      .toThrow(AnchorEditError);
  });

  it("leaves the input untouched when a later edit fails", () => {
    const input = "a-b";
    expect(() =>
      applyAnchorEdits(input, [
        { oldString: "a", newString: "x" },
        { oldString: "zzz", newString: "y" },
      ]),
    ).toThrow(AnchorEditError);
    expect(input).toBe("a-b");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/embedHtmlEdit/__tests__/applyAnchorEdits.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать модуль**

```ts
/**
 * Anchor-based text edits for embed HTML: each edit replaces an exact
 * substring. Matching is deliberately exact — no whitespace or quote
 * normalization — because a "smart" match silently hits the neighbouring
 * lookalike block, which is far more expensive than a failed edit.
 */

export interface AnchorEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface AnchorEditResult {
  html: string;
  replacements: number;
}

export class AnchorEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorEditError";
  }
}

const CONTEXT_CHARS = 40;
const MAX_REPORTED_CONTEXTS = 3;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    from = index + needle.length;
  }
}

/** Up to three "…text…" windows around the first occurrences, for error messages. */
function occurrenceContexts(haystack: string, needle: string): string[] {
  const contexts: string[] = [];
  let from = 0;
  while (contexts.length < MAX_REPORTED_CONTEXTS) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    const start = Math.max(0, index - CONTEXT_CHARS);
    const end = Math.min(haystack.length, index + needle.length + CONTEXT_CHARS);
    contexts.push(`…${haystack.slice(start, end)}…`);
    from = index + needle.length;
  }
  return contexts;
}

export function applyAnchorEdits(html: string, edits: AnchorEdit[]): AnchorEditResult {
  let current = html;
  let replacements = 0;

  edits.forEach((edit, i) => {
    const label = `Edit ${i + 1}`;
    if (edit.oldString.length === 0) {
      throw new AnchorEditError(`${label}: oldString must not be empty.`);
    }

    const occurrences = countOccurrences(current, edit.oldString);
    if (occurrences === 0) {
      throw new AnchorEditError(
        `${label}: oldString not found. Nothing was changed. ` +
          `Call read_embed_html with mode "grep" to get the exact text — matching is byte-exact.`,
      );
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new AnchorEditError(
        `${label}: oldString occurs ${occurrences} times. Nothing was changed. ` +
          `Extend the anchor with surrounding text to make it unique, or pass replaceAll: true. ` +
          `Occurrences: ${occurrenceContexts(current, edit.oldString).join(" | ")}`,
      );
    }

    if (edit.replaceAll) {
      // split/join, not String.replace: `$&`/`$1` in newString are literal text here.
      current = current.split(edit.oldString).join(edit.newString);
      replacements += occurrences;
    } else {
      const index = current.indexOf(edit.oldString);
      current =
        current.slice(0, index) + edit.newString + current.slice(index + edit.oldString.length);
      replacements += 1;
    }
  });

  return { html: current, replacements };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/embedHtmlEdit/__tests__/applyAnchorEdits.test.ts`
Expected: PASS, 9 тестов.

- [ ] **Step 5: Коммит**

```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor
git add src/lib/embedHtmlEdit/applyAnchorEdits.ts src/lib/embedHtmlEdit/__tests__/applyAnchorEdits.test.ts
git commit -m "feat: add anchor-based edit engine for embed HTML"
```

---

### Task 4: Хендлер `edit_embed_html`

**Files:**
- Create: `pen-editor/src/lib/tools/editEmbedHtml.ts`
- Modify: `pen-editor/src/lib/toolRegistry.ts` (импорт + запись в `toolHandlers`)
- Test: `pen-editor/src/lib/tools/__tests__/editEmbedHtml.test.ts`

**Interfaces:**
- Consumes: `applyAnchorEdits`, `AnchorEditError` из Задачи 3; `EmbedNode` из `@/types/scene`; `normalizeEmbedHtmlForStorage`, `propagateComponentChanges` из `@/utils/embedTemplateUtils`; `collectDocumentComponents`, `buildDocumentComponentTagMap` из `@/lib/documentComponents`; `saveHistory` из `@/store/sceneStore/helpers/history`.
- Produces: `export const editEmbedHtml: ToolHandler`, зарегистрированный как `edit_embed_html`. Возвращает JSON-строку `{ nodeId, editsApplied, replacements, htmlLength, targetedSourceTemplate, issues }` либо `{ error }`.

**Ключевой инвариант:** правится `sourceTemplate`, если он есть. `sourceTemplate` — авторский текст с тегами `<c-…>`, а `htmlContent` — его развёрнутая версия; правка развёрнутого HTML была бы затёрта при следующем разворачивании.

- [ ] **Step 1: Написать падающие тесты**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useSceneStore } from "@/store/sceneStore";
import { useHistoryStore } from "@/store/historyStore";
import { resetStores } from "@/test/fixtures";
import type { FlatSceneNode } from "@/types/scene";
import { editEmbedHtml } from "../editEmbedHtml";

function seedEmbed(id: string, htmlContent: string, extra: Record<string, unknown> = {}) {
  const node = {
    id,
    type: "embed",
    name: "Screen",
    x: 0,
    y: 0,
    width: 390,
    height: 844,
    htmlContent,
    ...extra,
  } as unknown as FlatSceneNode;
  const state = useSceneStore.getState();
  useSceneStore.setState({
    nodesById: { ...state.nodesById, [id]: node },
    parentById: { ...state.parentById, [id]: null },
    rootIds: [...state.rootIds, id],
    _cachedTree: null,
  });
}

const html = (id: string) => useSceneStore.getState().nodesById[id] as unknown as { htmlContent: string };

describe("editEmbedHtml", () => {
  beforeEach(() => resetStores());

  it("applies a unique edit and reports it", async () => {
    seedEmbed("e1", '<button class="cta">Buy</button>');
    const result = JSON.parse(await editEmbedHtml({
      nodeId: "e1",
      edits: [{ oldString: ">Buy<", newString: ">Get started<" }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.editsApplied).toBe(1);
    expect(result.replacements).toBe(1);
    expect(html("e1").htmlContent).toBe('<button class="cta">Get started</button>');
  });

  it("leaves the store untouched when the anchor is ambiguous", async () => {
    seedEmbed("e1", "<i></i><i></i>");
    const result = JSON.parse(await editEmbedHtml({
      nodeId: "e1",
      edits: [{ oldString: "<i>", newString: "<b>" }],
    }));
    expect(result.error).toMatch(/occurs 2 times/);
    expect(html("e1").htmlContent).toBe("<i></i><i></i>");
  });

  it("reports a missing anchor and points at grep", async () => {
    seedEmbed("e1", "<p>hi</p>");
    const result = JSON.parse(await editEmbedHtml({
      nodeId: "e1",
      edits: [{ oldString: "nope", newString: "x" }],
    }));
    expect(result.error).toMatch(/read_embed_html/);
    expect(html("e1").htmlContent).toBe("<p>hi</p>");
  });

  it("replaces every occurrence with replaceAll", async () => {
    seedEmbed("e1", "#111 and #111");
    const result = JSON.parse(await editEmbedHtml({
      nodeId: "e1",
      edits: [{ oldString: "#111", newString: "#222", replaceAll: true }],
    }));
    expect(result.replacements).toBe(2);
    expect(html("e1").htmlContent).toBe("#222 and #222");
  });

  it("is atomic: a failing second edit rolls back the first", async () => {
    seedEmbed("e1", "a-b");
    await editEmbedHtml({
      nodeId: "e1",
      edits: [
        { oldString: "a", newString: "x" },
        { oldString: "zzz", newString: "y" },
      ],
    });
    expect(html("e1").htmlContent).toBe("a-b");
  });

  it("edits sourceTemplate rather than the expanded htmlContent", async () => {
    seedEmbed("e1", "<div>EXPANDED</div>", { sourceTemplate: "<div>TEMPLATE</div>" });
    const result = JSON.parse(await editEmbedHtml({
      nodeId: "e1",
      edits: [{ oldString: "TEMPLATE", newString: "EDITED" }],
    }));
    expect(result.targetedSourceTemplate).toBe(true);
    // No document components exist in this scene, so nothing expands and the
    // edited template becomes the stored html; the stale template is dropped.
    expect(html("e1").htmlContent).toBe("<div>EDITED</div>");
  });

  it("rejects a non-embed node with an actionable message", async () => {
    const state = useSceneStore.getState();
    useSceneStore.setState({
      nodesById: {
        ...state.nodesById,
        r1: { id: "r1", type: "rect", name: "Box", x: 0, y: 0, width: 10, height: 10 } as unknown as FlatSceneNode,
      },
      rootIds: [...state.rootIds, "r1"],
    });
    const result = JSON.parse(await editEmbedHtml({ nodeId: "r1", edits: [{ oldString: "a", newString: "b" }] }));
    expect(result.error).toMatch(/not an embed/);
  });

  it("rejects an unknown node", async () => {
    const result = JSON.parse(await editEmbedHtml({ nodeId: "ghost", edits: [{ oldString: "a", newString: "b" }] }));
    expect(result.error).toMatch(/not found/);
  });

  it("rejects an empty edits list", async () => {
    seedEmbed("e1", "<p>hi</p>");
    const result = JSON.parse(await editEmbedHtml({ nodeId: "e1", edits: [] }));
    expect(result.error).toMatch(/No edits/);
  });

  it("records exactly one undo entry", async () => {
    seedEmbed("e1", "<p>a</p>");
    const before = useHistoryStore.getState().past.length;
    await editEmbedHtml({ nodeId: "e1", edits: [{ oldString: "a", newString: "b" }] });
    expect(useHistoryStore.getState().past.length).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/tools/__tests__/editEmbedHtml.test.ts`
Expected: FAIL — модуль `../editEmbedHtml` не найден.

- [ ] **Step 3: Реализовать хендлер**

```ts
import { useSceneStore } from "@/store/sceneStore";
import { saveHistory } from "@/store/sceneStore/helpers/history";
import {
  collectDocumentComponents,
  buildDocumentComponentTagMap,
} from "@/lib/documentComponents";
import {
  normalizeEmbedHtmlForStorage,
  propagateComponentChanges,
} from "@/utils/embedTemplateUtils";
import { applyAnchorEdits, type AnchorEdit } from "@/lib/embedHtmlEdit/applyAnchorEdits";
import type { EmbedNode, FlatSceneNode } from "@/types/scene";
import type { ToolHandler } from "../toolRegistry";

/** Coerce the tool args into AnchorEdit[], or null when unusable. */
function parseEdits(raw: unknown): AnchorEdit[] | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const edits: AnchorEdit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { oldString, newString, replaceAll } = item as Record<string, unknown>;
    if (typeof oldString !== "string" || typeof newString !== "string") return null;
    edits.push({
      oldString,
      newString,
      ...(replaceAll === true ? { replaceAll: true } : {}),
    });
  }
  return edits;
}

export const editEmbedHtml: ToolHandler = async (args) => {
  const nodeId = typeof args.nodeId === "string" ? args.nodeId : "";
  if (!nodeId) return JSON.stringify({ error: "nodeId is required" });

  const edits = parseEdits(args.edits);
  if (!edits) return JSON.stringify({ error: "edits must be an array of {oldString, newString}" });
  if (edits.length === 0) return JSON.stringify({ error: "No edits provided" });

  const state = useSceneStore.getState();
  const node = state.nodesById[nodeId];
  if (!node) return JSON.stringify({ error: `Node ${nodeId} not found` });
  if (node.type !== "embed") {
    return JSON.stringify({
      error: `Node ${nodeId} is a "${node.type}" node, not an embed. edit_embed_html only edits embed screens.`,
    });
  }

  const embed = node as unknown as EmbedNode;
  // The authoring text is sourceTemplate when it exists — htmlContent is its
  // expanded form and would be overwritten on the next expansion.
  const targetedSourceTemplate =
    typeof embed.sourceTemplate === "string" && embed.sourceTemplate.length > 0;
  const source = targetedSourceTemplate ? (embed.sourceTemplate as string) : embed.htmlContent;

  let edited;
  try {
    edited = applyAnchorEdits(source, edits);
  } catch (err) {
    // Nothing was written to the store — the failure is fully atomic.
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }

  const docComponents = collectDocumentComponents(
    state.nodesById,
    state.componentArtifactsById,
    state.childrenById,
  );
  const tagMap = buildDocumentComponentTagMap(docComponents);
  const { htmlContent, sourceTemplate, issues } = normalizeEmbedHtmlForStorage(edited.html, tagMap);

  const updated = { ...embed, htmlContent } as EmbedNode;
  if (sourceTemplate) {
    updated.sourceTemplate = sourceTemplate;
  } else {
    // No component tags left — htmlContent IS the authoring text now, so a
    // leftover template would silently resurrect the pre-edit markup.
    delete updated.sourceTemplate;
  }

  const newNodesById: Record<string, FlatSceneNode> = {
    ...state.nodesById,
    [nodeId]: updated as unknown as FlatSceneNode,
  };

  // Editing an embed that is itself a document component must re-expand its dependents.
  if (docComponents.some((comp) => comp.id === nodeId)) {
    propagateComponentChanges(newNodesById);
  }

  saveHistory(state);
  useSceneStore.setState({ nodesById: newNodesById, _cachedTree: null });

  return JSON.stringify({
    nodeId,
    editsApplied: edits.length,
    replacements: edited.replacements,
    htmlLength: htmlContent.length,
    targetedSourceTemplate,
    issues,
  });
};
```

- [ ] **Step 4: Зарегистрировать в `toolRegistry.ts`**

Добавить импорт рядом с остальными:

```ts
import { editEmbedHtml } from "./tools/editEmbedHtml";
```

и запись в объект `toolHandlers`:

```ts
  edit_embed_html: editEmbedHtml,
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/tools/__tests__/editEmbedHtml.test.ts`
Expected: PASS, 10 тестов.

- [ ] **Step 6: Коммит**

```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor
git add src/lib/tools/editEmbedHtml.ts src/lib/tools/__tests__/editEmbedHtml.test.ts src/lib/toolRegistry.ts
git commit -m "feat: add edit_embed_html handler"
```

---

### Task 5: Outline и grep (чистый модуль, фронтенд)

**Files:**
- Create: `pen-editor/src/lib/embedHtmlEdit/readViews.ts`
- Test: `pen-editor/src/lib/embedHtmlEdit/__tests__/readViews.test.ts`

**Interfaces:**
- Consumes: `DOMParser` (есть и в браузере, и в happy-dom).
- Produces:
  ```ts
  export function buildOutline(html: string, maxDepth?: number, maxTextChars?: number): string
  export function grepHtml(html: string, pattern: string, contextLines?: number):
    { matches: number; blocks: string[] }
  ```

**Замечание про кавычки:** outline пересобирает открывающие теги из распарсенного DOM, поэтому значения атрибутов сохраняются дословно, а вот стиль кавычек нормализуется в двойные. Поэтому outline — инструмент *ориентирования*, а байт-точный якорь берётся из `grep`. Это должно быть написано прямо в шапке outline-вывода, иначе модель будет копировать якоря из outline и промахиваться.

- [ ] **Step 1: Написать падающие тесты**

```ts
import { describe, it, expect } from "vitest";
import { buildOutline, grepHtml } from "../readViews";

const SCREEN = `<html><head><style>.cta{color:#111}</style></head>
<body><div class="screen"><header class="top">Checkout page title that is quite long</header>
<main><ul><li><span>Item</span></li></ul></main></div></body></html>`;

describe("buildOutline", () => {
  it("keeps tags and attributes verbatim", () => {
    const outline = buildOutline(SCREEN, 6);
    expect(outline).toContain('<header class="top">');
    expect(outline).toContain('<div class="screen">');
  });

  it("truncates long text nodes", () => {
    const outline = buildOutline(SCREEN, 6, 10);
    expect(outline).toContain("Checkout p…");
    expect(outline).not.toContain("quite long");
  });

  it("summarizes subtrees deeper than maxDepth instead of dropping them", () => {
    const outline = buildOutline(SCREEN, 2);
    expect(outline).toMatch(/nodes omitted/);
    expect(outline).not.toContain("<span>");
  });

  it("elides style and script bodies", () => {
    const outline = buildOutline(SCREEN, 6);
    expect(outline).not.toContain("color:#111");
    expect(outline).toMatch(/<style>[\s\S]*chars omitted/);
  });

  it("warns that quoting is normalized", () => {
    expect(buildOutline(SCREEN)).toContain("grep");
  });

  it("is substantially shorter than the input", () => {
    expect(buildOutline(SCREEN).length).toBeLessThan(SCREEN.length);
  });
});

describe("grepHtml", () => {
  it("returns matching lines with context and a count", () => {
    const html = "line1\nline2 needle\nline3\nline4\nline5 needle";
    const result = grepHtml(html, "needle", 1);
    expect(result.matches).toBe(2);
    expect(result.blocks.join("\n")).toContain("2: line2 needle");
    expect(result.blocks.join("\n")).toContain("1: line1");
  });

  it("merges overlapping context windows into one block", () => {
    const html = "a needle\nb\nc needle";
    const result = grepHtml(html, "needle", 2);
    expect(result.matches).toBe(2);
    expect(result.blocks).toHaveLength(1);
  });

  it("treats the pattern literally, not as a regex", () => {
    const result = grepHtml("price: $1.00", "$1", 0);
    expect(result.matches).toBe(1);
  });

  it("returns zero matches without throwing", () => {
    expect(grepHtml("<p>hi</p>", "zzz", 2)).toEqual({ matches: 0, blocks: [] });
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/embedHtmlEdit/__tests__/readViews.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать модуль**

```ts
/**
 * Partial read views over an embed's HTML, so the model can locate a fragment
 * without pulling the whole document into context.
 */

const OUTLINE_HEADER =
  "<!-- outline: attribute values are verbatim, but quoting is normalized to double quotes " +
  'and text is truncated. For a byte-exact anchor use read_embed_html mode "grep". -->';

const ELIDED_TAGS = new Set(["style", "script"]);

function openingTag(el: Element): string {
  const attrs = Array.from(el.attributes)
    .map((attr) => ` ${attr.name}="${attr.value}"`)
    .join("");
  return `<${el.tagName.toLowerCase()}${attrs}>`;
}

function countDescendants(el: Element): number {
  return el.getElementsByTagName("*").length;
}

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

function outlineElement(
  el: Element,
  depth: number,
  maxDepth: number,
  maxTextChars: number,
  out: string[],
): void {
  const indent = "  ".repeat(depth);
  const tag = el.tagName.toLowerCase();

  if (ELIDED_TAGS.has(tag)) {
    out.push(`${indent}${openingTag(el)} /* ${el.textContent?.length ?? 0} chars omitted */ </${tag}>`);
    return;
  }

  const children = Array.from(el.children);

  if (children.length === 0) {
    const text = truncate(el.textContent ?? "", maxTextChars);
    out.push(`${indent}${openingTag(el)}${text}</${tag}>`);
    return;
  }

  if (depth >= maxDepth) {
    out.push(`${indent}${openingTag(el)} <!-- ${countDescendants(el)} nodes omitted --> </${tag}>`);
    return;
  }

  // Direct text of a container (before its first element child) still matters
  // for locating copy, so keep a truncated version of it.
  const ownText = truncate(
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 /* TEXT_NODE */)
      .map((n) => n.textContent ?? "")
      .join(" "),
    maxTextChars,
  );

  out.push(`${indent}${openingTag(el)}${ownText}`);
  for (const child of children) {
    outlineElement(child, depth + 1, maxDepth, maxTextChars, out);
  }
  out.push(`${indent}</${tag}>`);
}

export function buildOutline(html: string, maxDepth = 4, maxTextChars = 40): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [OUTLINE_HEADER];
  const root = doc.documentElement;
  if (root) outlineElement(root, 0, maxDepth, maxTextChars, out);
  return out.join("\n");
}

export function grepHtml(
  html: string,
  pattern: string,
  contextLines = 2,
): { matches: number; blocks: string[] } {
  const lines = html.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (line.includes(pattern)) hits.push(i);
  });
  if (hits.length === 0) return { matches: 0, blocks: [] };

  // Merge overlapping context windows so adjacent hits read as one block.
  const ranges: Array<[number, number]> = [];
  for (const hit of hits) {
    const start = Math.max(0, hit - contextLines);
    const end = Math.min(lines.length - 1, hit + contextLines);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const blocks = ranges.map(([start, end]) =>
    lines
      .slice(start, end + 1)
      .map((line, offset) => `${start + offset + 1}: ${line}`)
      .join("\n"),
  );

  return { matches: hits.length, blocks };
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/embedHtmlEdit/__tests__/readViews.test.ts`
Expected: PASS, 10 тестов.

- [ ] **Step 5: Коммит**

```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor
git add src/lib/embedHtmlEdit/readViews.ts src/lib/embedHtmlEdit/__tests__/readViews.test.ts
git commit -m "feat: add outline and grep read views for embed HTML"
```

---

### Task 6: Хендлер `read_embed_html` и финальная проверка

**Files:**
- Create: `pen-editor/src/lib/tools/readEmbedHtml.ts`
- Modify: `pen-editor/src/lib/toolRegistry.ts`
- Test: `pen-editor/src/lib/tools/__tests__/readEmbedHtml.test.ts`

**Interfaces:**
- Consumes: `buildOutline`, `grepHtml` из Задачи 5.
- Produces: `export const readEmbedHtml: ToolHandler`, зарегистрированный как `read_embed_html`. Возвращает JSON-строку: `{ nodeId, mode, outline }` | `{ nodeId, mode, matches, blocks }` | `{ nodeId, mode, html, warning? }` | `{ error }`.

- [ ] **Step 1: Написать падающие тесты**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useSceneStore } from "@/store/sceneStore";
import { resetStores } from "@/test/fixtures";
import type { FlatSceneNode } from "@/types/scene";
import { readEmbedHtml } from "../readEmbedHtml";

function seedEmbed(id: string, htmlContent: string, extra: Record<string, unknown> = {}) {
  const node = {
    id, type: "embed", name: "Screen", x: 0, y: 0, width: 390, height: 844, htmlContent, ...extra,
  } as unknown as FlatSceneNode;
  const state = useSceneStore.getState();
  useSceneStore.setState({
    nodesById: { ...state.nodesById, [id]: node },
    parentById: { ...state.parentById, [id]: null },
    rootIds: [...state.rootIds, id],
    _cachedTree: null,
  });
}

describe("readEmbedHtml", () => {
  beforeEach(() => resetStores());

  it("defaults to outline mode", async () => {
    seedEmbed("e1", '<div class="screen"><p>Hello</p></div>');
    const result = JSON.parse(await readEmbedHtml({ nodeId: "e1" }));
    expect(result.mode).toBe("outline");
    expect(result.outline).toContain('<div class="screen">');
  });

  it("greps with context and reports the match count", async () => {
    seedEmbed("e1", "a\n<button>Buy</button>\nb");
    const result = JSON.parse(await readEmbedHtml({ nodeId: "e1", mode: "grep", pattern: "Buy" }));
    expect(result.matches).toBe(1);
    expect(result.blocks.join("\n")).toContain("<button>Buy</button>");
  });

  it("errors when grep is called without a pattern", async () => {
    seedEmbed("e1", "<p>x</p>");
    const result = JSON.parse(await readEmbedHtml({ nodeId: "e1", mode: "grep" }));
    expect(result.error).toMatch(/pattern/);
  });

  it("returns the whole document in full mode", async () => {
    seedEmbed("e1", "<p>x</p>");
    const result = JSON.parse(await readEmbedHtml({ nodeId: "e1", mode: "full" }));
    expect(result.html).toBe("<p>x</p>");
  });

  it("warns on very large documents in full mode", async () => {
    seedEmbed("e1", `<p>${"x".repeat(20001)}</p>`);
    const result = JSON.parse(await readEmbedHtml({ nodeId: "e1", mode: "full" }));
    expect(result.warning).toMatch(/grep/);
  });

  it("reads sourceTemplate when present, since that is what edits target", async () => {
    seedEmbed("e1", "<div>EXPANDED</div>", { sourceTemplate: "<div>TEMPLATE</div>" });
    const result = JSON.parse(await readEmbedHtml({ nodeId: "e1", mode: "full" }));
    expect(result.html).toBe("<div>TEMPLATE</div>");
    expect(result.targetedSourceTemplate).toBe(true);
  });

  it("rejects a non-embed node", async () => {
    const state = useSceneStore.getState();
    useSceneStore.setState({
      nodesById: {
        ...state.nodesById,
        r1: { id: "r1", type: "rect", name: "Box", x: 0, y: 0, width: 1, height: 1 } as unknown as FlatSceneNode,
      },
      rootIds: [...state.rootIds, "r1"],
    });
    const result = JSON.parse(await readEmbedHtml({ nodeId: "r1" }));
    expect(result.error).toMatch(/not an embed/);
  });

  it("rejects an unknown node", async () => {
    const result = JSON.parse(await readEmbedHtml({ nodeId: "ghost" }));
    expect(result.error).toMatch(/not found/);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/tools/__tests__/readEmbedHtml.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать хендлер**

```ts
import { useSceneStore } from "@/store/sceneStore";
import { buildOutline, grepHtml } from "@/lib/embedHtmlEdit/readViews";
import type { EmbedNode } from "@/types/scene";
import type { ToolHandler } from "../toolRegistry";

const FULL_WARN_THRESHOLD = 20_000;

function intArg(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export const readEmbedHtml: ToolHandler = async (args) => {
  const nodeId = typeof args.nodeId === "string" ? args.nodeId : "";
  if (!nodeId) return JSON.stringify({ error: "nodeId is required" });

  const node = useSceneStore.getState().nodesById[nodeId];
  if (!node) return JSON.stringify({ error: `Node ${nodeId} not found` });
  if (node.type !== "embed") {
    return JSON.stringify({
      error: `Node ${nodeId} is a "${node.type}" node, not an embed. read_embed_html only reads embed screens.`,
    });
  }

  const embed = node as unknown as EmbedNode;
  // Read what edit_embed_html will write to, so anchors copied from here match.
  const targetedSourceTemplate =
    typeof embed.sourceTemplate === "string" && embed.sourceTemplate.length > 0;
  const html = targetedSourceTemplate ? (embed.sourceTemplate as string) : embed.htmlContent;

  const mode = args.mode === "grep" || args.mode === "full" ? args.mode : "outline";

  if (mode === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (pattern.length === 0) {
      return JSON.stringify({ error: "pattern is required when mode is 'grep'" });
    }
    const { matches, blocks } = grepHtml(html, pattern, intArg(args.contextLines, 2, 0, 20));
    return JSON.stringify({ nodeId, mode, targetedSourceTemplate, matches, blocks });
  }

  if (mode === "full") {
    return JSON.stringify({
      nodeId,
      mode,
      targetedSourceTemplate,
      html,
      ...(html.length > FULL_WARN_THRESHOLD
        ? {
            warning:
              `This document is ${html.length} characters. Prefer mode "outline" or "grep" — ` +
              "reading a whole screen to change part of it wastes most of the tokens.",
          }
        : {}),
    });
  }

  return JSON.stringify({
    nodeId,
    mode,
    targetedSourceTemplate,
    outline: buildOutline(html, intArg(args.maxDepth, 4, 1, 12)),
  });
};
```

- [ ] **Step 4: Зарегистрировать в `toolRegistry.ts`**

```ts
import { readEmbedHtml } from "./tools/readEmbedHtml";
```

и в объект `toolHandlers`:

```ts
  read_embed_html: readEmbedHtml,
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor && npx vitest run src/lib/tools/__tests__/readEmbedHtml.test.ts`
Expected: PASS, 8 тестов.

- [ ] **Step 6: Проверить контракт имён и весь фронтенд целиком**

Run:
```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor
npx vitest run src/lib/__tests__/toolContract.test.ts
npx vitest run
npm run lint
npm run build
```
Expected: всё зелёное. `toolContract.test.ts` читает `tools.ts` соседнего бэкенд-репозитория — если он падает, значит Задачи 1–2 ещё не в `main` бэкенда либо имя разъехалось.

Внимание: **не** запускай `npm test -- run` — `run` будет понят как фильтр имён файлов и прогонит пару файлов, выглядя зелёным.

- [ ] **Step 7: Коммит и пуш фронтенда**

```bash
cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor
git add src/lib/tools/readEmbedHtml.ts src/lib/tools/__tests__/readEmbedHtml.test.ts src/lib/toolRegistry.ts
git commit -m "feat: add read_embed_html handler"
git push origin main
```

---

## Проверка результата вживую (после мержа обеих половин)

Не входит в TDD-цикл, но без этого нельзя утверждать, что фича работает:

1. Запустить фронтенд (`npm run dev`) и бэкенд (`npm run dev`), открыть `/app`.
2. Через `/prototype` попросить агента сделать один экран.
3. Затем попросить: «поменяй цвет главной кнопки на тёмно-зелёный».
4. Ожидаемо в трейсе: вызов `read_embed_html` (`outline` или `grep`), затем `edit_embed_html` — и **ни одного** `batch_design` с `U(id, {htmlContent})`. Экран перерисовался, остальная вёрстка не поехала.
5. Ctrl/Cmd+Z возвращает предыдущий вид одним шагом.
