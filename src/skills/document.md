---
name: document
description: Generate a design-system summary that captures the project's existing visual system.
args:
  - name: target
    description: Optional area or path to document (optional)
    required: false
user-invokable: true
---

Capture the current visual design system as a summary, so future turns and collaborators stay on-brand. There is no project filesystem: the deliverable is a design summary returned in chat, condensed into the opening HTML comment of the design's primary embed.

The summary follows the same shape as the community DESIGN.md format: an optional YAML-style token block, followed by up to eight markdown sections in a fixed order. **Tokens are normative; prose provides context for how to apply them.** Sections may be omitted when not relevant, but those present stay in the specified order and keep the canonical headings below.

## The token block: schema

The token block is the machine-readable layer. Keep it tight; every entry should correspond to a token the project actually uses.

```yaml
name: <project title>
description: <one-line tagline>
colors:
  primary: "#b8422e"
  neutral-bg: "#faf7f2"
  # ...one entry per extracted color; key = descriptive slug
typography:
  display:
    fontFamily: "Cormorant Garamond, Georgia, serif"
    fontSize: "clamp(2.5rem, 7vw, 4.5rem)"
    fontWeight: 300
    lineHeight: 1
    letterSpacing: "normal"
  body:
    # ...
rounded:
  sm: "4px"
  md: "8px"
spacing:
  sm: "8px"
  md: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-bg}"
    rounded: "{rounded.sm}"
    padding: "16px 48px"
  button-primary-hover:
    backgroundColor: "{colors.primary-deep}"
```

Rules that matter:

- **Token refs** use `{path.to.token}` (e.g. `{colors.primary}`, `{rounded.md}`). Components may reference primitives; primitives may not reference each other.
- **Colors accept any valid CSS color string.** Hex is the recommended default for portability, but preserve an incumbent `rgb()`, `hsl()`, `oklch()`, wide-gamut, or mixed-color value when it is the project's normative source. Never split the source of truth without explicit reason.
- **Component sub-tokens** are limited to 8 props: `backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height`, `width`. Shadows, motion, focus rings, backdrop-filter: describe those in prose in the Components section instead.
- **Scale keys are open-ended.** Use whatever names the project already uses (`oxblood-deep`, `surface-container-low`). Don't rename to generic defaults.
- **Variants are naming convention, not schema.** `button-primary` / `button-primary-hover` / `button-primary-active` as sibling keys.

## The markdown body: eight sections (canonical order)

1. `## Overview`
2. `## Colors`
3. `## Typography`
4. `## Layout`
5. `## Elevation & Depth`
6. `## Shapes`
7. `## Components`
8. `## Do's and Don'ts`

Omit irrelevant sections rather than filling them with invented rules. Put responsive layout in Layout, depth in Elevation & Depth, radius and form language in Shapes, and per-component behavior in Components.

## When to run

