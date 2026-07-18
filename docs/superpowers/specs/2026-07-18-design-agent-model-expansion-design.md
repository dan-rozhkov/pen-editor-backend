# Design-agent model expansion

## Goal

Add seven OpenRouter models to the design agent's built-in model picker and request allowlist. Keep the online model list and the frontend's offline fallback aligned.

## Model metadata

Append these entries in the order requested:

| Model ID | Label | Vision |
| --- | --- | --- |
| `tencent/hy3` | `Hy3` | No |
| `nvidia/nemotron-3-ultra-550b-a55b` | `Nemotron 3 Ultra` | No |
| `stepfun/step-3.7-flash` | `Step 3.7 Flash` | Yes |
| `x-ai/grok-build-0.1` | `Grok Build 0.1` | Yes |
| `thinkingmachines/inkling` | `Inkling` | Yes |
| `kwaipilot/kat-coder-pro-v2.5` | `KAT-Coder-Pro V2.5` | No |
| `x-ai/grok-4.20` | `Grok 4.20` | No |

The `supportsVision` value controls image attachment and image-part forwarding. OpenRouter lists Step 3.7 Flash and Grok Build 0.1 as image-input models. Thinking Machines documents Inkling as multimodal. The remaining four entries use text-only behavior.

## Implementation

The backend remains the source of truth. Add the seven `ModelOption` entries to `DEFAULT_MODELS` in `pen-editor-backend/src/config.ts`. This makes the models available through `GET /api/models` and permits clients to select them in `POST /api/chat`.

Mirror the same entries in `pen-editor/src/lib/chatModels.ts` under `FALLBACK_MODELS`. Users will then see the same choices during first paint and when `/api/models` is unavailable.

Do not change the default model, model ordering above the new entries, environment-variable behavior, or provider request construction.

## Testing

Extend the backend allowlist test so its expected IDs include all seven additions in order. Run that focused test before and after the production change to prove the new expectation fails and then passes.

Extend the existing frontend offline-fallback test so its expected IDs include all seven additions in the same order. This test reads the public `getModelOptions()` API and needs no test-only export.

Run backend tests, lint, and build. Run the focused frontend model test, lint, and build because the change crosses both repositories.

## Error handling

The existing model validation and `/api/models` response path handle the new entries without new branches. Text-only models keep the current image stripping behavior through `supportsVision: false`.

## Out of scope

- Changing `OPENROUTER_MODEL` or the `Auto` selection target
- Adding per-model reasoning controls
- Testing live OpenRouter inference or provider availability
- Reordering or removing existing models
