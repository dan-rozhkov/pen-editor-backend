---
name: plugin
description: Write, install, or update a generative plugin — small AI-authored JavaScript that runs inside the editor and can call editor tools (e.g. "make me a plugin that renames my layers sequentially", "build a tool that...", "add a button that..."). Load this before calling create_plugin or update_plugin for the full pen.* API, rules, and examples.
args:
  - name: request
    description: What the plugin should do (optional — the user's message usually already says this)
    required: false
---

# Writing pen-editor plugins

A plugin is JavaScript you author and install with `create_plugin` (or amend
with `update_plugin`). It runs later, on demand, inside a sandboxed iframe in
the user's browser — as a command-palette entry or a plugins-panel run
button — not as part of this chat turn. Your job here is to write correct,
self-contained `code`, not to run it yourself.

## How it runs

- `code` is executed as `<script type="module">` inside an iframe with
  `sandbox="allow-scripts"` (no `allow-same-origin`): the iframe has a null
  origin, so it has **no access to the app's DOM, localStorage, or
  IndexedDB** — the only channel in or out is the `pen.*` API below, which is
  an RPC bridge to the host.
- **Everything in `pen.*` is async** — every call returns a Promise (30s
  RPC timeout). Always `await` it or `.then()`/`.catch()`.
- Only one instance of a given plugin runs at a time — starting it again
  (or the user re-running it) stops the previous instance first.
- `ui` (passed to `create_plugin`/`update_plugin`) declares the initial panel
  size for a plugin with a visible interface. A `ui` plugin opens in a
  draggable, resizable floating panel (titlebar with the plugin's icon, name
  and a close button; closing it stops the instance). The plugin's DOM in
  `document.body` fills the panel. `pen.ui.resize(w, h)` resizes the panel
  from inside (clamped to sane min/max). Omit `ui` (or pass `null`) for
  headless plugins — they run invisibly and should `pen.close()` when done.
- Theme: the host injects the editor's theme tokens as CSS custom properties
  plus a `data-theme` attribute on the iframe's `<html>`, and pushes updates
  live when the user switches light/dark. UI plugins should use them instead
  of hardcoding colors: `--color-surface-panel`, `--color-surface-elevated`,
  `--color-border-default`, `--color-text-primary`, `--color-text-secondary`,
  `--color-text-muted`, `--color-accent-primary` (and more of the same
  family) — e.g. `body { background: var(--color-surface-panel); color:
  var(--color-text-primary); }`.
- A base stylesheet with editor-matching primitives is already loaded in
  every plugin iframe (`.pen-button`, `.pen-input`, `.pen-card`, `.pen-tabs`,
  `.pen-table`, ... — see "UI-kit classes" below). It covers every app
  primitive that a static sandboxed iframe (no framework, no popovers/portals)
  can faithfully reproduce — controls, containers (card, alert, table,
  field), and text helpers (heading, muted, kbd, link). **For standard
  controls, use the `.pen-*` classes instead of hand-rolled CSS** — they
  match the editor's look and follow theme switches automatically.
- While the editor's Dev/Inspect Mode is active the scene is read-only:
  mutating `pen.tools.run`/`pen.scene.batch` calls reject with an error
  (read-only tools like `batch_get`/`get_editor_state` still work). Handle
  the rejection gracefully
  are present.

## The `pen.*` API (v1)

```js
// Run any allowlisted editor tool by name, get back its result string.
await pen.tools.run(name, args); // -> Promise<string>

// Scene mutation — shorthand for pen.tools.run("batch_design", {operations}).
// `operations` is the batch_design DSL string; cap 25 operations per call
// (going over isn't fatal — the first 25 run and the result reports
// truncated: true; see the cap note under Rules).
await pen.scene.batch(operations); // -> Promise<string>

// Read the scene. No ids -> get_editor_state; with ids -> batch_get({ nodeIds: ids }).
// Resolves to a JSON string — JSON.parse() it if you need structured data.
await pen.scene.get();            // -> Promise<string>
await pen.scene.get(["id1", "id2"]); // -> Promise<string>

// Selection.
await pen.selection.get();        // -> Promise<string[]>
await pen.selection.set(ids);     // -> Promise<string[]> (ids actually applied; unknown ids are dropped)

// Frame the viewport on a set of nodes.
await pen.viewport.zoomTo(ids);   // -> Promise<null>, throws if none of ids resolve

// Toast a message to the user. Fire-and-forget (no need to await).
pen.notify("Renamed 12 layers.");

// Small per-plugin key/value storage (JSON-serializable values only).
await pen.storage.get("count");        // -> Promise<unknown | null>
await pen.storage.set("count", 3);     // -> Promise<null>

// Subscribe to host events. v1 only fires "selectionchange", payload = string[] of selected ids.
pen.on("selectionchange", (ids) => { /* ... */ });

// Tear down this plugin's iframe. Fire-and-forget.
pen.close();
```

### Allowed tools for `pen.tools.run`

Only the tool names listed below are allowed (calling anything else rejects
the Promise). Use `pen.scene.batch`/`pen.scene.get` for `batch_design`/reads
instead of calling `pen.tools.run` with those names directly — they're
equivalent, but the shorthands are less to type and less to get wrong.
(Comments, `get_screenshot`, the backend-only guideline tools, and
`generate_frame_image` are intentionally not available to plugins.)

#### Allowlist

This list must be kept identical (as a set) to
`pen-editor/src/lib/plugins/toolAllowlist.ts`'s `PLUGIN_ALLOWED_TOOLS` —
`pen-editor/src/lib/__tests__/toolContract.test.ts` parses the backticked
names directly out of this section and fails if the two drift.

- `batch_design`
- `batch_get`
- `get_editor_state`
- `snapshot_layout`
- `get_variables`
- `set_variables`
- `get_text_styles`
- `set_text_styles`
- `apply_text_style`
- `get_styles`
- `set_styles`
- `apply_fill_style`
- `apply_effect_style`
- `replace_all_matching_properties`
- `search_all_unique_properties`
- `find_empty_space_on_canvas`
- `rename_layers`
- `boolean_operation`
- `set_export_settings`
- `generate_image`

Every `pen.tools.run`/`pen.scene.*` call goes through the exact same
`batch_design` DSL and cap (25 operations per call) that you use directly in
chat — see that tool's own description for the DSL syntax if you need a
refresher.

### Error handling

A rejected `pen.*` Promise carries a plain `Error` with a host-side message
(e.g. an unknown/disallowed tool name, a bad argument, no matching node for
`viewport.zoomTo`). Wrap calls in `try`/`catch` when the plugin should keep
running (e.g. notify the user and continue) rather than let an unhandled
rejection silently stop it.

## Rules

1. **Everything async, always await.** Don't assume a `pen.*` call resolves synchronously.
2. **Mutate the scene only through `pen.scene.batch`/`pen.tools.run`.** There is no other way to touch the document from inside the sandbox — direct DOM/canvas access to the host app is impossible by design.
3. **Respect the 25-operations-per-`batch_design`-call cap.** Split larger mutations into sequential `pen.scene.batch` calls (with `await` between them so operations don't race). Going over isn't fatal — the first 25 operations still run and the result reports `truncated: true` — but you must then continue with only the operations that didn't run, not repeat ones that already did.
4. **Code size limit: 100 KB.** `create_plugin`/`update_plugin` reject larger `code`.
5. **UI plugins render their own DOM inside their iframe** (`document.body`, plain DOM/CSS — no framework is bundled for you), styled with the injected theme variables.
6. **Iterate via `list_plugins` → `update_plugin`.** Don't `create_plugin` a near-duplicate when the user is asking for a change to an existing plugin — call `list_plugins` to find its id, then `update_plugin` with just the changed fields.
7. Keep `name`/`description` short and user-facing — they're shown verbatim in the command palette and plugin manager.

## UI-kit classes

Every plugin iframe already loads a stylesheet with these classes, styled
from the theme tokens above so they match `src/components/ui/` and re-theme
live. Use them for standard controls instead of writing your own CSS:

- `.pen-button` — default (secondary-looking) button
- `.pen-button-primary` — high-emphasis button (the app's primary button color, not the accent blue), add alongside `.pen-button` for the main/confirm action
- `.pen-icon-button` — square 28×28 icon-only button, add alongside `.pen-button`
- `.pen-input` — single-line text input
- `.pen-textarea` — multi-line text input
- `.pen-select` — native `<select>`
- `.pen-label` — form field label
- `.pen-checkbox` — native checkbox (`<input type="checkbox">`)
- `.pen-slider` — native range input (`<input type="range">`), accent-colored
- `.pen-tabs` — tab strip container; hold `.pen-tab` children
- `.pen-tab` — a single tab; add `aria-selected="true"` on the active one
- `.pen-button-group` — joins adjacent `.pen-button`s into one row (shared borders, outer corners only rounded)
- `.pen-input-group` — bordered row combining `.pen-input` with a leading/trailing addon (icon, button, text)
- `.pen-row` — horizontal flex layout with gap, for inline groups of controls
- `.pen-stack` — vertical flex layout with gap, for stacked form fields
- `.pen-badge` — small pill label, for status/count tags
- `.pen-card` — bordered, elevated container with padding, for grouping related controls
- `.pen-field` — vertical group for one form field (label + control + help text)
- `.pen-alert` — bordered inline alert/notice banner
- `.pen-table` — data table (`<table>` with `.pen-table th`/`.pen-table td` cells)
- `.pen-separator` — 1px horizontal rule, for dividing sections
- `.pen-heading` — section heading text
- `.pen-muted` — secondary/de-emphasized text
- `.pen-help` — small help/description text under a field
- `.pen-kbd` — inline keycap, for showing a keyboard shortcut
- `.pen-link` — text link (underlines on hover)

## Examples

### 1. Headless: rename the selection sequentially

```js
const selected = await pen.selection.get();
if (selected.length === 0) {
  pen.notify("Select one or more layers first.");
  pen.close();
} else {
  const renames = selected.map((id, i) => ({ id, name: `Layer ${i + 1}` }));
  await pen.tools.run("rename_layers", { renames });
  pen.notify(`Renamed ${renames.length} layer(s).`);
  pen.close();
}
```

`create_plugin` call for this one: `name: "Sequential rename"`, `description:
"Renames the current selection Layer 1, Layer 2, ..."`, no `ui` (headless).

### 2. UI-declared: a small counter panel

```js
let count = (await pen.storage.get("count")) ?? 0;

document.body.innerHTML = `
  <div class="pen-stack">
    <div id="count" style="font-size:24px;"></div>
    <button id="inc" class="pen-button pen-button-primary">+1</button>
  </div>
`;

function render() {
  document.getElementById("count").textContent = String(count);
}
render();

document.getElementById("inc").addEventListener("click", async () => {
  count += 1;
  render();
  await pen.storage.set("count", count);
});
```

`create_plugin` call: `name: "Counter"`, `description: "A small persistent
counter."`, `ui: { width: 200, height: 120 }`. The panel opens at 200×120;
the `.pen-*` classes above already follow the editor's light/dark theme, so
there's no manual color CSS to write here.

### 3. UI-declared: a card-wrapped field with help text

```js
document.body.innerHTML = `
  <div class="pen-card">
    <div class="pen-field">
      <label class="pen-label" for="prefix">Layer prefix</label>
      <input id="prefix" class="pen-input" placeholder="e.g. icon/" />
      <div class="pen-help">Prepended to every selected layer's name.</div>
    </div>
  </div>
`;
```

Shows `.pen-card` grouping a `.pen-field` (label + input + `.pen-help`) —
the same nesting a settings panel would use, all still theme-following with
no hand-written colors.
