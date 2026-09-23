---
name: normalize
description: Normalize design to match your design system and ensure consistency
args:
  - name: feature
    description: The page, route, or feature to normalize (optional)
    required: false
user-invokable: true
---

Analyze and redesign the feature to perfectly match our design system standards, aesthetics, and established patterns.

## Plan

Before making changes, deeply understand the context:

1. **Discover the design system**: Read what the canvas already establishes: `get_variables`, `get_styles`, `get_text_styles`, `search_all_unique_properties` (the values actually in use), and existing reusable components. Study them until you understand:
   - Core design principles and aesthetic direction
   - Target audience and personas
   - Component patterns and conventions
   - Design tokens (colors, typography, spacing)
   
   **CRITICAL**: If something isn't clear, ask. Don't guess at design system principles.

2. **Analyze the current feature**: Assess what works and what doesn't:
   - Where does it deviate from design system patterns?
   - Which inconsistencies are cosmetic vs. functional?
   - What's the root cause—missing tokens, one-off implementations, or conceptual misalignment?

3. **Create a normalization plan**: Define specific changes that will align the feature with the design system:
   - Which components can be replaced with design system equivalents?
   - Which styles need to use design tokens instead of hard-coded values?
   - How can UX patterns match established user flows?
   
   **IMPORTANT**: Great design is effective design. Prioritize UX consistency and usability over visual polish alone. Think through the best possible experience for your use case and personas first.

## Execute

Systematically address all inconsistencies across these dimensions:

- **Typography**: Use design system fonts, sizes, weights, and line heights. Replace hard-coded values with typographic tokens or classes.
- **Color & Theme**: Apply design system color tokens. Remove one-off color choices that break the palette.
- **Spacing & Layout**: Use spacing tokens (margins, padding, gaps). Align with grid systems and layout patterns used elsewhere.
- **Components**: Replace custom implementations with design system components. Ensure props and variants match established patterns.
- **Motion & Interaction**: Match animation timing, easing, and interaction patterns to other features.
- **Responsive Behavior**: Ensure breakpoints and responsive patterns align with design system standards.
- **Accessibility**: Verify contrast ratios, focus states, ARIA labels match design system requirements.
- **Progressive Disclosure**: Match information hierarchy and complexity management to established patterns.

**NEVER**:
- Create new one-off components when design system equivalents exist
- Hard-code values that should use design tokens
- Introduce new patterns that diverge from the design system
- Compromise accessibility for visual consistency

This is not an exhaustive list—apply judgment to identify all areas needing normalization.

## Clean Up

After normalization, tidy up:

- **Consolidate**: if you created something that should be shared, make it a reusable component or a variable/style rather than a one-off.
- **Remove leftovers**: delete nodes, styles, or variables that normalization made obsolete (`replace_all_matching_properties` for repeated literal values).
- **Verify**: re-read the changed nodes (`batch_get`, or `get_screenshot` when available) and confirm nothing outside scope changed.
