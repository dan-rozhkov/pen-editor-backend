---
name: operate
description: Deeper guidance for Operate and Read surfaces — task completion, scanability, native affordances, comprehension and wayfinding. Load when designing app UI, dashboards, editors, settings, docs, or guides.
args: []
---

When design SERVES the product: app UIs, admin dashboards, settings panels, data tables, tools, authenticated surfaces — anything where the visitor is in a task. This file is extended depth for **Operate** surfaces (see `new-work` and the `frontend-design` hub for the essentials and the shared quality floor). **Read** surfaces (docs, guides, long-form) take the same typography and consistency rules here; their prose measure and navigation matter more than component density.

## The product-slop test

Familiarity is often a feature here. The test is whether a category-fluent user can trust the interface immediately or must pause at every subtly-off component.

Product UI's failure mode isn't flatness, it's strangeness without purpose: over-decorated buttons, mismatched form controls, gratuitous motion, display fonts where labels should be, invented affordances for standard tasks. The bar is earned familiarity. The tool should disappear into the task.

## Typography

- **One family is often right.** Product UIs don't need display/body pairing. A well-tuned sans carries headings, buttons, labels, body, data.
- **Fixed rem scale, not fluid.** Clamp-sized headings don't serve product UI. Users view at consistent DPI, and a fluid h1 that shrinks in a sidebar looks worse, not better.
- **Tighter scale ratio.** 1.125–1.2 between steps is typical. More type elements here than on marketing surfaces; exaggerated contrast creates noise.
- **Line length still applies for prose** (65–75ch). Data and compact UI can run denser; tables at 120ch+ are fine.

## Color

Product defaults to Restrained (see the color-strategy section of `new-work`). A single surface can earn Committed (a dashboard where one category color carries a report, an onboarding flow with a drenched welcome screen), but Restrained is the floor.

- State-rich semantic vocabulary: hover, focus, active, disabled, selected, loading, error, warning, success, info. Standardize these.
- Accent color used for primary actions, current selection, and state indicators only, not decoration.
- A second neutral layer for sidebars, toolbars, and panels (slightly cooler or warmer than the content surface).

## Layout

- Responsive behavior is structural (collapse sidebar, responsive table, breakpoint-driven columns), not fluid typography.

## Components

Every interactive component has: default, hover, focus, active, disabled, loading, error. Don't ship with half of these.

- Skeleton states for loading, not spinners in the middle of content.
- Empty states that teach the interface, not "nothing here."
- Consistent affordances across the surface. Same button shape. Same form-control vocabulary. Same icon style. When document components exist (`documentComponents` from `get_editor_state`), reuse their `c-*` tags for every matching element instead of inventing a parallel one.
- Overlays escape their container. An absolutely positioned dropdown inside an `overflow: hidden` or `overflow: auto` ancestor gets clipped; reach for `<dialog>`, the popover API, `position: fixed`, or a portal-equivalent structure.

## Motion

- 150–250 ms on most transitions. Users are in flow; don't make them wait for choreography.
- Motion conveys state, not decoration. State change, feedback, loading, reveal: nothing else.
- No orchestrated page-load sequences. Product loads into a task; users don't want to watch it load.

## Product constraints (refuse by default)

- Decorative motion that doesn't convey state.
- Inconsistent component vocabulary across screens. If the "save" button looks different in two places, one is wrong.
- Display fonts in UI labels, buttons, data.
- Reinventing standard affordances for flavor (custom scrollbars, weird form controls, non-standard modals).
- Heavy color or full-saturation accents on inactive states.
- Modal as first thought. Modals are usually laziness. Exhaust inline / progressive alternatives first.

## Product permissions

Product can afford things marketing surfaces can't:

- System fonts and familiar sans defaults.
- Standard navigation patterns: top bar + side nav, breadcrumbs, tabs, command palettes.
- Density. Tables with many rows, panels with many labels, dense information when users need it.
- Consistency over surprise. The same visual vocabulary screen to screen is a virtue; delight is saved for moments, not pages.
