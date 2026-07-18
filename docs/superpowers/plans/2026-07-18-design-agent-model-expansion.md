# Design-agent Model Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven OpenRouter models to the design agent's backend allowlist, API response, and frontend offline model picker.

**Architecture:** The backend `DEFAULT_MODELS` array remains the source of truth for `/api/models` and chat validation. The frontend mirrors its values in `FALLBACK_MODELS` for first paint and offline use; exact-list tests guard both arrays.

**Tech Stack:** TypeScript, Fastify, React, Vitest, OpenRouter

## Global Constraints

- Append the seven models without reordering or removing existing entries.
- Keep `OPENROUTER_MODEL`, the `Auto` target, environment overrides, and provider construction unchanged.
- Use `supportsVision: true` only for `stepfun/step-3.7-flash`, `x-ai/grok-build-0.1`, and `thinkingmachines/inkling` among the new entries.
- Do not add dependencies or live-provider tests.

---

### Task 1: Backend model catalog and allowlist

**Files:**
- Modify: `test/config.test.ts`
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: `DEFAULT_MODELS: ModelOption[]` and `getAllowedModels(config: Config): string[]`
- Produces: seven new built-in `ModelOption` entries returned by `getModels()` and accepted by the chat route

- [ ] **Step 1: Extend the exact-list test**

Append these IDs to the expected array in `uses the curated design-agent model list`:

```ts
      "tencent/hy3",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "stepfun/step-3.7-flash",
      "x-ai/grok-build-0.1",
      "thinkingmachines/inkling",
      "kwaipilot/kat-coder-pro-v2.5",
      "x-ai/grok-4.20",
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/config.test.ts`

Expected: FAIL in `uses the curated design-agent model list`; the received array lacks the seven new IDs.

- [ ] **Step 3: Add the backend model metadata**

Append these objects to `DEFAULT_MODELS`:

```ts
  { id: "tencent/hy3", label: "Hy3", supportsVision: false },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    label: "Nemotron 3 Ultra",
    supportsVision: false,
  },
  {
    id: "stepfun/step-3.7-flash",
    label: "Step 3.7 Flash",
    supportsVision: true,
  },
  {
    id: "x-ai/grok-build-0.1",
    label: "Grok Build 0.1",
    supportsVision: true,
  },
  {
    id: "thinkingmachines/inkling",
    label: "Inkling",
    supportsVision: true,
  },
  {
    id: "kwaipilot/kat-coder-pro-v2.5",
    label: "KAT-Coder-Pro V2.5",
    supportsVision: false,
  },
  {
    id: "x-ai/grok-4.20",
    label: "Grok 4.20",
    supportsVision: false,
  },
```

- [ ] **Step 4: Run the focused backend test and verify GREEN**

Run: `npm test -- test/config.test.ts`

Expected: PASS for all tests in `test/config.test.ts`.

- [ ] **Step 5: Commit the backend change**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(models): expand design-agent model catalog"
```

### Task 2: Frontend offline fallback

**Files:**
- Modify: `src/lib/__tests__/chatModels.test.ts`
- Modify: `src/lib/chatModels.ts`

**Interfaces:**
- Consumes: `getModelOptions(): ChatModelOption[]`
- Produces: offline and first-paint options that match the backend catalog

- [ ] **Step 1: Extend the offline-fallback exact-list test**

Append these values after `deepseek/deepseek-v4-pro` in `uses the curated model list as its offline fallback`:

```ts
      "tencent/hy3",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "stepfun/step-3.7-flash",
      "x-ai/grok-build-0.1",
      "thinkingmachines/inkling",
      "kwaipilot/kat-coder-pro-v2.5",
      "x-ai/grok-4.20",
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/lib/__tests__/chatModels.test.ts`

Expected: FAIL in the offline-fallback test; the received values lack the seven new model IDs.

- [ ] **Step 3: Add matching frontend options**

Append these objects to `FALLBACK_MODELS`:

```ts
  { value: "tencent/hy3", label: "Hy3", supportsVision: false },
  {
    value: "nvidia/nemotron-3-ultra-550b-a55b",
    label: "Nemotron 3 Ultra",
    supportsVision: false,
  },
  {
    value: "stepfun/step-3.7-flash",
    label: "Step 3.7 Flash",
    supportsVision: true,
  },
  {
    value: "x-ai/grok-build-0.1",
    label: "Grok Build 0.1",
    supportsVision: true,
  },
  {
    value: "thinkingmachines/inkling",
    label: "Inkling",
    supportsVision: true,
  },
  {
    value: "kwaipilot/kat-coder-pro-v2.5",
    label: "KAT-Coder-Pro V2.5",
    supportsVision: false,
  },
  {
    value: "x-ai/grok-4.20",
    label: "Grok 4.20",
    supportsVision: false,
  },
```

- [ ] **Step 4: Run the focused frontend test and verify GREEN**

Run: `npm test -- src/lib/__tests__/chatModels.test.ts`

Expected: PASS for all tests in `src/lib/__tests__/chatModels.test.ts`.

- [ ] **Step 5: Commit the frontend change**

```bash
git add src/lib/chatModels.ts src/lib/__tests__/chatModels.test.ts
git commit -m "feat(chat): expand fallback model catalog"
```

### Task 3: Cross-repository verification

**Files:**
- Verify: `pen-editor-backend/src/config.ts`
- Verify: `pen-editor/src/lib/chatModels.ts`

**Interfaces:**
- Consumes: both completed catalogs
- Produces: evidence that unit tests, lint, and production builds pass in both repositories

- [ ] **Step 1: Run backend verification**

Run from `pen-editor-backend`:

```bash
npm test
npm run lint
npm run build
```

Expected: all three commands exit with status 0.

- [ ] **Step 2: Run frontend verification**

Run from `pen-editor`:

```bash
npm test
npm run lint
npm run build
```

Expected: all three commands exit with status 0.

- [ ] **Step 3: Compare the new catalog entries**

Inspect both arrays and confirm the seven IDs, labels, order, and `supportsVision` flags match. Confirm `git diff --check` reports no whitespace errors in either repository.
