---
name: polish
description: Final quality pass before shipping. Fixes alignment, spacing, consistency, and detail issues that separate good from great.
args:
  - name: target
    description: The feature or area to polish (optional)
    required: false
user-invokable: true
---

> **Additional context needed**: quality bar and shipping constraints.

Polish is the final pass before shipping — refinement, never concealed redesign. Preserve the incumbent visual world, content, behavior, and everything outside scope. If the concept itself is wrong, say so and recommend redesign or the `/bolder` skill instead of smuggling in a replacement.

Automated QA output is defect evidence, not proof of quality. A clean automated result is never proof that the design is strong; inspect the rendered experience and the real interaction path.

## 1. Establish the system

Review the project's design system — design tokens/variables (the `get_variables` tool), existing scene nodes, and reusable component embeds. If no formal system exists, use the coherent conventions already visible in the scene.

Classify each drift before fixing it:

- **missing token**: the system needs a reusable value that doesn't exist yet;
- **one-off implementation**: an existing shared component or pattern should replace it;
- **conceptual mismatch**: the flow, information architecture, or hierarchy differs from comparable areas of the product;
- **local defect**: the implementation is simply incomplete or inconsistent.

Fix the cause at the narrowest correct level: patch the value, swap to the shared component, or rework the flow. Fixing the symptom without naming the cause is how drift compounds. **If anything about the system is ambiguous, {{ask_instruction}}. Never guess at design system principles.**

## 2. Gather the evidence

Use the feature yourself before touching anything. Determine:

- whether the path is functionally complete;
- the intended quality bar and time available (MVP vs flagship, how much time for polish);
- known constraints or deliberately unfinished work (mark with TODOs);
- the states, content lengths, roles, and input methods users will actually encounter.

If `/critique` has been run on the same target, its priority findings are a useful prior for what to address first — fold any relevant P0/P1 items into your polish list. The critique is one input among many; do your own pass either way.

## 3. Triage

Separate functional defects from cosmetic ones and fix in this order:

1. broken or blocked tasks, data loss, misleading state, and inaccessible paths;
2. missing loading, empty, error, success, disabled, and permission states;
3. flow, hierarchy, responsive, and design-system drift;
4. visual and motion inconsistencies;
5. code and asset cleanup.

When polish time is tight, functional issues ship first; cosmetic ones can land in a follow-up. Do not perfect one corner while leaving the rest below the same quality bar.

## 4. Polish the whole path

### Flow and hierarchy

- Match neighboring mental models, terminology, disclosure, routing, save behavior, and optimistic vs pessimistic patterns.
- Make the primary task and current state obvious without flattening every element to equal weight.
- Ensure arrival, transition, empty, and recovery paths connect instead of behaving as isolated screens.

### Layout and type

- Align to the project's grid and spacing scale; fix optical as well as mathematical alignment.
- Group related content tightly and separate distinct groups generously.
- Keep same-role typography consistent; check measure, wrapping, and font loading (no FOUT/FOIT).
- Verify every supported viewport rather than correcting only the current screenshot.

### Color, imagery, and icons

- Use semantic tokens and stable color meanings across themes.
- Verify text, control, and focus contrast in every state. Never put gray text on a colored background; use a shade of that color or transparency instead.
- Keep icon families, stroke/weight, sizing, and optical alignment coherent.
- Prevent image layout shift; use correct aspect ratios and useful alt text.

### Interaction and state

- Every control needs appropriate default, hover, focus, active, disabled, loading, error, and success behavior. Missing states create confusion and broken experiences.
- Preserve visible keyboard focus, logical tab order, labels, and touch targets (44×44px minimum).
- Keep motion coherent, interruptible, and performant (`ease-out-quart/quint/expo`, never bounce or elastic). Do not add animation merely to make polish visible; respect reduced motion.
- Validate long, missing, and edge-case content wherever the product can encounter it.

### Content and code

- Keep terminology, capitalization, punctuation, and factual copy consistent. Ask before changing claims.
- Remove debug output, dead code, unused imports, obsolete styles, and any duplication polish itself introduced.
- Replace custom implementations with shared components where the system already owns the pattern.
- Promote genuinely reusable values to tokens; don't create a system abstraction for one local exception.

## 5. Verify and finish

Walk the complete path again with mouse, keyboard, and touch where applicable. Check:

- mobile, intermediate, and wide layouts;
- loading, empty, error, success, disabled, long-content, and missing-content states;
- zoom, contrast, focus, and semantics;
- layout shift, interaction latency, image loading, and console warnings;
- agreement with the design system, neighboring features, and the user's scope.

Run any relevant automated QA checks that are available and fix their real defects, but treat a clean scan as a floor, not proof — never cite it as evidence the work is polished. Fix real defects and document only narrow, intentional exceptions.

Finish with a source diff: remove accidental churn, orphaned code, redundant values, and temporary artifacts. Ship only when the feature is functionally complete and consistently finished across the whole path.

**NEVER**:
- Polish before it's functionally complete
- Polish without aligning to the design system; that's decoration on drift
- Guess at design system principles when something is ambiguous — {{ask_instruction}} instead
- Introduce bugs while polishing
- Perfect one thing while leaving others rough
- Create new one-off components when design system equivalents exist
- Hard-code values that should use design tokens

## Quality floor

The final pass still has to clear the baseline every surface holds to, on top of everything above:

- **Contrast**: body/placeholder text ≥4.5:1, large text ≥3:1; tint secondary text from the surface hue, never plain gray.
- **Depth**: shadows carry an offset and a soft blur — a zero-offset colored halo is decoration, not elevation.
- **Spacing**: tight groups, generous separation, more space above a heading than below it.
- **Type**: measure 65–75ch, display ≤6rem, tracking floor −0.04em (−0.02 to −0.03em usually reads better).
- **Motion**: one authored moment, exponential ease-out from an already-visible default — not scattered effects.
- **States**: hover, disabled, loading, error, empty all implemented with real content.
- **Copy**: the product's own language; controls name their action, errors name the problem and the recovery.

Full floor lives in the `frontend-design` skill.
