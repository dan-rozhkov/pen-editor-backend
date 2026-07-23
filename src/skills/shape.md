---
name: shape
description: Plan the UX/UI of a feature before writing code.
args:
  - name: target
    description: The feature to shape (optional)
    required: false
user-invokable: true
---

Discover what should be made and how it should work, then return a confirmed design brief without code.

**Scope**: Design planning only. This command does NOT write code. It produces the thinking that makes code good. The user can then take the brief straight into `/prototype`, or use it to guide any implementation approach.

## Phase 1: Discovery interview

Do not write code or choose a visual direction yet. That decision belongs to `/new-work`, not to this command.

### Cadence

- {{ask_instruction}} and stop for the answers.
- Ask two or three related questions per round, then wait. One round is the default; add a second only when the answers expose a material gap.
- Do not dump a questionnaire, repeat settled facts, or turn obvious facts into a menu. Assert the likely reading and invite correction: "This reads as a settings page, confirm?" beats a four-option menu when the answer is already clear.
- A sparse prompt requires at least one answer round. Do not synthesize a complete brief for confirmation on the first response. A precise prompt may need only a compact confirmation.

### Round 1: purpose, people, and outcome

Choose the two or three questions that most change the result:

- What is this surface or feature for, and what problem must it solve?
- Who specifically reaches it, in what situation and state of mind (rushed, exploring, anxious, focused)?
- What is the primary thing they must understand or do? What would success look like?
- What is uniquely true here that a neighboring product or generic template could not claim?

### Round 2: material, behavior, and boundaries

Run only for material unresolved decisions:

- What real content, evidence, data, and assets must the experience carry? What are realistic minimum, typical, and maximum ranges (e.g. 0 items, 5 items, 500 items)?
- Which states and transitions matter: first-run, empty, loading, error, success, permissions, overflow, or expert use?
- What is the intended fidelity, breadth, and interactivity — sketch, mid-fi, high-fi, production-ready; one screen, a flow, or a whole surface; static, interactive, or shipped-quality?
- What must remain untouched? What would make the result feel wrong even if it looked polished?
- Which platform, performance, accessibility, or localization constraints are binding?

Never ask for color strategy, theme, or named visual references here. Visual-world and concept choices belong to `/new-work`, not to shape.

## Phase 2: Resolve the design direction

For a new surface, a brand expansion, or a replacement of the existing look, hand off to the **`/new-work`** skill to pick the committed visual direction (color strategy, theme, named anchor references, direction contract) before any brief is finalized. Reuse this discovery instead of re-asking; return here afterward with the chosen direction before writing the brief.

Inside an already-established visual world, skip `/new-work` and resolve any remaining composition or interaction questions directly in this discovery.

## Phase 3: Write the brief

Write the smallest useful brief:

1. **Job and audience**: who arrives, their context, need, and the visitor mode (Persuade / Operate / Read / Experience) for this surface.
2. **Outcome and proof**: primary task/action, what success looks like, and what real evidence or content needs to appear (no invented prices, customers, or benchmarks).
3. **Selected direction**: the visual direction from `/new-work` if one was run — color strategy, theme sentence, anchor references — or a note that the existing visual world carries forward unchanged.
4. **Scope and boundaries**: fidelity, breadth, interactivity, what remains untouched, and explicit anti-goals.
5. **States and ranges**: realistic content/data ranges and every material state (empty, loading, error, success, edge cases).
6. **Interaction and layout**: hierarchy, topology, responsiveness, affordances, feedback, and transitions as intent — not CSS.
7. **Constraints and open decisions**: platform, accessibility, localization, reusable components/tokens to prefer, and choices a builder must not invent.

Use three to five bullets when the task is settled; use the full structure only for ambiguous, multi-screen, or standalone planning requests. Don't pad a clear brief into a long one to look thorough, and don't restate the conversation.

## Confirm and stop

Present the brief and **end your response**. The user must confirm before any implementation runs, even when the brief feels obviously right to you. Do not present a brief and then continue to code in the same response.

If the user disagrees with any part, revisit the relevant discovery questions. A shape run is incomplete until the user confirms direction.

When no explicit confirmation mechanism is available, mark assumptions plainly, return the brief, and stop regardless.

## Quality floor

Whatever gets built from this brief still has to clear the baseline every surface holds to:

- **Contrast**: body/placeholder text ≥4.5:1, large text ≥3:1; tint secondary text from the surface hue, never plain gray.
- **Depth**: shadows carry an offset and a soft blur — a zero-offset colored halo is decoration, not elevation.
- **Spacing**: tight groups, generous separation, more space above a heading than below it.
- **Type**: measure 65–75ch, display ≤6rem, tracking floor −0.04em (−0.02 to −0.03em usually reads better).
- **Motion**: one authored moment, exponential ease-out from an already-visible default — not scattered effects.
- **States**: hover, disabled, loading, error, empty all implemented with real content.
- **Copy**: the product's own language; controls name their action, errors name the problem and the recovery.

Full floor lives in the `frontend-design` skill; a shape brief should name which states and content ranges the builder needs so the floor is checkable later.
