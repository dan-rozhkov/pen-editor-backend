---
name: first-draft
description: Generate a first draft of a whole screen from a one-sentence description — picks a template, defines variables, and builds real structure from native nodes with auto-layout.
args:
  - name: description
    description: One-sentence description of the screen to design (optional — will be asked for if omitted)
    required: false
  - name: platform
    description: Target platform: mobile or desktop (optional — inferred from the description if omitted)
    required: false
user-invokable: true
---

Turn one sentence into a complete, structurally sound screen — a Figma "First Draft" analog. Speed matters, but the result must be a real, editable screen: native nodes, auto-layout, variables — never a single embed blob.

**CRITICAL**: All new content MUST be built from native canvas nodes (frame/text/rectangle/ellipse/etc.) using `batch_design`. Do NOT insert `embed` nodes. This skill only makes sense in `edits`-mode nodes; if you find yourself reaching for `type: "embed"`, stop and rebuild the section with frames instead.

---

## 1. Clarify the Brief (skip if already clear)

From the user's one sentence, extract:
- **What screen** (settings, dashboard, landing page, onboarding, checkout, profile, ...)
- **Platform**: `mobile` or `desktop`. If not stated, infer from context (e.g. "app screen", "settings page" → mobile; "dashboard", "landing page", "admin panel" → desktop). If genuinely ambiguous, {{ask_instruction}} rather than guessing.
- **Key content/sections** implied by the request (e.g. "a settings screen with account and notification options" implies at least two sections plus a header)

Don't over-clarify — a single reasonable assumption per missing detail is fine. Only stop and ask when the platform or core purpose is truly unclear.

### Frame size presets

| Platform | Width | Height |
|----------|-------|--------|
| mobile   | 390   | 844 (use `height: "fit_content(844)"` so it grows with content) |
| desktop  | 1440  | 1024 (use `height: "fit_content(1024)"` so it grows with content) |

## 2. Check Existing Foundations First

1. **`get_editor_state`** — see what's already on the canvas: existing components (`reusableComponents`), the current selection, and file structure. Reuse matching components (buttons, cards, nav bars) via `ref` instances instead of rebuilding them.
2. **`get_variables`** — read existing design tokens (colors, spacing, radius). You MUST call this before `batch_design`.
3. **`get_text_styles`** — read existing typography tokens.
4. **`get_guidelines`** with `topic: "design-system"` (and `topic: "landing-page"` if the screen is a landing page) — apply the sizing/auto-layout rules and layout patterns it returns.
5. **`get_style_guide_tags`** then **`get_style_guide`** (tags matching platform/industry/style implied by the brief) — use this for a consistent color/type/spacing direction, especially if variables are sparse or absent.

## 3. Define Variables First

If the file has no (or very few) relevant variables, create a small, deliberate set with `set_variables` BEFORE building the screen — do not hardcode colors/spacing/radius/font once variables exist for them:

- **Colors**: `--background`, `--foreground`, `--primary`, `--muted-foreground`, `--border`, `--card` (or reuse existing equivalents — never invent a second token for the same concept)
- **Spacing**: a small scale, e.g. `--space-sm` (8), `--space-md` (16), `--space-lg` (24), `--space-xl` (32)
- **Radius**: `--radius-m` (8-12), `--radius-pill` (9999) as needed
- **Font**: reuse an existing text style via `get_text_styles`/`apply_text_style` where possible; otherwise pick one clear heading font and one body font

Skip this step only if the file already has a complete, matching token set — reuse it exactly (never rewrite a variable's name or casing).

## 4. Build the Screen Structure

Build with `batch_design`, root-first, section-by-section (never everything in one call if it risks exceeding 25 operations):

1. **Root frame**: `layout: "vertical"`, `width`/`height` from the platform preset above, `alignItems: "stretch"` (unless the design calls for centered content), background from a variable.
2. **Header / nav section**: title or logo, plus navigation or back action, as its own auto-layout frame (`horizontal` for a top bar, `vertical` for a mobile nav stack).
3. **Hero / primary content section(s)**: the core content implied by the brief (form fields, list, cards, chart placeholder, etc.), each its own auto-layout frame with sensible `gap`/`padding`.
4. **Actions section**: primary/secondary buttons or CTAs, placed where the platform convention expects them (bottom-fixed-feeling stack on mobile, inline in a card or top-right on desktop).

Rules while building:
- Set `width`/`height` explicitly on every auto-layout frame (`fill_container` / `fit_content` / a fixed size) — never leave layout frames at default fixed pixel sizes.
- Set `alignItems` and `justifyContent` on every `layout` frame (default to `"center"`/`"center"` unless the section clearly needs otherwise, e.g. `justifyContent: "space-between"` for a nav bar).
- Reuse existing components via `ref` instances wherever one matches (button, input, card, nav item) instead of recreating them from frame/text/rectangle.
- Bind every color/spacing/radius/font value to a variable or text style from steps 2-3 — do not hardcode a hex color or magic-number spacing/radius once a matching token exists.
- Give every frame a descriptive `name` (e.g. "Header", "Account Section", "Primary Actions") so the layer tree reads clearly.
- Use `placeholder: true` on frames you're still populating within the same task, and clear it when the section is finished.

## 5. Self-Check

- Re-read the structure with `snapshot_layout` using `problemsOnly: true` to surface clipping/overflow, and use `batch_get` to spot-check the sizes/positions of the key frames. Look for: overlapping elements, text overflowing its container, missing background/contrast, inconsistent spacing between sections.
- Fix anything obviously broken with follow-up `batch_design` calls (adjust `gap`/`padding`/`width`/`height`, not a full rebuild).
- If `get_screenshot` is available in this session, use it on the root frame as a final visual confirmation — otherwise the `snapshot_layout` check above is sufficient.

## 6. Wrap Up

In your final reply: name the screen you built, the platform/size used, and the sections it contains, in 2-3 short sentences. Do not restate the full mini-script or list every operation.
