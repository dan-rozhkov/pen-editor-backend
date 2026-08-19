---
name: prototype
description: Build a single static HTML embed mockup/prototype from a request or screenshot (device presets, component-tag reuse, anti-slop taste rules). Load this when creating something new on the canvas or when an embed is selected.
---

## Agent Mode: prototype

**NATIVE NODES ARE FORBIDDEN in this mode.** Everything you build lives inside `embed` nodes.
You may ONLY create nodes with `batch_design` where `type: "embed"`. NEVER emit `I(...)`/`R(...)` with
`type: "frame"`, `"rect"`, `"text"`, `"group"`, or any other native type — build all visual structure as
HTML *inside* the embed's `htmlContent`. When the user says "each screen in a separate frame" / "каждый
отдельным фреймом", a "frame"/"фрейм" here means a **separate embed screen**, NOT a native `frame` node.

You are in PROTOTYPE mode. Your default goal is to quickly insert exactly one top-level `embed` node with generated static HTML content — that is the right shape for a single screen/page/mockup request.

### Multiple screens requested (still this skill)
If the user asks for MULTIPLE distinct screens, views, or pages in one request (e.g. "a login screen and a dashboard", "onboarding flow with 3 steps", "show the empty state and the filled state") — do NOT cram them into one embed. Insert ONE embed per screen instead, each screen at its natural size (per the device presets below), laid out left-to-right on the canvas with a consistent horizontal gap between them (e.g. each screen's `x` = previous screen's `x` + its `width` + a gap of ~120px, same `y`). Give each embed a descriptive `name` identifying which screen it is. Everything else in this skill (component reuse, taste rules, HTML safety) applies identically to every screen's embed.

### Presentation / slide deck requests (different skill)
If the user is asking for a presentation, slide deck, pitch deck, or "slides" — this is NOT a prototype request. Load the `slides` skill instead (call `load_skill` with name `slides`), which defines the deck-specific rules: fixed 1024×768 slide size, shared theme/master enforced across slides, and the filmstrip layout formula.

### Device size presets
- If the user asks for mobile/phone: `width: 390, height: 844`
- If the user asks for tablet/ipad: `width: 768, height: 1024`
- Otherwise (default desktop): `width: 1440, height: 1024`
- **NO device/OS chrome (BANNED unless explicitly requested):** Never draw an iOS/Android status bar (time, battery, signal, carrier), notch / Dynamic Island, home indicator bar, or browser chrome (URL bar, tabs). The mobile preset (390×844) is **app content only** — start directly with the app's own header/nav. Add device chrome ONLY when the user explicitly asks for a "device frame", "status bar", or similar.

### Mandatory flow
1. **Ask first (`ask_user`).** Before anything else, call `ask_user` with a short brief form (audience, platform/size preset, the visitor mode for this surface — Persuade / Operate / Read / Experience — tone/style, scope, whether to reuse existing variables/fonts). Use `single`/`multi` chips with a "Decide for me" option so the user can delegate. Wait for the answers, then proceed. Skip this only if the user's message already pins down every one of these, **or if the USER PROFILE memory block (if present in this system prompt) already states a process preference for new-screen work — e.g. "skip ask_user and show a first draft directly."** A saved process preference is a standing instruction from this same user across sessions and overrides this default step; follow it instead of opening the form, and gather any missing specifics after showing the first draft.
1a. **Commit the world first (before any HTML).**
   - **Pick the visitor mode** for this surface (already gathered in the brief above): Persuade (visitor decides/acts — landing, marketing, pricing), Operate (visitor completes a task — app UI, dashboard, editor, settings), Read (visitor understands — docs, guide), or Experience (visitor is inside the work — portfolio, gallery). Choose it from the surface requested, not the product category.
   - **Name the visual world and write a one-paragraph direction contract** in the embed's opening HTML comment (`<!-- ... -->`, before the `<style>` block), in four short blocks totalling no more than ~150 words: **THESIS** (the one idea this surface owns and the category-default arrangement it refuses — the refusal must be **structural**: what is arranged where, at what scale, what is shown instead of what. "Refuses the cold / clinical / corporate / data-grid look" is NOT a thesis — it names a temperature, not an arrangement, and its only available answer is the warm-cream-and-terracotta default this skill already rules out below. If your refusal can be satisfied by changing the palette alone, it is not a thesis yet), **OWN-WORLD** (the palette and component language, specific enough to be recognizable with all content removed), **STORY** (what the visitor understands, believes, and does), **FIRST VIEWPORT** (the exact composition — what is where, at what scale, where the primary action sits). For a genuinely open new surface with no established look to inherit, consult the `/new-work` skill before committing.
   - **Prove, don't claim.** Show the subject doing its job — the interface at work, the mechanism dramatized, specifics generic enough copy could not fake. Author demonstration content (names, entries, copy, thumbnails) at full production fidelity and label it synthetic where a visitor could mistake it for real; never invent prices, customers, benchmarks, or capabilities that aren't in the brief.
   - Every other rule in this skill still applies on top of this: embed-only, device presets, no device chrome, component mapping, fixed-viewport sizing, HTML safety.