- A new-work exploration found a coherent incumbent visual system but no captured summary yet.
- The first implementation of a new world is complete and its provisional decisions need to be locked in.
- An existing summary (visible in an earlier chat turn or an embed's opening comment) is stale — the design has drifted.
- Before a large redesign, to capture the current state as a reference.

If a summary already exists (in the conversation or in an embed's opening comment), **do not silently overwrite it**. Show the user the existing summary and {{ask_instruction}} whether to refresh, overwrite, or merge.

## Two paths

- **Scan mode** (default): the design has variables, reusable components, or rendered nodes. Extract, then confirm descriptive language. Use when there's something on the canvas to analyze.
- **Seed mode**: the canvas is pre-implementation (nothing built yet). Gather five high-level answers, produce a minimal summary marked as a seed. Re-run in scan mode once there's something to extract.

Decide by scanning first (Scan mode Step 1). If the scan finds no variables, no reusable components, and no rendered nodes, offer seed mode; don't silently switch.

## Scan mode (approach C: auto-extract, then confirm descriptive language)

### Step 1: Find the design assets

Survey the project in priority order:

1. **Design variables**: read the project's design variables (via the `get_variables` tool). Record name, value, and role for each color, typography, spacing, radius, shadow, easing, and duration token. This is the primary source of truth for the design system.
2. **Existing scene nodes**: inspect the current scene graph for established visual conventions — the colors, type sizes, radii, and spacing that recur across frames and text nodes.
3. **Reusable components**: scan components — native `frame` nodes with `reusable: true` (`get_editor_state` returns them under `reusableComponents`, with an HTML snapshot for readability) — the main button, card, input, navigation, dialog patterns. Note any declared `properties` (variant/boolean/text axes) and default styles.
4. **Rendered output**: if browser automation tools are available, sample computed styles from key rendered elements (body, h1, a, button, card). This catches values that tokens miss.

### Step 2: Auto-extract what can be auto-extracted

Build a structured draft from the discovered tokens. For each token class:

- **Colors**: Group into Primary / Secondary / Tertiary / Neutral. If the project only has one accent, express it as Primary + Neutral; omit Secondary and Tertiary rather than inventing them.
- **Typography**: Map observed sizes and weights to a display / headline / title / body / label hierarchy. Note font-family stacks and the scale ratio.
- **Elevation**: Catalogue the shadow vocabulary. If the project is flat and uses tonal layering instead, that's a valid answer; state it explicitly.
- **Components**: For each common component (button, card, input, chip, list item, tooltip, nav), extract shape (radius), color assignment, hover/focus treatment, internal padding.
- **Layout + spacing**: Extract grid, container, breakpoint, rhythm, and density behavior into Layout.
- **Shapes**: Extract radius, corner, border, clipping, and recurring form behavior into Shapes.

### Step 2b: Stage the token block

From the auto-extracted tokens, draft the token block now (you'll open the summary with it in Step 4).

- **Colors**: one entry per extracted color. Key = descriptive slug (`oxblood-deep`, `editorial-magenta`, not `blue-800`). Value = whichever format the project treats as canonical. Don't split the source of truth.
- **Typography**: one entry per role (`display`, `headline`, `title`, `body`, `label`). Include only the props that are real for the project (`fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `fontFeature`, `fontVariation`).
- **Rounded / Spacing**: whatever scale steps the project actually uses, keyed by whatever scale name the project uses.
- **Components**: one entry per variant (`button-primary`, `button-primary-hover`, `button-ghost`). Reference primitives via `{colors.X}`, `{rounded.Y}`. If a variant needs a property the 8-prop set doesn't cover, describe it in the Components prose section instead.

Skip anything the project doesn't have. Empty scale keys or fabricated tokens pollute the summary.

### Step 3: Ask the user for qualitative language

The following require creative input that cannot be auto-extracted. Gather them together with {{ask_instruction}}:

- **Creative North Star**: a single named metaphor for the whole system ("The Editorial Sanctuary", "The Golden State Curator", "The Lab Notebook"). Offer 2-3 options that honor the visitor mode and audience.
- **Overview voice**: mood adjectives, aesthetic philosophy in 2-3 sentences, and any confirmed visual anti-reference.
- **Color character** (for auto-extracted colors): descriptive names ("Deep Muted Teal-Navy", not "blue-800"). Suggest 2-3 options per key color based on hue/saturation.
- **Elevation philosophy**: flat/layered/lifted. If shadows exist, is their role ambient or structural?
- **Component philosophy**: the feel of buttons, cards, inputs in one phrase ("tactile and confident" vs. "refined and restrained").

Carry a line from an earlier brief only when it is a durable commitment that actually constrains the visual system.

### Step 4: Write the summary

Open with the token block staged in Step 2b, then the markdown body using the canonical structure below.

```markdown
name: [Project Title]
description: [one-line tagline]
colors:
  # ... staged token block from Step 2b

# Design System: [Project Title]

## Overview

**Creative North Star: "[Named metaphor in quotes]"**

[2-3 paragraph holistic description: personality, density, and aesthetic philosophy. Start from the North Star and work outward. State only confirmed visual rejections. End with a short **Key Characteristics:** bullet list.]

## Colors

[Describe the palette character in one sentence.]

### Primary
- **[Descriptive Name]** (#HEX / oklch(...)): [Where and why this color is used. Be specific about context, not just role.]

### Secondary (optional; omit if the project has only one accent)
- **[Descriptive Name]** (#HEX): [Role.]

### Tertiary (optional)
- **[Descriptive Name]** (#HEX): [Role.]

### Neutral
- **[Descriptive Name]** (#HEX): [Text / background / border / divider role.]
- [...]

### Named Rules (optional, powerful)
**The [Rule Name] Rule.** [Short, forceful prohibition or doctrine, e.g. "The One Voice Rule. The primary accent is used on ≤10% of any given screen. Its rarity is the point."]

## Typography

**Display Font:** [Family] (with [fallback])
**Body Font:** [Family] (with [fallback])
**Label/Mono Font:** [Family, if distinct]

**Character:** [1-2 sentence personality description of the pairing.]

### Hierarchy
- **Display** ([weight], [size/clamp], [line-height]): [Purpose; where it appears.]
- **Headline** ([weight], [size], [line-height]): [Purpose.]
- **Title** ([weight], [size], [line-height]): [Purpose.]
- **Body** ([weight], [size], [line-height]): [Purpose. Include max line length like 65–75ch if relevant.]
- **Label** ([weight], [size], [letter-spacing], [case if uppercase]): [Purpose.]

### Named Rules (optional)
**The [Rule Name] Rule.** [Short doctrine about type use.]

## Layout

[Describe the grid or spatial model, container behavior, density, responsive changes, and the spacing rhythm. Include exact values only when observed.]

## Elevation & Depth

[One paragraph: does this system use shadows, tonal layering, or a hybrid? If "no shadows", say so explicitly and describe how depth is conveyed instead.]

### Shadow Vocabulary (if applicable)
- **[Role name]** (`box-shadow: [exact value]`): [When to use it.]
- [...]

### Named Rules (optional)
**The [Rule Name] Rule.** [e.g. "The Flat-By-Default Rule. Surfaces are flat at rest. Shadows appear only as a response to state (hover, elevation, focus)."]

## Shapes

[Describe the form language: corner/radius strategy, borders, clipping, and any recurring silhouette or geometry.]

## Components

For each component, lead with a short character line, then specify shape, color assignment, states, and any distinctive behavior.

### Buttons
- **Shape:** [radius described, exact value in parens]
- **Primary:** [color assignment + padding, in semantic + exact terms]
- **Hover / Focus:** [transitions, treatments]
- **Secondary / Ghost / Tertiary (if applicable):** [brief description]

### Chips (if used)
- **Style:** [background, text color, border treatment]
- **State:** [selected / unselected, filter / action variants]

### Cards / Containers
- **Corner Style:** [radius]
- **Background:** [colors used]
- **Shadow Strategy:** [reference Elevation section]
- **Border:** [if any]
- **Internal Padding:** [scale]

### Inputs / Fields
- **Style:** [stroke, background, radius]
- **Focus:** [treatment, e.g. glow, border shift, etc.]
- **Error / Disabled:** [if applicable]

### Navigation
- **Style, typography, default/hover/active states, mobile treatment.**

### [Signature Component] (optional; if the project has a distinctive custom component worth documenting)
[Description.]

## Do's and Don'ts

Concrete visual guardrails grounded in the incumbent implementation or the user's chosen world. Lead each with "Do" or "Don't" and include exact values only when established.

### Do:
- **Do** [specific prescription with exact values / named rule].
- **Do** [...]

### Don't:
- **Don't** [specific prohibition confirmed by the incumbent system or the user].
- **Don't** [...]
- **Don't** [...]
```

### Step 5: Deliver and confirm

1. Show the user the full summary you wrote in chat. Briefly highlight the non-obvious creative choices (descriptive color names, atmosphere language, named rules).
2. Condense the token block plus the Overview and Do's and Don'ts into the opening HTML comment of the design's primary embed, so the next turn (yours or another agent's) sees it without a reload.
3. Offer to refine any section: "Want me to revise a section, add component patterns I missed, or adjust the atmosphere language?"

Your own write is the freshest source; subsequent commands in this session don't need a reload.

## Seed mode

For projects with no visual system to extract yet. Produces a user-chosen visual-world scaffold, not a fabricated token spec.

### Step 1: Route through new-work's workshop

If the target surface has no established visual direction yet, load `/new-work` and resolve visual authority there first: run its **Create or replace the visual world** flow, then **Commit the world**, so the visual world and its first expression are chosen together. Stop after the directional summary; do not implement.

If `/new-work` already completed the workshop in this session, use its chosen direction directly. Do not ask again.

### Step 2: Write the seed summary

Use the canonical section order from Scan mode. Populate the selected workshop direction and leave unresolved implementation facts as honest placeholders. The seed commits a world and its invariants; it does not pretend implementation tokens already exist.

Lead the summary with:

```markdown
<!-- SEED: established with the user before implementation; re-run /document once there's something built to capture the actual tokens and components. -->
```

Per-section guidance in seed mode:

- **Overview**: the chosen design thesis, layout behavior, material character, imagery stance, motion grammar, and reusable signature.
- **Colors**: the selected palette strategy and roles. Include values only when the user or `/new-work`'s exploration established them; otherwise mark them `[to be resolved during implementation]`.
- **Typography**: the selected type character and role relationship. Include font names only when established; otherwise mark the pairing `[to be resolved during implementation]`.
- **Layout**: the selected spatial grammar and responsive behavior, without pretending exact measurements are settled.
- **Elevation & Depth**: the selected material and depth behavior, stated as an invariant rather than inferred from a generic preset.
- **Shapes**: the selected form and corner language.
- **Components**: omit entirely; no components exist yet.
- **Do's and Don'ts**: record the durable guardrails confirmed during the world choice, not task-local refusals.

Seed mode writes a minimal token block with `name` and `description` only; no colors, typography, rounded, spacing, or components yet. Real tokens land on the next Scan-mode run.

### Step 3: Confirm

1. Show the seed summary in chat. Call out that it is a seed (the marker is the literal commitment).
2. Tell the user: "Re-run `/document` once you have some code. That pass will extract real tokens."

Your own write is the freshest source; no reload needed.

## Style guidelines

- **Tokens first, prose second.** Tokens go in the token block; prose contextualizes them. Don't redefine a token value in two places; the token block is normative.
- **Carry only durable constraints.** A binding logo, identity asset, accessibility need, or brand commitment from an earlier brief may constrain the summary. Task-specific strategy stays local to that task.
- **Match the canonical structure.** Use the eight sections in order and omit any that are irrelevant. Put motion guidance with the world or component it affects rather than creating a section the structure does not support.
- **Descriptive > technical**: "Gently curved edges (8px radius)" > "rounded-lg". Include the technical value in parens, lead with the description.
- **Functional > decorative**: for each token, explain WHERE and WHY it's used, not just WHAT it is.
- **Exact values in parens**: hex codes, px/rem values, font weights; always the number in parens alongside the description.
- **Use Named Rules**: `**The [Name] Rule.** [short doctrine]`. These are memorable, citable, and much stickier for AI consumers than bullet lists. Aim for 1-3 per section.
- **Be decisive where evidence is decisive.** Use hard language for actual invariants and softer language for provisional guidance.
- **Use concrete audit tests only when they are grounded in the observed system or a confirmed user decision.** A one-sentence test beats a paragraph of principle.
- **Group colors by role**, not by hex-order or hue-order. Primary / Secondary / Tertiary / Neutral is the canonical ordering.

## Pitfalls

- Don't paste raw CSS class names. Translate to descriptive language.
- Don't extract every token. Stop at what's actually reused; one-offs pollute the system.
- Don't invent components that don't exist. If the project only has buttons and cards, only document those.
- Don't overwrite an existing summary without asking.
- Don't rename sections even slightly. "Colors" not "Color Palette & Roles". "Typography" not "Typography Rules".
- Don't duplicate token values between the token block and prose. If a color is in `colors.primary` as hex, the prose can name it and describe its role but should not reassert a different hex. The token block is normative.
- Don't invent token groups outside the schema (no `motion:`, `breakpoints:`, `shadows:` at the top level). Carry those in prose, in the relevant section, instead.

## Quality floor

Verify before shipping: contrast (body/placeholder ≥4.5:1, large ≥3:1; tint secondary text from the surface hue, never gray); depth (shadows carry offset + soft blur, never a zero-offset colored halo); spacing (tight groups, generous separation, more space above a heading than below it); type (measure 65–75ch, display ≤6rem, tracking floor −0.04em, real copy at every breakpoint with no overflow); one authored motion (exponential ease-out from an already-visible default, not scattered effects); real states (hover/disabled/loading/error/empty); honest copy (product's own language; controls name their action, errors name problem + recovery).

Refuse by default (the brief can earn any of them): identical-card grids, the hero-metric template, an eyebrow over every section, decorative section numbers, a reflexive modal, gradient text, glassmorphism-as-decoration, colored side-stripe borders over 1px, decorative sparklines/progress-rings/soft-shadow rounded-rects standing in for content, mono-as-"technical", theme picked by category instead of use-scene, the ghost card (1px border under a wide soft shadow), sketchy/doodle SVG grain, and animating an image on hover instead of its container.

Full floor lives in the `frontend-design` skill.
