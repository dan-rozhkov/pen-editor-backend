---
name: typeset
description: Improve typography: hierarchy, font pairing, scale, and rhythm for an existing interface.
args:
  - name: target
    description: The feature or component to improve typography for (optional)
    required: false
user-invokable: true
---

Typography carries most of the information on the page, along with hierarchy and voice. Improve it inside the established visual world; do not replace the identity unless the user asked to.

---

## Visitor mode

- **Persuade + Experience**: display type may carry the voice. Use decisive contrast and, for marketing/content pages, fluid `clamp()` scale (≥1.25 ratio between steps).
- **Operate + Read**: stability, scanability, and measure come first. A single well-tuned family and a fixed `rem` scale (1.125–1.2 ratio between more closely-spaced steps) are often right; system fonts and familiar sans stacks are legitimate here.

If a typography change would replace the established identity rather than improve its use, that's a `/new-work` decision, not a typeset one — hand off there instead of quietly picking a new direction. Otherwise preserve the confirmed families and improve how they're used.

## Assess Current Typography

Analyze what's weak or generic about the current type. Answer each with a node, style, or computed value, not an impression:

1. **Authority and fit**:
   - Are we using invisible defaults? (Inter, Roboto, Arial, Open Sans, system defaults)
   - Does the font match the brand personality, or is it an unexamined default?
   - Are there too many font families? (More than 2-3 is almost always a mess; is every family necessary?)

2. **Hierarchy**:
   - Can heading, body, label, and metadata roles be distinguished at a glance?
   - Are font sizes too close together to carry different jobs? (14px, 15px, 16px = muddy hierarchy)
   - Are weight contrasts strong enough? (Medium vs Regular is barely visible)

3. **Scale and consistency**:
   - Is there a deliberate type scale, or are sizes arbitrary?
   - Do repeated roles stay identical across screens and states?
   - Is the sizing strategy appropriate for the context? (Fixed `rem` scales for app UIs; fluid `clamp()` for marketing/content headings)

4. **Reading**:
   - Does body copy stay within a comfortable 45–75 character measure?
   - Is line-height tuned to the actual face, width, and context, not a universal ratio?
   - Is there enough contrast between text and background?

5. **Stress**:
   - What happens with long headings, localization expansion, zoom, narrow containers, missing weights, and font fallback?

6. **Delivery**:
   - Are only the used weights actually loaded (each weight adds to page load)?
   - Do fallback metrics and loading strategy avoid invisible text and disruptive reflow?

**CRITICAL**: The goal isn't to make text "fancier." It's to make it clearer, more readable, and more intentional. Good typography is invisible; bad typography is distracting.

## Set the System

Before editing, state:

- the roles the interface needs;
- the intended contrast between those roles;
- the reading measure and density;
- which existing faces and weights are authoritative;
- any performance or accessibility constraints.

Respect the project's design system (design tokens/variables, existing components, and established visual conventions) before inventing new type tokens. Reuse the existing font families, size ramp, and weight roles where they exist; only introduce new ones when the current system genuinely can't carry the hierarchy. Use the fewest roles and families that make the hierarchy unmistakable — combine size, weight, space, and tone deliberately instead of asking size alone to do all the work. Name tokens semantically (`--text-body`, `--text-heading`), not by value (`--font-size-16`).

## Improve Typography Systematically

### Font Selection

