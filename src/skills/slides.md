---
name: slides
description: Build a multi-slide presentation deck — one embed per slide in a shared theme, laid out left-to-right. Load this when the user asks for a presentation, deck, slideshow, pitch deck, or "slides" (as opposed to a single-screen prototype).
---

## Agent Mode: slides

You are building a presentation DECK: a sequence of slides, each its own top-level `embed` node, sharing one visual theme. This mode is a sibling of `prototype` — reuse its taste rules (below), but slides have their own structural requirements that override `prototype`'s "exactly one embed" rule. Apply the quality floor from the `frontend-design` skill (Verify / Refuse / Calibration, also inlined in full in the `prototype` skill) to every slide.

### Structural rules (non-negotiable)
1. **One embed per slide.** Never put multiple slides' content inside a single embed's `htmlContent`. Each slide is its own `batch_design` `I(document, {type: "embed", ...})` operation.
2. **Slide size: 1024×768 (4:3) for every slide.** `width: 1024, height: 768` on every slide embed, no exceptions per-slide.
3. **Horizontal filmstrip layout.** Slides sit in one row, left to right, at the same `y`. Pick a gap (default `96`) and compute each slide's `x` as `x = index * (1024 + gap)` (index starting at 0), so slide 1 is at x=0, slide 2 at x=1120, slide 3 at x=2240, etc. Do not stack slides vertically or scatter them — the deck must read as a clean horizontal strip. If `find_empty_space_on_canvas` is available, use it once for the first slide's origin, then apply the same `x` formula and shared `y` from that origin for the rest.

### Mandatory flow
1. **Ask first (`ask_user`).** A deck is new content — before anything else, call `ask_user` with a short brief form (audience/occasion, topic scope, number of slides or length, tone/style, whether to reuse existing variables/fonts). Use `single`/`multi` chips with a "Decide for me" option so the user can delegate. Wait for the answers, then proceed. Skip this only if the user's message already pins down every one of these, **or if the USER PROFILE memory block (if present in this system prompt) already states a process preference for new-content work** (e.g. "skip ask_user and show a first draft directly") — that is a standing instruction from this same user and overrides this default step.
2. Call `get_editor_state` — note `documentComponents`/`reusableComponents` (for reuse across slides) and canvas `variables`. As in `prototype`, if a component embed already sets a font, that font becomes the deck's single family.
3. Call `get_guidelines` with `topic: "design-system"`.
3a. **Search for visual references before generating images or writing slide HTML (required when reference-search tools are available).** Load the `research` skill, run 1–2 focused queries, and inspect 3–4 strong deck/slide references. Extract their composition, type hierarchy, color system, image treatment, and one distinctive detail; use `web_search` / `fetch_url` as the fallback when dedicated reference tools are unavailable. If no search tool is available or every search call errors, continue without references rather than blocking the deck.
4. **Define the shared theme + master FIRST, before writing any slide.** Decide, once, for the whole deck:
   - A `:root{}` CSS custom-property block: accent color, neutral scale, and a type scale (display/heading/body/caption sizes + weights). Write this block once and paste the identical block into every slide's `<style>`.
   - A master layout: where the title sits on every slide (e.g. top-left, fixed padding), where the footer/page-number sits (e.g. bottom-right, "index / total"), and consistent outer margins. Every slide places its title, footer, and content within this same master grid — only the body content differs per slide.
   - Treat this as a contract: write the `:root{}` block and master spec down (in your own reasoning) before generating the first slide's HTML, then copy it unchanged into each subsequent slide. Do not let spacing, accent color, font, or footer position drift between slides — that reads as a broken deck, not a system.
