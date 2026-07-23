---
name: extract
description: Extract and consolidate reusable components, design tokens, and patterns into your design system. Identifies opportunities for systematic reuse and enriches your component library.
args:
  - name: target
    description: The feature, component, or area to extract from (optional)
    required: false
user-invokable: true
---

# Extract Flow

Identify reusable patterns, components, and design tokens, then extract and consolidate them into the design system for systematic reuse.

## Step 1: Discover the Design System

Find the design system: review the project's design system (design tokens/variables, existing components, and established visual conventions). Understand its structure: component organization, naming conventions, design token structure, import/export conventions.

**CRITICAL**: If no design system exists, STOP and {{ask_instruction}} to clarify before creating one. Understand the preferred location and structure first.

## Step 2: Identify Patterns

Look for extraction opportunities in the target area:

- **Repeated components**: Similar UI patterns used 3+ times (buttons, cards, inputs)
- **Hard-coded values**: Colors, spacing, typography, shadows that should be tokens
- **Inconsistent variations**: Multiple implementations of the same concept
- **Composition patterns**: Layout or interaction patterns that repeat (form rows, toolbar groups, empty states)
- **Type styles**: Repeated font-size + weight + line-height combinations
- **Animation patterns**: Repeated easing, duration, or keyframe combinations

Assess value: only extract things used 3+ times with the same intent. Premature abstraction is worse than duplication.

## Step 3: Plan Extraction

Create a systematic plan:

- **Components to extract**: Which UI elements become reusable components?
- **Tokens to create**: Which hard-coded values become design tokens?
- **Variants to support**: What variations does each component need?
- **Naming conventions**: Component names, token names, prop names that match existing patterns
- **Migration path**: How to refactor existing uses to consume the new shared versions

**IMPORTANT**: Design systems grow incrementally. Extract what is clearly reusable now, not everything that might someday be reusable.

## Step 4: Extract & Enrich

Build improved, reusable versions:

- **Components**: Clear props API with sensible defaults, proper variants for different use cases, accessibility built in (ARIA, keyboard navigation, focus management), documentation and usage examples
- **Design tokens**: Clear naming (primitive vs semantic), proper hierarchy and organization, documentation of when to use each token
- **Patterns**: When to use this pattern, code examples, variations and combinations

## Step 5: Migrate

Replace existing uses with the new shared versions:

- **Find all instances**: Search for the patterns you extracted
- **Replace systematically**: Update each use to consume the shared version
- **Test thoroughly**: Ensure visual and functional parity
- **Delete dead code**: Remove the old implementations

## Step 6: Document

Update design system documentation:

- Add new components to the component library
- Document token usage and values
- Add examples and guidelines
- Update any Storybook or component catalog

**NEVER**:
- Extract one-off, context-specific implementations without generalization
- Create components so generic they are useless
- Extract without considering existing design system conventions
- Skip proper TypeScript types or prop documentation
- Create tokens for every single value (tokens should have semantic meaning)
- Extract things that differ in intent (two buttons that look similar but serve different purposes should stay separate)

## Quality floor

Verify before shipping: contrast (body/placeholder ≥4.5:1, large ≥3:1; tint secondary text from the surface hue, never gray); depth (shadows carry offset + soft blur, never a zero-offset colored halo); spacing (tight groups, generous separation, more space above a heading than below it); type (measure 65–75ch, display ≤6rem, tracking floor −0.04em, real copy at every breakpoint with no overflow); one authored motion (exponential ease-out from an already-visible default, not scattered effects); real states (hover/disabled/loading/error/empty); honest copy (product's own language; controls name their action, errors name problem + recovery).

Refuse by default (the brief can earn any of them): identical-card grids, the hero-metric template, an eyebrow over every section, decorative section numbers, a reflexive modal, gradient text, glassmorphism-as-decoration, colored side-stripe borders over 1px, decorative sparklines/progress-rings/soft-shadow rounded-rects standing in for content, mono-as-"technical", theme picked by category instead of use-scene, the ghost card (1px border under a wide soft shadow), sketchy/doodle SVG grain, and animating an image on hover instead of its container.

Full floor lives in the `frontend-design` skill.
