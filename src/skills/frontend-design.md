---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications. Generates creative, polished code that avoids generic AI aesthetics.
license: Apache 2.0. Based on Anthropic's frontend-design skill. See NOTICE.md for attribution.
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

## Design Direction

Commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work—the key is intentionality, not intensity.

Then implement working code that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

### Typography

Choose a font that is beautiful, unique, and interesting. Default to a SINGLE distinctive family for the whole design and build hierarchy with weight, size, and color. Add a second family only when the user explicitly asks or the content genuinely justifies it (e.g. literal code needing a mono face).

**DO**: Use a modular type scale with fluid sizing (clamp)
**DO**: Vary font weights and sizes to create clear visual hierarchy
**DON'T**: Use overused fonts—Inter, Roboto, Arial, Open Sans, system defaults
**DON'T**: Mix multiple typefaces by default—one family, varied by weight/size, reads as more intentional
**DON'T**: Use monospace typography as lazy shorthand for "technical/developer" vibes
**DON'T**: Use emoji as icons—load a real icon set (e.g. the Phosphor web font, or an inline SVG set for bespoke aesthetics), never an emoji where a UI glyph belongs
**DON'T**: Put large icons with rounded corners above every heading—they rarely add value and make sites look templated

### Color & Theme

Commit to a cohesive palette. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.

**DO**: Use modern CSS color functions (oklch, color-mix, light-dark) for perceptually uniform, maintainable palettes
**DO**: Tint your neutrals toward your brand hue—even a subtle hint creates subconscious cohesion
**DON'T**: Use gray text on colored backgrounds—it looks washed out; use a shade of the background color instead
**DON'T**: Use pure black (#000) or pure white (#fff)—always tint; pure black/white never appears in nature
**DON'T**: Use the AI color palette: cyan-on-dark, purple-to-blue gradients, neon accents on dark backgrounds
**DON'T**: Use gradient text for "impact"—especially on metrics or headings; it's decorative rather than meaningful
**DON'T**: Default to dark mode with glowing accents—it looks "cool" without requiring actual design decisions

### Layout & Space

Create visual rhythm through varied spacing—not the same padding everywhere. Embrace asymmetry and unexpected compositions. Break the grid intentionally for emphasis.

**DO**: Create visual rhythm through varied spacing—tight groupings, generous separations
**DO**: Use fluid spacing with clamp() that breathes on larger screens
**DO**: Use asymmetry and unexpected compositions; break the grid intentionally for emphasis
**DON'T**: Wrap everything in cards—not everything needs a container
**DON'T**: Nest cards inside cards—visual noise, flatten the hierarchy
**DON'T**: Use identical card grids—same-sized cards with icon + heading + text, repeated endlessly
**DON'T**: Use the hero metric layout template—big number, small label, supporting stats, gradient accent
**DON'T**: Center everything—left-aligned text with asymmetric layouts feels more designed
**DON'T**: Use the same spacing everywhere—without rhythm, layouts feel monotonous

### Visual Details
**DO**: Use intentional, purposeful decorative elements that reinforce brand
**DON'T**: Use glassmorphism everywhere—blur effects, glass cards, glow borders used decoratively rather than purposefully
**DON'T**: Use rounded elements with thick colored border on one side—a lazy accent that almost never looks intentional
**DON'T**: Use sparklines as decoration—tiny charts that look sophisticated but convey nothing meaningful
**DON'T**: Use rounded rectangles with generic drop shadows—safe, forgettable, could be any AI output
**DON'T**: Use modals unless there's truly no better alternative—modals are lazy

### Motion

Focus on high-impact moments: one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions.

**DO**: Use motion to convey state changes—entrances, exits, feedback
**DO**: Use exponential easing (ease-out-quart/quint/expo) for natural deceleration
**DO**: For height animations, use grid-template-rows transitions instead of animating height directly
**DON'T**: Animate layout properties (width, height, padding, margin)—use transform and opacity only
**DON'T**: Use bounce or elastic easing—they feel dated and tacky; real objects decelerate smoothly

### Interaction

Make interactions feel fast. Use optimistic UI—update immediately, sync later.

**DO**: Use progressive disclosure—start simple, reveal sophistication through interaction (basic options first, advanced behind expandable sections; hover states that reveal secondary actions)
**DO**: Design empty states that teach the interface, not just say "nothing here"
**DO**: Make every interactive surface feel intentional and responsive
**DON'T**: Repeat the same information—redundant headers, intros that restate the heading
**DON'T**: Make every button primary—use ghost buttons, text links, secondary styles; hierarchy matters

