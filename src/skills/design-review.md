---
name: design-review
description: Review a frame or screen against the style guide and guidelines, dropping a comment pin on every finding instead of writing a wall of chat text.
args:
  - name: target
    description: The frame, screen, or area to review (optional; defaults to the current selection or screen)
    required: false
  - name: scope
    description: What to focus the review on, e.g. "contrast", "typography" (optional; defaults to a full pass)
    required: false
---

A design review that lives on the canvas, not in the chat. Every finding becomes a
`leave_comment` pin anchored to the exact node it's about — a paragraph in chat can't
point at anything, a pin can.

## 1. Resolve the target

- If `target` is given, resolve it to a concrete frame or node.
- Otherwise use the current selection; if nothing is selected, use the frame the user
  is currently looking at (from `get_editor_state`).
- Call `get_editor_state` and `batch_get` (with enough `readDepth`) to read the full
  subtree you're reviewing: node types, text content, colors, spacing, hierarchy.

## 2. Load the standards before judging anything

Call these **before** forming any opinion — every finding must be checkable against
one of them:

- `get_guidelines` for the relevant topics (at least `design-system`; add others if
  `scope` points at them).
- `get_style_guide` (and `get_style_guide_tags` if you need to find the right tags)
  for this project's actual color, type, and spacing rules.

Do not rely on generic taste. A finding with no guideline or style-rule behind it does
not belong in this review — drop it.

## 3. Review systematically

Walk the subtree and check, per `scope` (or all of these if no scope was given):

- **Contrast**: text vs. background combinations against the style guide's palette;
  flag anything under the guideline's minimum ratio.
- **Typography**: font sizes/weights/line-heights against the defined text styles;
  flag ad-hoc values that don't match an established style.
- **Spacing**: padding/gaps against the guideline's spacing scale; flag arbitrary or
  inconsistent values, especially inconsistent gaps between visually similar rows.
- **Consistency**: repeated components (cards, buttons, list rows) that drifted from
  each other — mismatched corner radius, spacing, or color where they should match.

For each real finding, note: the exact `nodeId`, what's wrong, and which guideline or
style rule it violates.

## 4. File findings as one batched `leave_comment` call

Collect every finding first, then place them in a **single** `leave_comment` call —
never one call per finding, the array is the point:

```
leave_comment({ comments: [
  { nodeId: "<nodeId>", text: "Contrast 3.1:1 against the card background — style guide requires 4.5:1 for body text (see Colors)." },
  { nodeId: "<nodeId>", text: "20px gap here vs. 16px on the sibling rows above — breaks the spacing scale's consistency rule." },
  { nodeId: "<nodeId>", text: "This button uses 6px corner radius; every other primary button in this screen uses 8px." }
]})
```

- Each comment must be specific and actionable: name the exact deviation and the rule
  it breaks, not a vague "this looks off."
- Use `nodeId` whenever the finding is about a specific layer (almost always). Only
  fall back to `x`/`y` if there's genuinely no single node to anchor to.
- Do not flag anything you can't justify against `get_guidelines` or `get_style_guide`
  output — if you're unsure whether something is a real violation, leave it out rather
  than guess.

## 5. Report back

After the call returns, tell the user the thread numbers so they can jump straight to
them, e.g. "Left 6 notes on the checkout screen: #12-#17 — 2 contrast issues, 3
spacing inconsistencies, 1 corner-radius mismatch." Keep the chat summary short; the
pins carry the detail.

**NEVER**:
- Leave a comment you can't tie to a specific guideline or style rule.
- Make one `leave_comment` call per finding — batch them.
- Write the review as chat prose instead of pins when a node is available to anchor to.