5. Call `batch_design` to insert the slide embeds — one `I(document, {...})` operation per slide, using the `x` formula above. Batch multiple slides into one `batch_design` call when the operation count allows it (see that tool's max-operations limit); split into sequential calls for larger decks.
   - Give each embed a descriptive `name` (e.g. "Slide 1 — Title", "Slide 2 — Problem").
   - Every slide's `htmlContent` must include the same `:root{}` theme block, the same master layout skeleton (title position, footer/page-number position, margins), and content sized for exactly 1024×768.
   - Use document component tags (`<c-*>`) the same way `prototype` does, wherever a matching component exists.

### Deck content conventions
- Standard order for a generic deck (adapt to the user's actual content): title/cover, agenda or problem framing, 1-3 content slides, and a closing/CTA slide. If the user specifies exact slide content, follow that instead.
- Footer/page-number format: small, muted text like `3 / 8`, consistent position on every slide (skip it only on the title slide if that's the chosen master).
- Keep each slide focused on one idea — do not cram a slide's 1024×768 canvas with more content than it can hold at the type scale defined in the theme.

### Fit to canvas (1024×768, CRITICAL)
- **Hard rule:** every slide's content MUST fit inside its fixed 1024×768 canvas — no vertical cutoff, no horizontal scroll. Slides render as a fixed-size viewport with NO scrolling; content past the edge is simply lost, not scrollable.
- **CSS mechanics, baked into the shared theme block from the start:**
  - `*, *::before, *::after { box-sizing: border-box; }` at the top of every slide's `<style>`.
  - Directly after it, reset form controls: `button, input, select, textarea { font: inherit; color: inherit; background: none; border: 0; }`. A raw `<button>` left on browser defaults renders with a `2px outset` system bevel and an Arial label — glaring on a slide set in the deck's own family.
  - Root/body sized to exactly `width: 1024px; height: 768px;` (or `100%`), `margin: 0; overflow: hidden;`. Never rely on scrolling.
  - `padding` on the fixed-height root WITHOUT `border-box` is the classic cause of bottom cutoff — `border-box` keeps padding inside the 768px height instead of adding to it.
  - No child element wider than 1024px (e.g. no `width: 1100px` block inside a slide), and no unbroken long strings — apply `overflow-wrap: break-word` to copy-heavy elements so they can't push past the edge.
- **Content-density budget:** decide content BEFORE writing HTML. At the deck's type scale, a 1024×768 slide fits roughly a title plus 4-6 bullets, or 3-4 short sections/cards — not more. If the outline wants more than that for one slide, split it into two slides or tighten the copy. Do NOT shrink fonts below the theme's type scale or cut padding below the master layout's margins to squeeze extra content in.
- **Self-check before calling `batch_design`:** for each slide, sum the vertical blocks (title + margins + gaps + body rows) against 768px. If the sum is within ~10% of the limit, cut content — don't hope it fits.


### Taste rules (same as `prototype`, condensed — apply to every slide)
- **No device/OS chrome.** Slides are their own object; never draw a browser or device frame around a slide.
- **One font family for the whole deck**, loaded via `@import` at the top of each slide's `<style>` block (`<link>` is stripped on the canvas). Build hierarchy with weight/size/color, not extra families.
- **Icons: Phosphor** (`@import url('https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css');`, `<i class="ph ph-...">`). No emoji-as-icons, no hand-drawn inline SVG glyphs.
- **Real photos, not gradients — and generated, not stock.** After the reference-search step, any slide that calls for a photo gets one from `generate_image`: call it before writing the HTML with a prompt grounded in the reference findings and describing subject, framing, lighting, image treatment, and the deck's palette, then put the returned url into `<img src>` / `background-image`. Budget ~8 generations for the whole deck — at most one per slide, biggest images first — and reuse a url when the same subject repeats; past that budget, picsum. Micro imagery (avatars, tiny logos) and any generation that is unavailable, errors, or reports a spent budget falls back to `https://picsum.photos/seed/{unique}/{w}/{h}` — never a CSS gradient or empty box standing in for an image.
- **Max one accent color** for the whole deck, saturation < 80%, no neon/AI-purple. Neutral base (Zinc or Slate), off-black text (never pure `#000000`).
- **No JavaScript, no `<script>`, no inline event handlers, no CSS `transition`/`animation`/`@keyframes`/`filter`/`backdrop-filter`.**
- **Content realism:** creative real-sounding names/brands/numbers per `prototype`'s anti-slop rules — no "Jane Doe", no "Acme", no suspiciously round numbers.
- **Use canvas variables** (`var(--name)`) for any value that has a matching variable in canvas context, same priority as `prototype`.

### Pre-flight checklist (verify before calling batch_design)
1. Is every slide its OWN embed (never multiple slides in one `htmlContent`)?
2. Is every slide exactly 1024×768?
3. Do the slide `x` values follow the `index * (1024 + gap)` filmstrip formula at a shared `y`, left to right, with no overlap?
4. Is the identical `:root{}` theme block (accent, neutrals, type scale) present in every slide?
5. Is the master layout (title position, footer/page-number, margins) identical across slides — only body content differs?
6. Does every slide use the SAME single font family, loaded via `@import`?
7. Are Phosphor icons used consistently, with no emoji or hand-drawn SVG glyphs?
8. Does every photo spot carry a real image — a `generate_image` url for the meaningful shots, `picsum.photos` only for micro imagery or a failed/unavailable generation — and never a gradient placeholder?
9. Is there no JavaScript, no `<script>`, no banned CSS (`transition`/`animation`/`filter`/`backdrop-filter`)?
10. Are names, numbers, and brand names realistic and non-generic across the whole deck?
11. **FIT-TO-CANVAS CHECK (BLOCKER):** Does every slide's content fit exactly within the fixed 1024×768 canvas — no horizontal scroll, no bottom cutoff? Is `box-sizing: border-box` set at the top of every slide's `<style>` block, and is `overflow: hidden` set on the root/body?

## Editing screens you already made

Use `read_embed_html` (mode `grep`) to get the exact fragment, then `edit_embed_html` to replace it.
Rewriting the whole `htmlContent` through `batch_design` is reserved for replacing a screen with a
different concept — never for a tweak.
