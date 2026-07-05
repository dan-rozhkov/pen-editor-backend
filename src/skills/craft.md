---
name: craft
description: Shape then build a feature end-to-end with production-grade craft.
args:
  - name: target
    description: The feature to build (optional)
    required: false
user-invokable: true
---

# Craft Flow

Build a feature with impeccable UX and UI quality: shape the design, land the visual direction, build real production code, inspect and improve in-browser until it meets a high-end studio bar.

Before writing code, you need: the project's product context loaded, register identified and the matching reference loaded, and a confirmed design direction for this task (either from `shape` or supplied by the user). The project's product context is project context, not a task-specific brief.

Treat any approved visual direction (generated mock or stated reference) as a concrete contract for composition, hierarchy, density, atmosphere, signature motifs, and distinctive visual moves. Don't let mocks replace structure, copy, accessibility, or state design. But if the live result lacks the approved direction's major ingredients, the implementation is wrong.

### Gates: do not compress

Craft has **multiple user gates**, not one. When the harness has native image generation, the gate sequence before code is:

1. **Shape brief confirmed** (Step 1)
2. **Direction questions answered** (Step 3)
3. **Palette confirmed** (Step 3)
4. **One mock direction approved or delegated** (Step 3)

You must stop at every gate. **Shape confirmation alone is NOT a green light to start coding.** It is the green light to begin the visual-direction flow in Step 3. Compressing gates 2 through 4 because the shape brief felt complete is the dominant failure mode of this flow.

When the harness lacks native image generation, gates 2-4 collapse into the brief itself, and shape confirmation does advance straight to code.

## Step 0: Project Foundation

Before shape, before code: figure out what kind of project you're working in.

Review the project's design system: its design tokens/variables (via the `get_variables` tool), existing scene nodes, and reusable components. Before adding anything new, understand:

- **The established visual conventions.** What tokens, variables, and spacing/type scales already exist? Respect them.
- **The existing components.** A component is a native `frame` node with `reusable: true` (NOT an embed) — `get_editor_state` returns them under `reusableComponents`/`documentComponents`. Check whether one already declares `properties` (variant/boolean/text) before adding a near-duplicate frame — switch a variant on an instance (`propertyValues`) instead of building a new component for a state that's just a different value of an existing property. Read what's there before adding to it; reuse before inventing.
- **The established iconography.** Use whatever icon approach the project already uses; don't introduce a second set.

**Design-System-Lock:** respect existing tokens, variables, and components before inventing new ones. Reach for a new token, component, or component property only when nothing existing fits, and say so when you do.

If the project is essentially empty (greenfield) and the foundation is genuinely undecided, don't pick a direction silently. {{ask_instruction}}, with sensible defaults framed by the brief. Ask once; don't re-ask mid-task.

## Step 1: Shape the Design

Run the `/shape` skill, passing along whatever feature description the user provided. Shape is **required** for craft; it is what produces a confirmed direction.

Present the shape output and stop. Wait for the user to confirm, override, or course-correct before writing code.

If the user already supplied a confirmed brief or ran shape separately, use it and skip this step.

When the original prompt + the project's product context already answer scope, content, and visual direction with no real ambiguity, the shape output can be **compact** (3-5 bullets stating what you're building and the visual lane, ending with one or two specific questions or "confirm or override"). The full 10-section structured brief is reserved for genuinely ambiguous, multi-screen, or stakeholder-heavy tasks. Don't pad a clear brief into a long one to look thorough; equally, don't skip the pause to look efficient.

If the harness has native image generation, a compact shape's "confirm or override" advances to **Step 3 and the visual-direction flow**, not to Step 4. Phrase the closing line accordingly: "Confirm or override; once we lock direction, I'll run a couple of palette and reference questions before generating any mocks." This stops the model from reading shape confirmation as code-green.

## Step 2: Load References

Based on the design brief's "Recommended References" section, consult the relevant reference skills. At minimum, always consult:

- The `/layout` skill for layout, spacing, grid, container queries, optical adjustments
- The `/typeset` skill for type hierarchy, font selection, web font loading, OpenType features

Then add references based on the brief's needs:
- Complex interactions or forms? Consult the project's interaction and form-design guidance
- Animation or transitions? Consult the `/animate` skill (motion materials, durations, easing, perceived performance)
- Color-heavy or themed? Consult the `/colorize` skill (OKLCH, palette structure, dark mode, contrast)
- Responsive requirements? Consult the `/adapt` skill (breakpoints, input methods, safe areas, responsive images)
- Heavy on copy, labels, or errors? Consult the `/clarify` skill (button labels, error formula, voice/tone, translation)

## Step 3: Visual Direction & Assets (Harness-Gated)

If the harness has **native image generation**, this step is mandatory. Run the visual-direction flow before any code:

- **A. Direction questions.** Ask the focused questions needed to lock direction (composition, atmosphere, signature moves) beyond what the brief already fixed.
- **B. Palette.** Generate and confirm a concrete palette, respecting existing design tokens/variables before introducing new ones.
- **C. Mock exploration.** Generate a small set of distinct direction mocks from the brief and palette.
- **D. Approval.** Get one mock direction approved (or explicitly delegated) before writing code.
- **E. Mock-fidelity inventory.** List the approved mock's major ingredients (hero objects, imagery, section structure, nav/CTA treatment, distinctive motifs) so you can verify them in the build.
- **F. Asset slicing.** Produce or source the real assets the mock implies.