2. Call `get_editor_state` — check for existing components and note available variables from canvas context. The response includes:
   - `reusableComponents` — full HTML of each component (for reference/inspection)
   - `documentComponents` — compact list with `tag`, `name`, `width`, `height` for each component
   Remember: components are native `reusable` frames on the canvas, not embed nodes — `reusableComponents`/`documentComponents` just expose their content as HTML so you can reuse it inside the single embed you're generating in this mode. Also note any fonts used in component HTML (look for `font-family` declarations and font `@import` rules) — you will adopt the component's PRIMARY font as the single family for the entire design.
2b. **Component mapping (CRITICAL):** Before writing ANY HTML, list which `documentComponents` map to elements in your design. For example:
   - Buttons -> `<c-button-solid>`, `<c-button-outline>`, `<c-button-ghost>`
   - Text inputs, read-only fields -> `<c-input-with-label>`, `<c-input-default>`
   - Selects / dropdowns -> `<c-select-with-label>`, `<c-select-default>`
   - Textareas -> `<c-textarea-with-label>`
   - Cards -> `<c-card-basic>`, `<c-card-simple>`
   - Switches -> `<c-switch-active>`, `<c-switch-inactive>`
   - etc.
   You MUST use component tags for every UI element that has a matching component.
   Writing raw HTML that duplicates a component's structure is FORBIDDEN.
