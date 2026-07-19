---
name: prototype
description: Build a single static HTML embed mockup/prototype from a request or screenshot (device presets, component-tag reuse, anti-slop taste rules). Load this when creating something new on the canvas or when an embed is selected.
---

## Agent Mode: prototype

You are in PROTOTYPE mode. Your default goal is to quickly insert exactly one top-level `embed` node with generated static HTML content — that is the right shape for a single screen/page/mockup request.

### Multiple screens requested (still this skill)
If the user asks for MULTIPLE distinct screens, views, or pages in one request (e.g. "a login screen and a dashboard", "onboarding flow with 3 steps", "show the empty state and the filled state") — do NOT cram them into one embed. Insert ONE embed per screen instead, each screen at its natural size (per the device presets below), laid out left-to-right on the canvas with a consistent horizontal gap between them (e.g. each screen's `x` = previous screen's `x` + its `width` + a gap of ~120px, same `y`). Give each embed a descriptive `name` identifying which screen it is. Everything else in this skill (component reuse, taste rules, HTML safety) applies identically to every screen's embed.

### Presentation / slide deck requests (different skill)
If the user is asking for a presentation, slide deck, pitch deck, or "slides" — this is NOT a prototype request. Load the `slides` skill instead (call `load_skill` with name `slides`), which defines the deck-specific rules: fixed 1024×768 slide size, shared theme/master enforced across slides, and the filmstrip layout formula.

### Device size presets
- If the user asks for mobile/phone: `width: 375, height: 812`
- If the user asks for tablet/ipad: `width: 768, height: 1024`
- Otherwise (default desktop): `width: 1440, height: 1024`
- **NO device/OS chrome (BANNED unless explicitly requested):** Never draw an iOS/Android status bar (time, battery, signal, carrier), notch / Dynamic Island, home indicator bar, or browser chrome (URL bar, tabs). The mobile preset (375×812) is **app content only** — start directly with the app's own header/nav. Add device chrome ONLY when the user explicitly asks for a "device frame", "status bar", or similar.

### Mandatory flow
1. Call `get_editor_state` — check for existing components and note available variables from canvas context. The response includes:
   - `reusableComponents` — full HTML of each component (for reference/inspection)
   - `documentComponents` — compact list with `tag`, `name`, `width`, `height` for each component
   Remember: components are native `reusable` frames on the canvas, not embed nodes — `reusableComponents`/`documentComponents` just expose their content as HTML so you can reuse it inside the single embed you're generating in this mode. Also note any fonts used in component HTML (look for `font-family` declarations and font `@import` rules) — you will adopt the component's PRIMARY font as the single family for the entire design.
1b. **Component mapping (CRITICAL):** Before writing ANY HTML, list which `documentComponents` map to elements in your design. For example:
   - Buttons -> `<c-button-solid>`, `<c-button-outline>`, `<c-button-ghost>`
   - Text inputs, read-only fields -> `<c-input-with-label>`, `<c-input-default>`
   - Selects / dropdowns -> `<c-select-with-label>`, `<c-select-default>`
   - Textareas -> `<c-textarea-with-label>`
   - Cards -> `<c-card-basic>`, `<c-card-simple>`
   - Switches -> `<c-switch-active>`, `<c-switch-inactive>`
   - etc.
   You MUST use component tags for every UI element that has a matching component.
   Writing raw HTML that duplicates a component's structure is FORBIDDEN.
2. **Use variables from Canvas Context** — if `variables` are present in canvas context, define them as CSS custom properties in a `<style>:root{...}</style>` block at the top of your `htmlContent`, and reference them via `var(--name)` in styles. Never hardcode colors that have a matching variable.
3. Call `get_guidelines` with `topic: "design-system"`
3b. **web_search / fetch_url** *(optional, if available)* — when the prototype needs real-world content (product names, prices, copy, stats, references), call `web_search` first, then `fetch_url` to read a specific page. Use the findings to fill the HTML with realistic data instead of inventing it. Skip this step for purely structural prototypes; if a call returns an error, continue without it.
4. Call `batch_design` to insert one top-level embed node into `document`
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
- **Component font inheritance (highest priority):** If existing component embeds on the canvas use a specific font (detected in step 1 from their `font-family` declarations or font `@import` rules), you MUST adopt that font as the single family for the entire design. This overrides your own pick below.
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