Stop at each of gates A through D. Then return here for Step 4.

If the harness lacks native image generation, **state in one line that the visual-direction-by-generation step is being skipped because the harness lacks native image generation, then proceed**. The one-line announcement is required; it forces a conscious decision instead of letting the step quietly evaporate. The brief is your only visual reference. Implement directly from it, treating any named anchor references and the brief's "Design Direction" as the contract.

Whether you generated mocks or not: don't replace required imagery with generic cards, bullets, emoji, fake metrics, decorative CSS panels, or filler copy. Image-led briefs (restaurants, hotels, magazines, photography, hobbyist communities, food, travel, fashion, product) need real or sourced imagery in the build, not CSS scenery.

## Step 4: Build to Production Quality

**Precondition.** If Step 3's native image-generation flow applied, gates A through D must be complete before any code: questions answered, palette confirmed, mocks generated, one direction approved or delegated. **Do not mention implementation, file paths, or patch plans until that's done.** A confirmed shape brief is not enough; the model that compressed those gates is the model that already failed this flow.

Implement the feature following the design brief. Build in passes so structure, visual system, states, motion/media, and responsive behavior each get deliberate attention. The list below is the definition of done, not inspiration.

### Production bar

- **Real content.** No placeholder copy, placeholder images, dead links, fake controls, or unused scaffold at presentation time.
- **Preserve the approved mock's major ingredients.** Missing hero objects, world/product imagery, section structure, CTA/nav treatment, or distinctive motifs are blocking defects unless the user accepted the change.
- **Semantic first.** Real headings, landmarks, labels, form associations, button/link semantics, accessible names, state announcements where needed.
- **Deliberate spacing and alignment.** No default gaps, arbitrary margins, unbalanced whitespace, or accidental optical misalignment.
- **Intentional typography.** Chosen loading strategy, clear hierarchy, readable measure, stable line breaks, no overflow at any width.
- **Realistic state coverage.** Default, hover, focus-visible, active, disabled, loading, error, success, empty, overflow, long/short text, first-run.
- **Finished interaction quality.** Keyboard paths, touch targets, feedback timing, scroll behavior, state transitions, no hover-only functionality.
- **Coherent icon set.** Use the project's established set; otherwise pick one library or use accessible text. Don't mix.
- **Respect the design system.** Reuse existing tokens/variables and components; introduce new ones only when nothing existing fits, and keep them consistent with the established scale. When a state you need (hover/pressed/disabled/etc.) is a variant of an existing component, switch it via `propertyValues` on the instance instead of building a lookalike component.
- **Verify image URLs before referencing them.** Use image-search or web-fetch when available; guessed photo IDs ship as broken-image placeholders. Without verification, prefer fewer images you're confident about.
- **Optimized imagery and media.** Correct dimensions, useful alt text, lazy loading below the fold, modern formats when practical, responsive `srcset`/`picture` for raster, no referenced asset left missing.
- **Premium motion.** Use atmospheric blur, filter, mask, shadow, reveal when they improve the experience. Avoid casual layout-property animation, bound expensive effects, verify smoothness in-browser, respect reduced motion, and avoid choreography that blocks task completion.
- **Maintainable.** Reusable local patterns, clear component boundaries, project conventions. No rasterized UI text or one-off hacks when a local pattern exists.
- **Technically clean.** No console errors, no avoidable layout shift, no needless dependencies, no broken asset paths.
- **Ask when uncertain.** If a discovery materially changes the brief or approved direction, stop and {{ask_instruction}}. Don't guess.

## Step 5: Iterate Visually

Look at what you built like a designer would. Your eyes are whatever the harness gives you: a connected browser, a screenshotting tool, or asking the user. Use them for responsive testing (mobile, tablet, desktop minimum) and general visual validation.

If your tool returns a file path, read the PNG back into the conversation. A screenshot you didn't read doesn't count.

For long-form brand surfaces, inspect major sections individually. Thumbnails hide spacing, clipping, and cascade defects.

After the first pass, write an honest critique against the brief, the approved mock's major ingredients (hero silhouette, motifs, imagery, nav/CTA, density), and the frontend-design skill's DON'Ts. Patch material defects and re-inspect. **Don't invent defects to demonstrate iteration.** A confident "first pass clean, shipping" beats a fake fix.

Actively check: responsive behavior (composes, not shrinks), every state (empty / error / loading / edge), craft details (spacing, alignment, hierarchy, contrast, motion timing, focus), performance basics. The exit bar: defensible in a high-end studio review.

Detector or QA output is defect evidence only; never proof the work is finished.

## Step 6: Present

Present the result to the user:
- Show the feature in its primary state
- Summarize the browser/viewports checked and the most important fixes made after inspection
- Walk through the key states (empty, error, responsive)
- Explain design decisions that connect back to the design brief and, when used, the chosen north-star mock. Include any accepted deviations from the mock; do not hide unimplemented mock ingredients.
- Note any remaining limitations or follow-up risks honestly
- Ask: "What's working? What isn't?"
