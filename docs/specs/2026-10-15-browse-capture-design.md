# browse_capture — copy the browser page onto the canvas as an embed

Date: 2026-10-15. Repos: browser-agent, pen-editor-backend, pen-editor-desktop, pen-editor.

## Goal

The agent copies the page that is open in the built-in browser (desktop tab or
Steel cloud browser) onto the canvas as one `embed` node with self-contained
HTML. The agent does this **only when the user asks for it directly**. There is
no user-facing button. "Convert to design" (`convertEmbedToDesign`) already
turns an embed into native nodes, so the embed is the single output format.

## Contract

### Controller command `capture` (browser-agent)

`BrowserController.capture(args)`, args `{ index?: number; snapshotId?: string }`.

- No args: the whole document at the current viewport width.
- `index` + `snapshotId` (from `browse_snapshot`): only that element, resolved
  through the `data-pen-snap="<snapshotId>:<index>"` stamp that SNAPSHOT_JS
  writes. `index` without `snapshotId` (or a stale id) is an error.

Success: `{ html: string, width: number, height: number, url: string, title: string }`.
`width`/`height` are CSS px of the captured box (document scroll size, or the
element's bounding box), rounded, height capped at 20000.
Error: the controller's usual `errorResult(...)` shape (`{ error }`).

`html` is a whole document (`<!doctype html><html><head>…</head><body>…</body></html>`):

- Styles, in document order, each in its own `<style>`:
  - `<link rel=stylesheet>` (any origin) → `<style>@import url("<absolute href>");</style>`.
    `<link>` does not survive `sanitizeEmbedHtml`, `@import` does, and the
    browser loads a cross-origin sheet through `@import` without CORS.
  - `<style>` elements → their text, with relative `url(...)` made absolute
    against the document base URL. If the text is empty but `sheet.cssRules`
    has rules (CSS-in-JS via `insertRule`), serialize `cssRules` instead.
  - `document.adoptedStyleSheets` → serialized `cssRules`.
- Body: a clone of the DOM with
  - `<script>`, `<noscript>`, `<template>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<base>` removed,
    every `on*` attribute removed, `javascript:` hrefs removed;
  - every `src`, `href`, `poster`, `srcset` (split per candidate, not on `,`
    — URLs with commas exist) made absolute;
  - lazy images resolved: `currentSrc` (or `data-src`/`data-lazy-src`) into
    `src`, `loading` attribute removed;
  - live form state frozen (`value`, `checked`, `selected` attributes);
  - `<canvas>` replaced by `<img src=toDataURL()>` (skipped on a tainted canvas);
  - open shadow roots flattened into the light DOM (best effort);
  - the controller's own overlays (cursor, marks, `data-pen-*` attributes) removed.
- Element capture: the element clone inside a wrapper `<div>` that carries the
  ancestors' inherited text style (color, font-family, font-size, line-height)
  and the nearest non-transparent ancestor background, at the element's width.
- `html` over 3_000_000 characters → error "Page is too large to capture (X MB, limit 3 MB)".

Assets keep absolute URLs (no upload to R2 in v1).

### Cloud browser (pen-editor-backend)

`capture` joins `COMMAND_NAMES` (`src/browser/cloudSessions.ts`), so
`POST /api/browser/cmd/capture` runs it on the Steel session.

### Desktop (pen-editor-desktop)

`window.penDesktop.browser.capture(args)` → IPC `browser:command` with
`command: "capture"` → `browserController.capture(args)`.

### Tool `browse_capture` (backend schema, frontend handler)

Args `{ index?: number; snapshotId?: string; x?: number; y?: number }`.
The frontend handler calls the bridge, creates one `embed` node
(`htmlContent` = html, size = width × height, name `Page — <title or host>`),
placed at `x`/`y` (pair only) or in empty space right of existing content
(`computeEmptySpace`), one undo step, scene write through `runSerialized`.
It returns to the model **only** `{ nodeId, width, height, url, title }` — never
the HTML.

## The gate: only on the user's direct request

- `BROWSE_MODE=agent` (prod default): `browse_agent` gets `capture?: boolean`.
  The main agent sets it only when the user directly asks to copy the page onto
  the canvas. The frontend passes `browseCapture: true` in the nested chat
  body. The backend adds `browse_capture` to the subagent tool set **only**
  when `browseCapture === true`; the frontend nested chat allows the tool only
  under the same flag. One capture per `browse_agent` call: a second call gets
  an error. `browse_agent`'s result gains `captured: { nodeId, width, height, url, title }`
  when a capture happened, so the main agent does not depend on the
  subagent's prose.
- `BROWSE_MODE=manual`: `browse_capture` is in the main turn's browse tool set
  (same `hasBrowser` gate as the other browse_* tools). Here the gate is the
  tool description only.

`browse_screenshot` with `placeOnCanvas` stays: it places a raster image. The
prompts separate the two: "screenshot / image of the page" → screenshot;
"copy / clone the page, editable" → capture.

## Out of scope (v1)

Asset upload to R2, cookie-banner removal, scroll pass for lazy content that
is not in the DOM yet, cross-origin iframe contents, a user-facing button.

## v2, steps 1–2 (2026-10-15): the controller inlines and rewrites the CSS

Live check of v1 showed two losses, both because the copy only carries
`@import url(...)` links and the editor mounts embeds in a shadow root:
rules keyed on `<html>`/`:root` never match (Wikipedia lost its sidebar),
and the copy pulls every sheet of the site (Linear: 65). Step 3 (fonts) is
out of scope here.

Pipeline (all in `@sideform/browser-agent`):

1. CAPTURE_JS returns the body HTML plus an ordered list of style sources
   instead of finished `<style>` strings: `{ kind: "link", href, media }`,
   `{ kind: "inline", text, baseUrl, media }`, `{ kind: "adopted", text, baseUrl }`.
   Shadow-root styles stay as in v1 (scoped by nesting, inline in the body).
2. The controller fetches every `link` (and every `@import` inside any
   source, recursively) through a new optional page-handle method
   `fetchText(url, { timeoutMs, maxBytes })`. The page's CORS does not apply
   there: desktop implements it with the browser partition's
   `session.fetch`, the Playwright adapter with `context.request`. Limits:
   8 s per file, 3 MB per file, 100 files, depth 4, 8 MB total, 6 in
   parallel, cycle guard. A sheet that fails to fetch (or a handle without
   `fetchText`) falls back to the v1 `@import url(...)`.
3. Every `url(...)` and `@import` string becomes absolute against the URL
   of the file it is written in (not the page URL). `@import` with media or
   `layer(...)` / `supports(...)` is inlined inside the matching
   `@media` / `@layer` / `@supports` block. A `<link media>` wraps its text
   in `@media`.
4. Root selectors. For every complex selector whose first compound names
   `html` or `:root`, the page reports whether `document.documentElement`
   matches that compound (pseudo-classes like `:hover` stripped first).
   Matches → the compound becomes `:is(:root,:host)` (`:root` matches in an
   iframe, `:host` in the editor's shadow mount). No match → that selector
   is dropped, and a rule left with no selectors is dropped.
5. Pruning. A style rule stays only if at least one of its selectors (with
   user-action and element pseudo-classes/elements stripped for the test)
   matches an element in the captured scope: the document, or in element
   mode `target.matches(s) || target.querySelector(s)`. A selector the page
   cannot parse is kept (conservative). `@media`, `@supports`, `@layer`,
   `@container` blocks are pruned recursively and dropped when empty.
   `@font-face`, `@keyframes`, `@property`, `@counter-style`, `@page` stay.
6. Each source becomes one `<style>` in the original order. The 3M-char
   cap on the whole document stays.

The capture command gets its own time budget (45 s) because it now does
network work; the editor's tool timeout (60 s desktop, 120 s cloud) is
above it.

Check: the live harness (`capture-live`, shadow mount) on Wikipedia,
Stripe, Linear, Vercel, GitHub, Airbnb, plus a pixel diff of copy vs
original screenshot and the copy size before/after.