If fonts genuinely need replacing (not a `/new-work` identity change, just a better execution of the current one):
- Choose fonts that reflect the established brand personality
- Pair with genuine contrast (serif + sans, geometric + humanist), or use a single family in multiple weights — a second font is only worth adding when it earns real contrast
- A technical/utilitarian brief does not need a serif "for warmth"; a premium/editorial brief does not need the same expressive serif everyone else is reaching for; a children's product does not need a rounded display font. The training-data-default faces (Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, Space Grotesk, Space Mono, IBM Plex, Inter-as-display, DM Sans, DM Serif, Outfit, Plus Jakarta Sans, Instrument Sans) are worth a second thought before reaching for them by reflex — the full reflex-reject list and selection procedure live in the `/new-work` skill.
- System fonts (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`) are underrated for Operate/Read surfaces: native feel, instant load, highly readable.
- Ensure web font loading doesn't cause layout shift (`font-display: swap`, metric-matched fallbacks)

### Establish Hierarchy

Build a clear type scale:
- **5 sizes cover most needs**: caption, secondary, body, subheading, heading
- **Use a consistent ratio** between levels (1.25, 1.333, or 1.5) and commit to it
- **App UIs**: fixed `rem`-based scale, optionally adjusted at 1-2 breakpoints — fluid sizing undermines the spatial predictability dense, container-based layouts need
- **Marketing / content pages**: fluid sizing via `clamp(min, preferred, max)` for headings and display text; keep body text fixed even here, since the size difference across viewports is too small to warrant fluidity. Bound the clamp to `max-size ≤ ~2.5 × min-size` so zoom and reflow stay sane

### Fix Readability

- Set `max-width` on text containers using `ch` units (`max-width: 65ch`)
- Tune line-height to the face, width, language, and contrast, not a universal ratio: tighter for headings (1.1-1.2), looser for body (1.5-1.7)
- Compensate light-on-dark text on all three perceptual axes together: bump line-height (0.05–0.1), add a touch of letter-spacing (0.01–0.02em), and consider one step more weight — the perceived weight drops across all three, so fix all three
- Ensure body text is at least 16px / 1rem
- Use paragraph spacing OR first-line indentation as the paragraph rhythm, never both

### Refine Details

- Use `tabular-nums` for data tables and numbers that should align
- Apply proper `letter-spacing`: 5–12% for short all-caps labels and eyebrows (capitals sit too close at default spacing); default or tight for large display text
- Set `font-kerning: normal` and consider OpenType features (`font-variant-numeric`, `font-variant-caps`) where appropriate
- `font-optical-sizing: auto` lets variable fonts pick the right optical-size master automatically

### Weight Consistency

- Define clear roles for each weight and stick to them across screens and states
- Don't use more than 3-4 weights (Regular, Medium, Semibold, Bold is plenty)
- Load only the weights actually used

**NEVER**:
- Use more than 2-3 font families
- Pick sizes arbitrarily; commit to a scale
- Set body text below 16px
- Use decorative/display fonts for body text
- Disable browser zoom (`user-scalable=no`)
- Use `px` for font sizes; use `rem` to respect user settings
- Default to Inter/Roboto/Open Sans when personality matters
- Pair fonts that are similar but not identical (two geometric sans-serifs)
- Make type decorative at the expense of comprehension

## Verify

- **Hierarchy**: primary, secondary, body, and metadata roles are recognizable without reading the copy.
- **Readability**: body copy stays comfortable across relevant widths; long headings, localization expansion, and zoom don't break it.
- **Consistency**: same-role elements are styled identically throughout.
- **Belonging**: the typography belongs to the product and its established visual world — it wasn't quietly replaced.
- **Delivery**: loading does not create disruptive reflow or invisible text.
- **Accessibility**: text meets WCAG contrast ratios and is zoomable to 200%.

Answer each item against the rendered result, not from memory. When the type carries the hierarchy on its own, hand off to `/polish` for the final pass.

## Quality floor

- **Contrast**: body/placeholder text ≥4.5:1, large text ≥3:1; tint secondary text from the surface hue, never plain gray.
- **Depth**: shadows carry an offset and a soft blur — a zero-offset colored halo is decoration, not elevation.
- **Spacing**: tight groups, generous separation, more space above a heading than below it.
- **Type**: measure 65–75ch, display ≤6rem, tracking floor −0.04em (−0.02 to −0.03em usually reads better), balanced headings, real copy at every breakpoint with no overflow.
- **Motion**: one authored moment, exponential ease-out from an already-visible default — not scattered effects.
- **States**: hover, disabled, loading, error, empty all implemented with real content.
- **Copy**: the product's own language; controls name their action, errors name the problem and the recovery.

Full floor, plus the font selection procedure and reflex-reject list referenced above, live in the `/new-work` skill and the `frontend-design` hub.
