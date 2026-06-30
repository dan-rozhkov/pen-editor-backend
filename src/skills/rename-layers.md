---
name: rename-layers
description: Rename layers in the .pen document to logical, human-readable names based on each layer's role, content, and hierarchy.
args:
  - name: target
    description: Limit renaming to a specific frame, group, or area (optional)
    required: false
user-invokable: true
---

Give every layer a name that tells a reader what it is at a glance. Generic names
like `Frame 12`, `Rect`, `Group`, or `Text` make the layer tree unreadable — replace
them with names that describe the layer's role.

## 1. Read the layers first

You cannot name a layer well without knowing what it is.

1. Call `get_editor_state` to see the current selection and the top-level nodes.
2. Call `batch_get` (with enough `readDepth`) to read the candidate layers' `type`,
   text content, children, and structure. Inspect deeply enough to understand each
   layer's purpose — a frame's children often reveal what the frame *is*.

## 2. Choose the scope

- **If the user selected layers** (selection is non-empty): rename only the selected
  layers and their meaningful descendants.
- **Otherwise**: walk the whole document and rename every generic / unnamed layer.
- If a `target` was given, limit the pass to that subtree.

## 3. Decide the names

Name each layer for its **role and content**, not its shape:

- A text node reading "Sign in" → `Sign in button` (or `Sign in label`).
- A frame containing inputs and a submit button → `Login form`.
- A row of nav links → `Top navigation`.
- An image used as a hero background → `Hero image`.
- A repeated card → `Product card`.

Guidelines:

- Be concise (1–4 words) and human-readable. Match the casing already used in the
  document; if there is no convention, prefer plain sentence case (`Hero section`).
- Reflect what the layer *is for*, inferred from its text, children, and position.
- **Leave already-meaningful names unchanged** — only replace generic/auto names.
- Never invent content; base names on what the layers actually contain.

## 4. Apply the renames

Call `rename_layers` **once** with all the `{ id, name }` pairs you decided:

```
rename_layers({ renames: [
  { id: "<nodeId>", name: "Login form" },
  { id: "<nodeId>", name: "Email field" },
  { id: "<nodeId>", name: "Sign in button" }
]})
```

Batching every rename into a single call makes the whole pass one undo step. The tool
returns `{ renamed, skipped }` — `skipped` lists ids it could not rename (not found or
blank name); fix those and retry only if needed.

If the document is empty, or the scope is genuinely ambiguous (e.g. you cannot tell
what the layers are for), ask the user before renaming.