### Responsive

**DO**: Use container queries (@container) for component-level responsiveness
**DO**: Adapt the interface for different contexts—don't just shrink it
**DON'T**: Hide critical functionality on mobile—adapt the interface, don't amputate it

### UX Writing

**DO**: Make every word earn its place
**DON'T**: Repeat information users can already see

---

## The AI Slop Test

**Critical quality check**: If you showed this interface to someone and said "AI made this," would they believe you immediately? If yes, that's the problem.

A distinctive interface should make someone ask "how was this made?" not "which AI made this?"

Review the DON'T guidelines above—they are the fingerprints of AI-generated work from 2024-2025.

---

## Implementation Principles

Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices across generations.

Remember: {{model}} is capable of extraordinary creative work. Don't hold back—show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

---

## Quality Floor

Load this after the direction is settled, and build without announcing the checklist. A pinned brief or the committed visual world overrides anything here; your own habit does not.

### Verify

Each of these is a check on the built result, not an intention.

- **Contrast:** body and placeholder text ≥4.5:1, large text ≥3:1. On colored surfaces tint secondary text from that hue or the foreground; never gray.
- **Depth:** shadows carry an offset and a soft blur. A zero-offset colored halo is decoration.
- **Spacing:** tight groups, generous separation, more space above a heading than below it. Read the computed values.
- **Type:** body measure 65–75ch, display max 6rem, tracking floor -0.04em (-0.02 to -0.03em usually reads better), balanced headings, obvious scale and weight steps. Run the real copy at every breakpoint and fix what overflows.
- **Motion:** one authored moment, not scattered effects and not one identical entrance on every section. Exponential ease-out from an already-visible default. Reach past transform and opacity: blur, backdrop-filter, clip-path, mask, and shadow belong to the palette when they stay smooth.
- **States:** hover, disabled, loading, error, empty. Plus real content, working controls, responsive composition, keyboard focus.
- **Copy:** the product's own language. Controls name their action; errors name the problem and the recovery.
- **Coverage:** every brief requirement present and findable within seconds.

### Refuse

These are the category's defaults, not bans: the brief's own words can earn any of them. Reaching for one when the axis is free means you were not deciding; recognizing that means rewriting the element, not softening it.

Page scaffolds:

- Same-size cards of icon plus heading plus text as the page structure. Cards are the lazy container; nested cards are always wrong.
- The hero-metric template: big number, small label, supporting stats, accent.
- A tracked uppercase eyebrow over every section. One named kicker is a system; an eyebrow everywhere is grammar you did not choose.
- Section numbers (01 / 02 / 03) unless the sequence itself carries information the reader needs.
- A modal for a task that needs neither interruption nor protected focus.

Surface habits:

- Gradient text. Emphasis comes from weight or size.
- Glass and blur as decoration rather than as a specific effect.
- A colored `border-left` or `border-right` above 1px on cards, list items, callouts, or alerts.
- Sparklines, progress rings, and soft-shadowed rounded rectangles standing in for content.
- Monospace as a costume for "technical" rather than for code, data, or measurement.
- Light or dark picked by category. Pick it from the use scene: who, where, under what ambient light.
- Declare elevation once, border or shadow. A 1px border under a wide soft shadow is the ghost card. Card radii stay at 12–16px; pills are for small controls.
- Real illustration or none. Sketch-style SVG scenes, doodle-style class names, and `feTurbulence` grain read as amateur.
- Backgrounds are surfaces, textured only from the subject's world. `repeating-linear-gradient` stripes and two-axis grid overlays need an actual canvas, map, blueprint, or measuring tool under them.
- Never animate an image on hover, directly or through its parent. It is not an action target. Give the container the feedback.

### Calibration (anti-default self-check)

Name the AI-cluster looks so you can catch yourself reaching for one by reflex: warm cream + high-contrast serif + terracotta/signal-red; near-black + one neon accent + glow; broadsheet hairlines + italic serif + tracked mono labels. Where the brief leaves the aesthetic free, if someone could guess your aesthetic from the category alone, rework it. Book, warm, or child-oriented subjects do not license cream+serif by default. A brief-pinned world pins the world itself, not its softest, safest rendition.

The floor holds the mechanics; it never picks the direction. With every check green, spend the page on the committed world; when torn between refined and committed, commit.
