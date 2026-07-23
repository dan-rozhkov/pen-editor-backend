---
name: animate
description: Add purposeful motion and animation to an interface.
args:
  - name: target
    description: The feature or component to animate (optional)
    required: false
user-invokable: true
---

> **Additional context needed**: performance constraints.

Use motion to explain state, relationship, and hierarchy, or to create one authored moment the surface has earned. Decoration without purpose is animation debt.

---

## Visitor mode

- **Persuade + Experience:** motion may carry the voice. Prefer one rehearsed focal sequence to repeated section reveals.
- **Operate + Read:** motion serves feedback, state, and continuity. Keep routine transitions fast and do not make users wait through page-load choreography.

## Find the job

Inspect the existing motion language, interaction states, target devices, and performance budget. Find only the places where motion would:

- acknowledge an action;
- make a state change or spatial relationship legible;
- preserve continuity through navigation or layout change;
- direct attention at a meaningful moment;
- embody the selected visual world.

If any of this can't be inferred from context, STOP and {{ask_instruction}} to clarify. Do not animate a static area merely because it exists.

## Set the motion thesis

Write a short plan before implementation:

- **Focal moment:** the one sequence or interaction that deserves authorship, if any.
- **Continuity:** the state, layout, or navigation changes that need explanation.
- **Feedback:** the controls and outcomes that need acknowledgment.
- **Budget:** which effects may be expensive and how often they run.

The focal moment must come from this product and surface concept. A generic fade-and-rise, hover lift, parallax layer, or scroll reveal is not a thesis.

Respect the project's design system (design tokens/variables, existing components, and established visual conventions) before inventing new motion. Reuse any established duration/easing tokens where they exist; only add new motion primitives when the current system can't express the effect.

## Choose material by meaning

Transform and opacity are reliable foundations, not the entire palette. Choose properties for what the transition communicates:

- **Continuity and relationship:** shared-element motion, FLIP-style transforms, view transitions, or deliberate spatial movement.
- **Focus and depth:** bounded blur, filter, backdrop, light, or shadow changes.
- **Reveal and composition:** masks, clip paths, cropping, or controlled occlusion.
- **Material and energy:** color, gradient position, texture, or distortion effects when the world and runtime support them.
- **State and feedback:** the smallest change that makes cause and result unmistakable.

Do not stack techniques for spectacle. One strong material idea, carried through the focal sequence and quiet supporting states, is usually enough.

Sibling stagger is appropriate when a list appears as a list (cards-in-a-grid, list-items-appearing). Cap the total delay (e.g. 10 items at 50ms each = 500ms total), and never reinterpret every scrolled section as a staggered list.

## Timing and easing

Timing should express distance and consequence:

| Duration | Typical use |
|---|---|
| 100–150 ms | immediate feedback |
| 150–300 ms | routine state change |
| 300–500 ms | layout, overlay, or view transition |
| 500–800 ms | a deliberately authored focal entrance |

Exit faster than entrance (~75% of the enter duration). Use natural deceleration such as `cubic-bezier(0.16, 1, 0.3, 1)` for confident arrivals; do not use bounce or elastic curves by reflex — they feel dated and draw attention to the animation itself. Long feedback feels like latency; keep feedback under ~500ms.

## Implement to the runtime

- Use CSS transitions and keyframes for declarative state and bounded sequences.
- Use the Web Animations API or the project's existing motion library for interruption, sequencing, and dynamic values.
- Use View Transitions or shared-element techniques when continuity across states is the point.
- Use scroll-driven motion only when the scroll relationship itself carries meaning, with a robust fallback.
- Do not add a dependency for an effect the existing stack can express cleanly.

Keep content visible in the default state so a failed script does not hide the page. Avoid casually animating layout-driving properties such as `width`, `height`, `top`, `left`, and margins; use FLIP, transforms, or grid techniques when appropriate. Bound blur, filter, and shadow work to isolated regions, add `will-change` only during known animation (never preemptively across the whole page), and measure on target viewports and devices rather than assuming transform means fast. Use Intersection Observer instead of scroll event listeners for scroll triggers, and unobserve after the animation fires once.

### Perceived performance

Nobody cares how fast your site *is*, only how fast it feels. The ~80ms threshold: anything under that feels instant. Start transitions immediately while loading, show content progressively rather than waiting for everything, and use optimistic UI for low-stakes actions only (never payments or destructive operations).

## Accessibility and control

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Respect `prefers-reduced-motion` with an intentional alternative that still preserves state change and hierarchy — a blanket `0.01ms` kill that destroys useful feedback is itself a violation. Respect autoplay and sound preferences. Any nonessential loop must stop when offscreen or hidden.

## Verify

- The focal motion is specific to the selected world and surface.
- Every supporting animation explains feedback, state, or relationship.
- Interruption and repeated use behave correctly.
- Desktop, mobile, and keyboard paths remain usable.
- Expensive effects stay smooth (60fps) on the target device.
- Removing an animation would lose meaning or authored character, not merely decoration.
- `prefers-reduced-motion` is respected with a real alternative, not a blanket kill.

When motion earns its place, hand off to the `/polish` skill for the final pass.

## Quality floor

**Verify**
- Contrast: any text revealed or moved by motion still meets ≥4.5:1 body / ≥3:1 large-text contrast once settled; secondary text is tinted from the surface hue, never generic gray.
- Depth: shadows used for lift or focus need an offset plus soft blur; a zero-offset colored halo is not a shadow.
- Spacing: motion must not disturb tight-group/generous-separation rhythm — more space above a heading than below it, at rest.
- Type: measure stays 65–75ch and tracking floor -0.04em once animated text settles.
- Motion: exactly one authored focal moment per surface; everything else is feedback, continuity, or state — never decoration on every section.
- States: hover, disabled, loading, error, and empty states all have real (not merely implied) transitions.
- Copy: motion never substitutes for honest, specific copy about what happened.

**Refuse**
- Scroll-triggered fade-and-rise on every section, bounce/elastic easing, and animating an image on hover instead of giving its container the feedback.

Full floor lives in the `frontend-design` skill.