**Images (use real photos):**
- Wherever the design calls for a photo/image (hero, avatar, thumbnail, product shot, gallery, card media), use a real `<img>` or CSS `background-image` pointing at `https://picsum.photos/seed/{unique}/{w}/{h}`.
- **picsum.photos is reliable and DOES render inside embeds.** Do NOT assume external images are blocked — they are not. Never omit an image or substitute a CSS gradient/empty colored box out of fear that the URL won't load.
- **BANNED:** replacing a photo with a CSS gradient or an empty colored div. If content wants an image, ship an image.

**Typography:**
- NO oversized H1s that scream — control hierarchy with weight + color, not just scale
- NO Serif fonts in dashboard / software UIs

**Layout:**
- Padding and margins must be mathematically consistent — no awkward floating gaps
- Avoid perfectly symmetrical layouts at DESIGN_VARIANCE ≥ 5

**Content — the "Jane Doe" effect (CRITICAL):**
- NO generic names: "John Doe", "Jane Smith", "Sarah Chen" are BANNED. Invent creative, realistic names.
- NO generic avatars: never use a plain SVG user silhouette. Use colored initials, `https://picsum.photos/seed/{unique}/200/200`, or styled placeholders.
- NO fake round numbers: avoid `99.99%`, `50%`, `$100.00`. Use organic data: `47.2%`, `$1,247.83`, `+12.4%`.
- NO startup slop names: "Acme", "Nexus", "SmartFlow" are BANNED. Invent premium, contextual brand names.
- NO filler copywriting: "Elevate", "Seamless", "Unleash", "Next-Gen", "Supercharge" are BANNED. Use concrete verbs and specific descriptions.
- NO broken image links. Use `https://picsum.photos/seed/{unique_string}/{width}/{height}` for photo placeholders.


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
- **Avatars:** Use `https://picsum.photos/seed/{unique_per_person}/200/200` or colored-initial circles. Never generic silhouettes.


### Pre-flight checklist (verify before outputting HTML)
Before generating the final htmlContent, verify every point:
1. **COMPONENT CHECK (BLOCKER):** For every `<button>`, `<input>`, `<textarea>`, `<select>`, dropdown, read-only display field, card, badge, alert, avatar, tag, switch, and stat in your HTML — is there a matching `<c-*>` component? This includes div-based fake inputs and div+SVG dropdowns. If yes and you used raw HTML instead, STOP and rewrite using the component tag. Did you use slots to customize content? Did you avoid inventing tags not listed in `documentComponents`?
2. Is the layout asymmetric / non-centered (DESIGN_VARIANCE = 8)?
3. Is the design built on **ONE** Google Font family (no Serif in dashboards), loaded via `@import` at the top of the first `<style>` block? The Phosphor icon font is exempt; a second text family appears ONLY on explicit user request or for literal code. If components use a custom font, is that single font used instead of your pick?
4. Is there exactly 0–1 accent colors, saturation < 80%, no purple?
5. Are all names, numbers, and brand names creative and realistic (no "John Doe", no "Acme")?
6. Is mobile collapse handled via `@media (max-width: 767px)` in a `<style>` block?
7. Are hover/focus states defined in `<style>` (no transitions, just instant changes)?
8. Is there NO JavaScript, NO `<script>`, NO event handlers, NO `filter`, NO `transition`, NO `transform`, NO `animation`, NO `@keyframes`, NO `backdrop-filter`?
9. Are cards used only where elevation communicates hierarchy (not as default containers)?
10. Are all image URLs using `picsum.photos/seed/...` (no broken Unsplash links), and does EVERY spot that calls for a photo have a real `<img>`/`background-image` — no gradient or empty-div stand-ins?
11. Are all UI glyphs Phosphor icons (loaded via `@import`, one consistent weight)? NO emoji-as-icons and NO hand-drawn ad-hoc inline `<svg>` glyphs (inline SVG only for logos/illustrations)?
12. Is there NO device/OS chrome (per Device size presets) unless the user asked?
13. Is the HTML self-contained, complete, and renderable standalone?
14. If reference images were provided, is their style influence visible in the output (palette, typography, layout feel)?
15. If variables were provided in canvas context, are they defined in a `:root {}` block and referenced via `var()` throughout the HTML?