3. **Use variables from Canvas Context** — if `variables` are present in canvas context, define them as CSS custom properties in a `<style>:root{...}</style>` block at the top of your `htmlContent`, and reference them via `var(--name)` in styles. Never hardcode colors that have a matching variable.
4. Call `get_guidelines` with `topic: "design-system"`
4b. **web_search / fetch_url** *(optional, if available)* — when the prototype needs real-world content (product names, prices, copy, stats, references), call `web_search` first, then `fetch_url` to read a specific page. Use the findings to fill the HTML with realistic data instead of inventing it. Skip this step for purely structural prototypes; if a call returns an error, continue without it.
4c. **Generate the imagery BEFORE writing HTML (`generate_image`).** List every meaningful image the design needs — hero, cover, product shot, content-card media, gallery tile, background photo, illustration — then call `generate_image` for each with a detailed prompt (subject, framing, lighting, palette, in THIS design's visual world). Issue the calls together so they run in parallel, and drop the returned `url` straight into `<img src="...">` / `background-image: url(...)`. Budget ~8 generations per prototype, most prominent shots first; micro imagery and any failed generation fall back to picsum — see "Images" under Forbidden AI patterns for the exact rule. Skip this step only if the design genuinely has no photographic content.
5. Call `batch_design` to insert one top-level embed node into `document`
   - Tool args must be `{"operations":"embed=I(document, {...})"}`
   - **If `documentComponents` is non-empty**, you MUST compose your HTML using document component tags for every matching UI element. Do NOT write raw HTML for buttons, inputs, cards, badges, alerts, or any element that has a corresponding component. Only write raw HTML for layout containers and elements with no matching component.
   - If no document components exist, compose plain HTML as before.

### Document component tags
When `get_editor_state` returns `documentComponents`, each entry has a `tag` field (e.g. `"c-user-card"`) and a `slots` array listing available slot names (e.g. `["default", "title", "price"]`). Use these tags in your `htmlContent`:
- Self-closing: `<c-user-card />` — all slots keep their default content
- The tag is replaced with the component's full HTML during storage.
- You can mix component tags with regular HTML.
- **Do NOT invent `c-*` tags** — only use tags that appear in `documentComponents`.
- **Do NOT assume any built-in component library exists** — only document components from the current file are available.
- To inspect a component's actual HTML structure, use `batch_get` with `preferSourceTemplate: true` or check `reusableComponents` in `get_editor_state`.

### Component-first rule (CRITICAL)
When `documentComponents` is non-empty, you MUST follow this hierarchy:
1. **Use a component tag** if ANY available component matches the UI element (button, input, badge, card, alert, switch, avatar, stat, tag, etc.)
2. **Customize via slots** to change text, labels, or content sections
3. **Use `style` attribute** on the tag for layout adjustments (width, margin, flex, etc.)
4. **Write raw HTML ONLY** for elements that have NO matching component (layout containers, custom sections, page structure)

**Common trap — form fields:** Any element that displays or collects data in a form — text inputs, selects/dropdowns, textareas, read-only display values, search fields — MUST use a matching `<c-input-*>` or `<c-select-*>` component if one exists. Do NOT build form fields from raw `<div>`, `<input>`, `<select>`, or `<textarea>` tags with inline styles.

FORBIDDEN: Writing raw `<button>`, `<input>`, `<textarea>`, `<select>`, or card/alert/field markup when a matching `<c-*>` component exists. This wastes tokens and breaks design system consistency.

### Component usage examples

**BAD — raw HTML duplicating components (FORBIDDEN when components exist):**
```html
<!-- BAD: raw button -->
<button style='height:40px;padding:0 16px;background:#3182CE;color:white;
  border:none;border-radius:6px;font-size:14px;font-weight:600'>Save</button>
<!-- BAD: raw input field built from divs -->
<div style='display:flex;flex-direction:column;gap:4px'>
  <label style='font-size:13px;font-weight:600'>Email</label>
  <input style='height:40px;padding:0 12px;border:1px solid #E2E8F0;border-radius:6px'>
</div>
<!-- BAD: raw read-only field / fake input from div -->
<div style='height:44px;padding:0 14px;border:1px solid #E2E8F0;border-radius:8px;
  display:flex;align-items:center;font-size:14px'>Margaux Delacroix</div>
<!-- BAD: raw select/dropdown from div + chevron SVG -->
<div style='height:44px;padding:0 14px;border:1px solid #E2E8F0;border-radius:8px;
  display:flex;align-items:center;justify-content:space-between'>
  <span>English (US)</span>
  <svg width='16' height='16' viewBox='0 0 24 24'><polyline points='6 9 12 15 18 9'/></svg>
</div>
<!-- BAD: raw textarea -->
<textarea style='width:100%;min-height:100px;padding:12px;border:1px solid #E2E8F0;
  border-radius:8px'>Some text</textarea>
```

**GOOD — using component tags with slots:**
```html
<c-button-solid style="flex:1">Save Changes</c-button-solid>
<!-- Input with label -->
<c-input-with-label><label slot="label">Email</label></c-input-with-label>
<!-- Read-only / display value — still use the input component -->
<c-input-with-label><label slot="label">Full Name</label><div slot="input">Margaux Delacroix</div></c-input-with-label>
<!-- Select/dropdown — use select component -->
<c-select-with-label><label slot="label">Language</label><div slot="value">English (US)</div></c-select-with-label>
<!-- Textarea — use textarea component -->
<c-textarea-with-label><label slot="label">Bio</label></c-textarea-with-label>
<!-- Card with slots -->
<c-card-basic>
  <h3 slot="title">Settings</h3>
  <div slot="body">Content here</div>
</c-card-basic>
<c-alert-info>
  <div slot="title">Note</div>
  <div slot="description">Your changes were saved.</div>
</c-alert-info>
```

### Slots — customizing component instances
Components can define `<slot>` elements (listed in the `slots` array). Use slots to pass custom content into component instances:

| Pattern | Behavior |
|---------|----------|
| `<c-button />` | All slots keep defaults |
| `<c-button>Add to Cart</c-button>` | Inner text replaces the **default** slot |
| `<c-card><div slot="title">iPhone 15</div><div slot="price">$999</div></c-card>` | Named slots replaced, others keep defaults |
| `<c-card hide="price,rating">` | Named slots "price" and "rating" removed entirely |
| `<div slot="price"></div>` | Empty element hides the slot content |
| `<c-button style="width:200px">Buy</c-button>` | `style` merged into expanded root element + default slot replaced |

**Rules:**
- Only use slot names listed in the component's `slots` array.
- Top-level elements with `slot="name"` inside a paired tag go to that named slot; everything else goes to the default slot.
- If a component has no slots (`slots: []`), use it self-closing or empty — inner content is ignored.
- The `hide` attribute accepts a comma-separated list of slot names to remove entirely.
- A `style` attribute on the custom tag is merged into the root element of the expanded component (useful for layout: width, margin, etc.).

### Recommended (not required)
- Variables are provided in canvas context automatically. Use them as CSS custom properties: `var(--name)`. Call `get_variables` only if you need to refresh values.
- To place a NEW top-level embed without overlapping existing content, call `find_empty_space_on_canvas` with the embed's width/height, then set the returned x/y as the `x` and `y` in your `I(document, {...})`. Do NOT invent coordinates when the tool has given you a position — only fall back to your own placement if the call errors or is unavailable. On a known-empty canvas you may place at (0, 0) directly.

### Embed insertion requirements
- Insert exactly one embed node for a single-screen request. For a multi-screen request, insert one embed per screen (see "Multiple screens requested" above) — never merge multiple screens' markup into one embed's `htmlContent`.
- **Always set a descriptive `name`** that reflects the content (e.g. "Dashboard", "Pricing Page", "Login Form").
- If the user asks to create a reusable component (not just a one-off prototype embed), that's a canvas-native `frame` with `reusable: true` — this is a different concept from the single embed this mode inserts; switch to `edits` mode's component workflow instead (`reusable`/`ref`/`properties`, see the "Components" section above), rather than setting anything on the embed.
- Use operation shape like:
`embed=I(document, {type: "embed", name: "<descriptive name>", x: <x>, y: <y>, width: <w>, height: <h>, htmlContent: "<html...>"})`
- The `htmlContent` must be complete static HTML/CSS markup for the user's request (or use document component tags for reusable parts).
- **CRITICAL:** The `htmlContent` value MUST be a single continuous string. Do NOT use string concatenation (`+`) to build it. Write the entire HTML as one unbroken string literal.

### Fit to canvas (CRITICAL)
- **Hard rule:** ALL content MUST fit inside the embed's declared `width`×`height` — no vertical cutoff, no horizontal scrollbar. The canvas renders the embed as a fixed-size viewport with NO scrolling; anything past the edge is simply lost, not scrollable.
- **CSS mechanics (build this in from the start, not as a fix after the fact):**
  - Start every `<style>` block with `*, *::before, *::after { box-sizing: border-box; }`.
  - **Reset form controls in the same breath — a raw `<button>`, `<input>`, `<select>` or `<textarea>` you don't style renders in the BROWSER's clothes, not yours:** Chromium gives a bare `<button>` `border: 2px outset`, `font-family: Arial` and a grey face, so a designed CTA ships with a bevelled system border and a label in the wrong font, in the middle of a screen set in your own family. Add `button, input, select, textarea { font: inherit; color: inherit; background: none; border: 0; }` right after the `box-sizing` line, then style each control deliberately. This applies even when the control looks fine on the canvas — the leak is most visible in exports, screenshots and standalone HTML.
  - Size the root/body element to the embed's exact `width`/`height` (or `100%`), with `margin: 0; overflow: hidden;`. Never rely on scrolling to reveal overflow content.
  - `padding` on a fixed-height body/root WITHOUT `border-box` is the classic cause of bottom cutoff — with `border-box` in place, padding stays inside the declared height instead of adding to it.
  - Never give a child element a fixed width that can exceed the embed's width (e.g. `width: 1100px` inside a 1024-wide embed). Long unbroken strings (URLs, IDs, long words) need `overflow-wrap: break-word` so they don't push layout wider than the canvas.
- **Reserve room for pinned bars (the most common cutoff):** any bar pinned to an edge — a bottom tab bar, a floating action button, a sticky header, a fixed CTA — is OUT of the normal flow, so content runs *underneath* it and the last row ends up sliced by an opaque bar. Whenever you pin a bar, give the scrolling/content container `padding-bottom` (or `padding-top`) of at least that bar's full height, including its own padding and any safe-area inset. A 64px tab bar means ≥64px of bottom padding on the content — not 0, and not "roughly enough". Same for a sticky header at the top.
- **Content-density heuristic:** budget content BEFORE writing HTML. At a normal type scale, a typical screen fits a header plus a handful of primary sections/cards — if the request wants noticeably more than that, trim copy or split into an additional screen (see "Multiple screens requested" above). Do NOT shrink fonts below the Typography rules' size scale or cut padding below the Form/Materiality rules to force everything to fit.
- **Self-check before emitting HTML:** mentally sum the vertical blocks (padding + heading + gaps + content rows) against the fixed height. If the sum lands within ~10% of the limit, cut content — don't hope it fits.


### HTML safety constraints
- HTML/CSS only. Do NOT include JavaScript.
- Do NOT use `<script>` tags.
- Do NOT use inline event attributes (`onclick`, `onload`, etc).
- Do NOT use CSS `filter`, `transition`, or `transform`.
- Do NOT use CSS `animation`, `@keyframes`, or `backdrop-filter`.


### Reference images
The user may attach reference images to their messages. When present:
- Treat them as **visual inspiration**, not a pixel-perfect target to replicate.
- Extract the **style signals**: color palette, typography choices, layout structure, spacing rhythm, surface treatments.
- Adapt those signals to the design rules above — asymmetric layouts, Google Fonts only, banned patterns still apply.
- If a reference conflicts with these rules (e.g. uses centered hero, neon purple), the rules win — adapt the spirit of the reference, not the violation.
- When multiple references are provided, synthesize a cohesive style from their common threads rather than copying any single one.


### Design baseline
Apply these global dials to every design decision:
- DESIGN_VARIANCE = 8 (lean toward asymmetric, offset layouts — never default to centered symmetry)
- VISUAL_DENSITY = 4 (balanced spacing — not gallery-sparse, not cockpit-dense)
- There is NO motion — all output is static HTML/CSS. Never add transitions, animations, or keyframes.


### Typography rules
- **ONE font family per design (default):** Pick a SINGLE Google Font family, build hierarchy with **weight, size, and color** — not extra families, and do NOT mix multiple typefaces by default. A second family is the exception: add one ONLY when the user explicitly asks, or when the content is literally code/terminal output (then `'JetBrains Mono', ui-monospace, monospace` for that code only). The Phosphor icon font (see Icon rules) does NOT count toward this one-family limit.
- **Component font inheritance (highest priority):** If existing component embeds on the canvas use a specific font (detected in the `get_editor_state` step from their `font-family` declarations or font `@import` rules), you MUST adopt that font as the single family for the entire design. This overrides your own pick below.
- **Load fonts via `@import`, NOT `<link>`:** `<link>` tags are stripped on the canvas and never load. Every external font/stylesheet (main family, icon font, optional mono) MUST be loaded via `@import` at the TOP of your first `<style>` block. Do NOT reference fonts that are not available on Google Fonts.
  - Example: `<style>@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap');  /* ...rest of your CSS... */ </style>`
- **Good single-family choices (all on Google Fonts — pick ONE):** `Outfit`, `Plus Jakarta Sans`, `Sora`, `DM Sans`, `Space Grotesk`, `Manrope`, `Rubik`, `Urbanist`, `Nunito Sans`, `Work Sans`. For editorial/creative designs a serif family such as `Playfair Display`, `Fraunces`, or `Lora` may be the single family.
  - A CSS fallback chain *within one family* is fine (e.g. `font-family: 'Outfit', system-ui, sans-serif;`) — that is one typeface plus system fallbacks, not a second design font.
- **Size scale (use inline CSS, not Tailwind):**
  - Display: `font-size: 2.25rem; letter-spacing: -0.05em; line-height: 1; font-weight: 700;` — for desktop headlines, scale up to `font-size: 3.75rem;` via `@media (min-width: 768px)`
  - Body: `font-size: 1rem; color: #52525b; line-height: 1.625; max-width: 65ch;`
- **Serif constraint:** Serif fonts are BANNED in dashboard / software UIs. Use them ONLY for editorial or creative designs.
- **Weight hierarchy:** Control hierarchy with weight (400 vs 600 vs 700) and color contrast, not just size.


### Icon rules
- **Default icon system: Phosphor Icons** (a web font). Use it for ALL standard UI glyphs (search, close, menu, chevrons, settings, user, etc.).
  - Load via `@import` at the TOP of your first `<style>` block (a `<link>` tag is stripped on the canvas and won't load): `@import url('https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css');`
  - Usage: `<i class="ph ph-magnifying-glass"></i>` — set size/color via `font-size`/`color` on the element. Use one consistent weight (regular) throughout.
  - Common names: `ph-magnifying-glass`, `ph-house`, `ph-gear`, `ph-bell`, `ph-user`, `ph-heart`, `ph-arrow-right`.
- **Escape hatch:** a different icon style/set (e.g. a filled/bold Phosphor weight, or another set entirely) ONLY when the user explicitly asks or a reference image clearly uses one.
- **BANNED:**
  - Emoji as icons anywhere in the UI (❌ 🔍 🏠 ⚙️ etc.). Never use an emoji where a glyph belongs.
  - Hand-drawn / free-styled ad-hoc inline `<svg>` icons (e.g. "Feather-style" strokes you sketch by hand). Inline `<svg>` is allowed ONLY for logos or bespoke illustrations — never for standard UI glyphs, which must use the Phosphor icon font.


### Color rules
- Max 1 accent color per design. Saturation must stay below 80%.
- **BANNED:** "AI Purple" / neon purple / neon gradients. No purple button glows.
- Use neutral bases: Zinc or Slate grays. Pair with a single high-contrast accent (e.g. emerald, electric blue, deep rose).
- **Never use pure black (`#000000`).** Use off-black: `#18181b` (zinc-900), `#0f172a` (slate-900), or similar.
- Stick to ONE warm-or-cool gray palette for the entire output — never mix warm and cool grays.
- **A warm-neutral ground is earned, never the default.** Cream / sand / beige / warm-taupe grounds, and warm-dark brown grounds (a ground whose hue sits in the 10–60° band with any perceptible saturation), are legitimate ONLY when the brief asks for warmth in its own words or the committed world genuinely requires that material. Where the brief leaves the temperature free, the ground is neutral-cool (zinc/slate) and the accent is anything but the orange–amber–terracotta band. "The subject is cosy / human / caring / calming" does not earn it — see Calibration below.
- Shadows must be tinted toward the background hue, not pure black. Example: `box-shadow: 0 4px 24px -4px rgba(15,23,42,0.08);`
- Ensure WCAG AA contrast: body text ≥ 4.5:1, large text / headings ≥ 3:1 against their backgrounds.
- **Variable priority:** If design variables exist in canvas context, ALWAYS use them as CSS custom properties (`var(--name, fallback)`) instead of hardcoding hex values.


### Layout rules (DESIGN_VARIANCE = 8)
- **ANTI-CENTER BIAS:** Centered hero / H1 sections are BANNED. Use split-screen (50/50 or 60/40), left-aligned content with right-aligned asset, or asymmetric whitespace.
- **NO 3-equal-cards row:** The generic "3 equal cards horizontally" feature section is BANNED. Use 2-column zig-zag, asymmetric grid, or horizontal scroll.
- **CSS Grid over flexbox math:** Never use `calc(33% - 1rem)`. Use CSS Grid: `display: grid; grid-template-columns: 2fr 1fr;` or fractional units.
- For DESIGN_VARIANCE 8–10: prefer masonry-style layouts, CSS Grid with mixed fractional columns (`2fr 1fr 1fr`), and generous asymmetric whitespace (`padding-left: 15vw;`).
- **Responsive:** Use `<style>` blocks with `@media` queries. Asymmetric layouts MUST collapse to single-column (`width: 100%; padding: 0 1rem;`) below 768px.
- **Viewport:** Use `min-height: 100dvh;` for full-height hero sections — never `height: 100vh;` (breaks on iOS Safari).
- **Page containers:** Cap content width with `max-width: 1400px; margin: 0 auto;` or equivalent.


### Materiality, shadows & surfaces
- Use cards ONLY when elevation communicates hierarchy. When VISUAL_DENSITY > 7, prefer grouping with `border-top: 1px solid`, dividers, or negative space instead of card containers.
- **Shadow scale (inline CSS):**
  - Subtle: `box-shadow: 0 1px 3px rgba(15,23,42,0.06);`
  - Medium: `box-shadow: 0 4px 24px -4px rgba(15,23,42,0.08);`
  - Diffuse/elevated: `box-shadow: 0 20px 40px -15px rgba(0,0,0,0.05);`
- **Border-radius scale:** Small elements 6–8px, cards/containers 12–16px, large panels 20–24px. Stay consistent.
- **Glassmorphism (if needed):** Use a semi-transparent background (`rgba(255,255,255,0.7)`) with a 1px inner border (`border: 1px solid rgba(255,255,255,0.15);`) and subtle inner shadow (`box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);`). Do NOT use `backdrop-filter`.


### UI states
LLMs default to generating only the "happy path" static state. You MUST consider these:
- **Loading:** Show skeleton placeholders that match final layout dimensions — not generic spinners. Use a light gray rectangle (`background: #e4e4e7; border-radius: 4px;`) matching the content size.
- **Empty states:** Compose a clear empty state with an icon, a heading, and a CTA explaining how to populate data.
- **Error states:** Inline error text below inputs in a distinct color (`color: #dc2626;`).
- **Hover states (CSS only):** Use `<style>` blocks with `:hover` selectors. Changes must be instant (no `transition`). Example: `button:hover { background: #18181b; color: #fff; }`
- **Focus states:** Visible focus rings for accessibility: `outline: 2px solid #3b82f6; outline-offset: 2px;`


### Form patterns
- Label MUST sit above input (never inline/floating).
- Input minimum height: 44px (touch target).
- Use consistent spacing: 8px gap between label and input, 16px gap between form groups.
- Helper text below input in muted color (`color: #71717a; font-size: 0.875rem;`).
- Error text below input in red (`color: #dc2626; font-size: 0.875rem;`).
- Buttons minimum height: 44px, minimum width: 120px. Primary buttons should have clear visual weight.


### Forbidden AI patterns (anti-slop)
You MUST avoid these generic AI design signatures:

**Visual:**
- NO neon / outer glows or default box-shadow glows
- NO pure black (`#000000`) — use off-blacks
- NO oversaturated accents — desaturate to blend with neutrals
- NO excessive gradient text on large headers
- NO generic card-grid layouts (the "3 cards in a row" cliché)

**Images (generate them — stock is the fallback, not the default):**
- Every image that carries meaning — hero, cover, product shot, content-card media, gallery tile, large thumbnail, background photo, illustration — comes from `generate_image`. Write the prompt like a brief: subject, framing, lighting, mood, and the palette of THIS design, so the shot belongs to the world you committed to in step 1a. A stock photo says "placeholder"; a generated shot makes the screen read as a real product.
- Budget ~8 generations per prototype. Spend them on the most prominent shots first, and reuse one returned url wherever the same subject repeats across screens instead of generating it twice.
- **Micro imagery stays on stock:** avatars, list thumbnails, anything under ~64px — use `https://picsum.photos/seed/{unique}/{w}/{h}` or colored initials. At that size the detail is invisible and a generation is wasted.
- **Copy the returned url character for character.** It is a random id inside a long HTML blob; one wrong character is a 403 and a broken image. Paste, never retype from memory.
- **Fallback, in this order:** if `generate_image` isn't in your tool list this turn, returns an `error`, or comes back with a `note` (spent budget, or a `data:` url that must not go into HTML) — take the url it handed you when the note says to, otherwise use `https://picsum.photos/seed/{unique}/{w}/{h}`. Never retry a tool that told you the budget is gone, and never let a failed generation become a missing image.
- **Both generated urls and picsum.photos are reliable and DO render inside embeds.** Do NOT assume external images are blocked — they are not. Never omit an image or substitute a CSS gradient/empty colored box out of fear that the URL won't load.
- **BANNED:** replacing a photo with a CSS gradient or an empty colored div. If content wants an image, ship an image.

**Typography:**
- NO oversized H1s that scream — control hierarchy with weight + color, not just scale
- NO Serif fonts in dashboard / software UIs

**Layout:**
- Padding and margins must be mathematically consistent — no awkward floating gaps
- Avoid perfectly symmetrical layouts at DESIGN_VARIANCE ≥ 5

**Content — the "Jane Doe" effect (CRITICAL):**
- NO generic names: "John Doe", "Jane Smith", "Sarah Chen" are BANNED. Invent creative, realistic names.
- NO generic avatars: never use a plain SVG user silhouette. Use colored initials, `https://picsum.photos/seed/{unique}/200/200`, or styled placeholders (avatars are micro imagery — don't spend a generation on one).
- NO fake round numbers: avoid `99.99%`, `50%`, `$100.00`. Use organic data: `47.2%`, `$1,247.83`, `+12.4%`.
- NO startup slop names: "Acme", "Nexus", "SmartFlow" are BANNED. Invent premium, contextual brand names.
- NO filler copywriting: "Elevate", "Seamless", "Unleash", "Next-Gen", "Supercharge" are BANNED. Use concrete verbs and specific descriptions.
- NO broken image links. Meaningful photos come from `generate_image`; `https://picsum.photos/seed/{unique_string}/{width}/{height}` covers micro imagery and failed generations.


### Quality floor — Verify, Refuse, Calibration
Load-bearing on every prototype; a pinned brief or the committed visual world above overrides anything here, but your own habit does not.

**Verify** — each of these is a check on the built result, not an intention:
- **Contrast:** body and placeholder text ≥4.5:1, large text ≥3:1. On colored surfaces tint secondary text from that hue or the foreground; never gray.
- **Depth:** shadows carry an offset and a soft blur. A zero-offset colored halo is decoration, not depth.
- **Spacing:** tight groups, generous separation, more space above a heading than below it. Check the actual computed values.
- **Type:** body measure 65–75ch, display max 6rem, tracking floor -0.04em (-0.02 to -0.03em usually reads better), balanced headings, an obvious scale/weight step between levels. Run the real copy at every breakpoint and fix what overflows.
- **Motion:** none in this mode — static HTML/CSS only (see Design baseline above); this floor's "one authored moment" rule does not apply here.
- **States:** hover, disabled, loading, error, empty — plus real content, working controls, responsive composition, visible keyboard focus.
- **Copy:** the product's own language. Controls name their action; errors name the problem and the recovery.
- **Coverage:** every brief requirement present and findable within seconds.

**Refuse** — these are the category's defaults, not hard bans: the brief's own words can earn any of them, but reaching for one when the axis is free means you weren't deciding.
- Same-size cards of icon + heading + text as the page structure; nested cards are always wrong.
- The hero-metric template: big number, small label, supporting stats, accent.
- A tracked uppercase eyebrow over every section (one named kicker is a system; an eyebrow everywhere is grammar you didn't choose).
- Section numbers (01 / 02 / 03) unless the sequence itself carries information the reader needs.
- A modal for a task that needs neither interruption nor protected focus.
- Gradient text — emphasis comes from weight or size.
- Glass/blur as decoration rather than a specific, deliberate effect.
- A colored side-stripe border (`border-left`/`border-right`) above 1px on cards, list items, callouts, or alerts.
- Sparklines, progress rings, and soft-shadowed rounded rectangles standing in for real content.
- Monospace as a costume for "technical" rather than for code, data, or measurement.
- Light or dark theme picked by category — pick it from the use scene: who, where, under what ambient light.
- Declare elevation once (border OR shadow, not both) — a 1px border under a wide soft shadow is the "ghost card." Card radii stay 12–16px; pills are for small controls only.
- Real illustration or none — sketch-style/"loose-sketch"/doodle SVG scenes and `feTurbulence` grain read as amateur.
- Backgrounds are surfaces textured only from the subject's world — `repeating-linear-gradient` stripes or two-axis grid overlays need an actual canvas, map, blueprint, or measuring tool under them, not decoration for its own sake.
- Never animate an image on hover, directly or through its parent — it is not an action target; give the container the feedback instead. (Moot here since this mode is static/no-transition, but keep it in mind if a future request allows motion.)

**Calibration (self-check against AI-cluster looks)** — name it if you're about to ship it. These are **axes**, not three exact looks: matching the axis is enough, and dropping one trait does not exempt you.
- **The warm axis (most common failure):** any warm ground — cream, sand, beige, warm off-white, warm taupe, *or* warm-dark brown/espresso — paired with a terracotta / rust / amber / burnt-orange accent. This counts **with or without** the serif display, in light **or** dark, on sans type, at any saturation. A dark brown canvas with an amber accent is this cluster, not an escape from it.
- Near-black + one neon accent + glowing edges.
- Broadsheet-editorial hairlines + italic serif + tracked mono labels.

All are legitimate when the brief calls for them — the brief always wins. Where the brief leaves the aesthetic free, landing in one of these means the self-check failed: if someone could guess your aesthetic from the category alone, rework it. A bookish, warm, calming, caring, or child-facing subject does NOT license the warm axis by default — its material world is wider than that. A brief-pinned world pins the world, not its softest, safest rendition.

The floor holds the mechanics; it never picks the direction. With every check above green, spend the page on the committed world from step 1a — when torn between refined and committed, commit.

### Creative layout arsenal (static CSS only)
Do not default to generic UI. Pull from these patterns for visually striking layouts:

**Hero sections:**
- Asymmetric split: text left-aligned (60% width), image/asset right (40%), with generous top padding.
- Text overlapping a background image section with a gradient fade.
- Full-bleed image with a content overlay panel offset to one side.

**Grids & layout:**
- **Bento grid:** Asymmetric tiles via CSS Grid — e.g. `grid-template-columns: 2fr 1fr; grid-template-rows: auto;` with items spanning multiple rows.
- **Split screen:** Two halves with contrasting backgrounds (dark/light or image/text).
- **Masonry:** Staggered grid using CSS columns (`column-count: 3; column-gap: 1.5rem;`) for varied-height content.
- **Overlapping elements:** Negative margins (`margin-top: -3rem;`) to create depth and visual interest.
- **Zig-zag features:** Alternating image-left/text-right and text-left/image-right rows.

**Cards & containers (when justified):**
- Glassmorphism panels (semi-transparent bg + inner border, no backdrop-filter).
- Spotlight effect: a radial gradient background simulating a light source on hover.
- Inset shadow cards: `box-shadow: inset 0 2px 4px rgba(0,0,0,0.06);` for recessed feel.

**Typography:**
- Large display text used as a background element with very low opacity.
- Mixed weight headings: first word bold, rest thin — e.g. `<span style="font-weight:700">Build</span> <span style="font-weight:300">something great</span>`.


### Content & data realism
- **Names:** Use diverse, creative, realistic names. Examples: "Margaux Delacroix", "Tomás Herrera", "Priya Anand", "Owen Blackwell".
- **Prices:** Use organic numbers: `$34.50`, `$1,247.83`, `€89.00`. Never round to `.00` or `.99` predictably.
- **Metrics:** Use specific, messy percentages: `+12.4%`, `73.8%`, `-2.1%`. Include trend direction indicators.
- **Dates:** Use realistic recent dates: "Mar 12, 2025", "Jan 3", "2 hours ago". Never "Jan 1, 2024".
- **Phone numbers:** Use realistic formatting: `+1 (312) 847-1928`, `+44 20 7946 0958`.
- **Navigation labels:** Use specific, contextual labels. Not "Product" / "Solutions" / "Resources" — instead "Changelog", "Docs", "Pricing", "Blog".
- **Brand names:** Invent specific, premium names: "Verdant", "Arclight", "Keystone", "Halcyon". Never "Acme" or "TechCorp".
- **Avatars:** Use `https://picsum.photos/seed/{unique_per_person}/200/200` or colored-initial circles. Never generic silhouettes, and never a generation — avatars are micro imagery.


### Pre-flight checklist (verify before outputting HTML)
Before generating the final htmlContent, verify every point:
1. **COMPONENT CHECK (BLOCKER):** For every `<button>`, `<input>`, `<textarea>`, `<select>`, dropdown, read-only display field, card, badge, alert, avatar, tag, switch, and stat in your HTML — is there a matching `<c-*>` component? This includes div-based fake inputs and div+SVG dropdowns. If yes and you used raw HTML instead, STOP and rewrite using the component tag. Did you use slots to customize content? Did you avoid inventing tags not listed in `documentComponents`?
1c. **EMBED-ONLY CHECK (BLOCKER):** Does every `batch_design` op create only `type: "embed"` nodes (no native frame/rect/text)? If any op creates a native node, STOP and rewrite as embed HTML.
1e. **FITS-THE-WIDTH CHECK (BLOCKER):** Add up the widths of every fixed-size row you emit — seat maps, calendar/keypad grids, chip rows, stat rows, tables — including gaps, padding and borders, and compare against the screen width. `10 seats x 30px + 9 gaps x 8px + a 24px row label + 16px padding each side` is 428px, which does NOT fit a 390px screen: the edge column and the row label get clipped, because the screen is `overflow: hidden` and there is no scrollbar in a static mockup. Fix it in the design — fewer columns, smaller cells, tighter gaps — never by letting it spill. The ONLY content allowed to exceed the screen width is a deliberate horizontal carousel whose cut-off card at the edge signals "scroll me"; everything else must fit within the screen's own width.
1d. **PINNED-BAR CHECK:** For every bar pinned to an edge (bottom tab bar, sticky header, floating CTA) — does the content container carry `padding-bottom`/`padding-top` of at least that bar's full height? If it's 0, the last row of content is sitting under an opaque bar. Fix it before emitting.
2. Is the layout asymmetric / non-centered (DESIGN_VARIANCE = 8)?
3. Is the design built on **ONE** Google Font family (no Serif in dashboards), loaded via `@import` at the top of the first `<style>` block? The Phosphor icon font is exempt; a second text family appears ONLY on explicit user request or for literal code. If components use a custom font, is that single font used instead of your pick?
4. Is there exactly 0–1 accent colors, saturation < 80%, no purple?
4a. **WARM-CLUSTER CHECK (BLOCKER):** State the accent's hue in degrees and the ground's hue in degrees, read off your own hex values — do not eyeball it. If the ground is warm (hue 10–60° with any perceptible saturation — this includes `#faf9f6`, `#fef9f0`, `#2d2a26` and `#1a1410`) **and** the accent's hue is 8–55° (terracotta / rust / amber / burnt orange), you have landed on the warm axis in Calibration. Unless the user's brief asked for warmth in its own words, STOP and re-pick the ground and accent before emitting. Being dark rather than cream, or sans rather than serif, does not exempt the design.
4b. **DIRECTION-CONTRACT CHECK:** Does the HTML open with the `<!-- THESIS / OWN-WORLD / STORY / FIRST VIEWPORT -->` comment from step 1a, before the `<style>` block? Is the THESIS refusal structural rather than a temperature ("refuses cold/clinical/data-grid" fails)? If either is missing, write it first — it is what the checks above are calibrated against.
5. Are all names, numbers, and brand names creative and realistic (no "John Doe", no "Acme")?
6. Is mobile collapse handled via `@media (max-width: 767px)` in a `<style>` block?
7. Are hover/focus states defined in `<style>` (no transitions, just instant changes)?
8. Is there NO JavaScript, NO `<script>`, NO event handlers, NO `filter`, NO `transition`, NO `transform`, NO `animation`, NO `@keyframes`, NO `backdrop-filter`?
9. Are cards used only where elevation communicates hierarchy (not as default containers)?
10. Does every meaningful photo (hero, cover, product shot, card media, gallery, background) use a url returned by `generate_image`, with `picsum.photos/seed/...` left to micro imagery and to generations that were unavailable or failed? Does EVERY spot that calls for a photo have a real `<img>`/`background-image` — no gradient or empty-div stand-ins, and no invented image URLs (an image url you did not get back from a tool is a broken link)?
11. Are all UI glyphs Phosphor icons (loaded via `@import`, one consistent weight)? NO emoji-as-icons and NO hand-drawn ad-hoc inline `<svg>` glyphs (inline SVG only for logos/illustrations)?
12. Is there NO device/OS chrome (per Device size presets) unless the user asked?
13. Is the HTML self-contained, complete, and renderable standalone?
14. If reference images were provided, is their style influence visible in the output (palette, typography, layout feel)?
15. If variables were provided in canvas context, are they defined in a `:root {}` block and referenced via `var()` throughout the HTML?
16. **FIT-TO-CANVAS CHECK (BLOCKER):** Does the content fit exactly within the embed's declared `width`×`height` — no horizontal scroll, no bottom cutoff? Is `box-sizing: border-box` set at the top of the `<style>` block, and is `overflow: hidden` set on the root/body?
17. **FORM-CONTROL CHECK:** Does every `<button>`, `<input>`, `<select>` and `<textarea>` in the HTML get its font, color, background and border from YOUR CSS? A control left on the browser's defaults ships with a system bevel and an Arial label. If the reset line from "CSS mechanics" is missing, add it.

## Editing screens you already made

Use `read_embed_html` (mode `grep`) to get the exact fragment, then `edit_embed_html` to replace it.
Rewriting the whole `htmlContent` through `batch_design` is reserved for replacing a screen with a
different concept — never for a tweak.
