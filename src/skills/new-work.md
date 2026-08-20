---
name: new-work
description: Playbook for making a NEW surface or replacing a visual world — pick a committed visual direction (world), write the direction contract, prove-don't-claim, before building. Load when starting a fresh screen/page/flow with no established look to inherit.
args: []
---

Use this flow when making a new surface (a screen, page, or flow with no established look to inherit) or when deliberately replacing an existing visual world. On our surface a "surface" is an `embed` node's `htmlContent`; "build" means generating that HTML via `batch_design`. There is no filesystem — the only durable record of a decision is the direction contract written into the artifact's own opening HTML comment, plus whatever the canvas (`get_editor_state`, existing components/variables) already establishes.

## 1. Decide what is already true

Check `get_editor_state` for existing components, variables, and fonts before inventing anything.

- **Redesign:** preserve product truth, content, function, and any explicit constraints the user stated; replace the old visual world rather than polishing it. The old look is evidence of what the subject is, not authority over what it becomes.
- **Established world:** inherit it. A coherent identity already present in existing components/variables is not erased just because nothing wrote it down; match it rather than inventing a replacement.
- **Incomplete system:** preserve confirmed assets and recognizable traits (existing components, variables, fonts), then expand the system for this new surface.
- **No visual authority:** create a new world with the user (this is the common case for a first prototype).

A section, component, feature, or state inside an established surface inherits that surface. Do not turn a local addition into a new identity exercise — extend it, don't re-decide it.

## 2. Ask what will change the work

Ask one round of two or three related questions via `ask_user` when the brief leaves them open. Skip settled facts; a precise request may need only a compact confirmation.

- **Persuade** (visitor decides/acts — landing, marketing, pricing): clarify who must act, what they should believe, and which real proof, content, or assets can earn that belief.
- **Operate** (visitor completes a task — app UI, dashboards, editors, settings): clarify the task, information, important states, frequency, and constraints. For depth on this mode, load `operate`.
- **Read** (visitor understands — docs, guides): clarify the reader's question, source material, structure, and wayfinding. Load `operate` for its typography/consistency notes, which apply here too.
- **Experience** (visitor is inside the work — portfolios, galleries): clarify what leads, how exploration unfolds, and which interaction or transition matters.

Across modes, ask what success looks like, what must remain untouched, and what would make a polished result feel wrong. Do not ask for CSS values or canned aesthetic lanes — those are decisions this skill makes, not the user.

## 3. Choose the right amount of invention

### Extend an existing surface

Inherit its world and composition. Resolve only the new purpose, content, hierarchy, states, interaction, and how the addition joins the surrounding experience. Do not re-run the direction decision below for a local extension or a precisely specified narrow request — shape it directly.

### Create or replace the visual world

1. Name the product's unique mechanism in one sentence, the audience's real scene, its cultural home, and what this first surface must prove. Note the page this category always ships (and its predictable "opposite") — name both as the rut and keep them out of the candidate list below, so no candidate is spent on the page the category already ships.
2. **Search real references before proposing or rendering a direction.** When reference-search tools are available, load the `research` skill and follow its bounded flow: run 1–2 focused queries, inspect 3–4 strong screens, and extract structure, composition, typography, color, image treatment, and a distinctive detail from each. Search the actual surface, interaction, or relevant visual tradition — not only the product category and never vague mood words. Use `web_search` / `fetch_url` as a fallback when dedicated reference tools are unavailable. If no search tool is available or every call errors, continue without references rather than blocking the work. Do not call image generation — including `/visualize` — until this search is complete.
3. From that cultural world and the reference findings, list **5–7 concrete visual worlds** — systems, artifacts, places, or rituals the audience knows by heart — each with one line on why it resonates and can carry the mechanism, ordered by resonance. The audience's world includes its graphic and screen traditions too: notation, publications, identity programs, data graphics, and interfaces it reads daily, not only its physical objects. A nameable abstract system (a school of poster design, a documentation standard, a data-graphic tradition) is as concrete a candidate as any physical artifact. Ask: what would this thing look like as a physical object; what did its world look like before the web? Near-duplicates count once. **When more than three of the candidates share one material family, the derivation stopped at the subject's most obvious artifact** — the audience's world is larger than that; keep going until the list spans at least three distinct material families, and exclude the category's predictable default.
4. Turn that material into complete directions: each joins a reusable visual world to a concrete first-surface experience.
5. Commit to **ONE** direction, fully worked out: its world, first viewport, visitor path, signature interaction, and honest risk. Do not present a ranked menu of several safe, self-generated candidates — a lineup like that invites the user (or you) to pick the safest card. Alongside the committed direction, offer 1–2 named alternates with a one-line case each, plus a **"play it straight / category standard"** escape hatch.
6. The escape hatch is the user's door, never yours: never recommend it, never let it soften the committed direction. If the user takes it, ask once for two or three products this should sit alongside, make their craft level the bar, and execute that standard at full fidelity, without irony or smuggled quirk.

For **Persuade**, the opening must make the offer intelligible and desirable, expose a clear action, and demonstrate something only this product can prove — a hook that lands in one line, a visible primary action, a legible reading order. For **Operate**, expression may never obscure the task, state, or familiar affordance. For **Read**, comprehension and wayfinding remain intact. For **Experience**, the work itself leads from the first viewport.

Every direction under consideration must already be viable: every relationship and claim it visualizes true, workable at full-surface scale within the available assets and tools. A candidate that fails on truth is replaced, never rescued after the fact.

**Truth binds claims, not demonstrations.** In greenfield work, author whatever illustrative content the concept needs at full fidelity — names, copy, entries, thumbnails — and label it synthetic wherever a visitor could mistake it for the real thing. What stays uninventable are commercial and factual claims: prices, customers, benchmarks, endpoints, capabilities the product does not have. Refusing a bold direction because its demonstration data does not exist yet is the timidity reflex wearing honesty's clothes.

## 4. Commit the world

Pick a color strategy before picking colors:
- **Restrained** — neutrals plus one accent; the default when the visitor came to operate or read.
- **Committed** — one saturated color carries 30–60% of the surface.
- **Full palette** — 3–4 named roles.
- **Drenched** — the surface IS the color.

Persuade and Experience surfaces have permission for the bolder strategies; take them when the brief allows. Color commits at page scale: fields that own whole regions, not accents scattered over a neutral ground. Dark or light is never a default — write one sentence of physical scene (who uses this, where, under what light) and let it force the answer.

Choose fonts like objects from the subject's world, in the mode's register. Operate and Read surfaces are well served by system stacks and workhorse UI faces; Persuade and Experience surfaces want faces with a point of view. These are training-data defaults — reaching for one means you stopped looking, and naming one anyway requires a reason no other face could satisfy (a subject association like "books want a serif" or "tech wants a mono" is never that reason):

Fraunces, Playfair Display, Cormorant, Lora, Crimson, Newsreader, Syne, Space Grotesk, Space Mono, IBM Plex, Inter-as-display, DM Sans, DM Serif, Outfit, Plus Jakarta Sans, Instrument Sans.

**Calibration:** AI-generated interfaces cluster around a few looks regardless of subject — warm cream ground with a high-contrast serif display and a terracotta/signal-red accent; near-black with one neon accent and glowing edges; broadsheet-editorial hairlines with an italic display serif and small tracked mono labels. All are legitimate when the brief calls for them; the brief always wins. Where the brief leaves the aesthetic free, landing in one of them means the self-check failed — if someone could guess your aesthetic from the category alone, rework until that's no longer true. A bookish, warm, or child-facing subject does not license cream+serif by default: book cloth, thread, jackets, endpapers, and shelf ephemera span the whole saturated spectrum, and cream paper is only the smallest corner of that world. A brief-pinned world pins the world, not its softest rendition — the pinned world's full material range stays in play.

## 5. Record the decision

Before building, state the chosen direction as a contract in the artifact's opening HTML comment, five short blocks, **150 words at most**:
- **THESIS** — the one idea this surface owns, and the category-default arrangement it refuses.
- **OWN-WORLD** — the palette and component language, specific enough to be recognizable with all content removed.
- **STORY** — what the visitor understands, believes, and does.
- **FIRST VIEWPORT** — the exact composition: what is where, at what scale, and where the primary action sits.
- **FORM** — the chosen direction and, if alternates were considered, why this one won.

If a block reads like a mood rather than a decision, the direction is not decided yet — do not start writing HTML until it is.

When image generation is available, load `/visualize` first: render 2-3 compositional options for the committed direction and put them before the user before generating the final HTML. This step is optional and non-blocking — when image generation is unavailable, skip it and proceed straight to building.

For `shape`, return the selected direction to the `shape` skill and stop before implementation.

## 6. Build with full commitment

Build the assigned direction, not a safer interpretation of it. The form supplies structure, reading order, component conventions, and native motion; the product supplies every fact. Commit every atom: nav, buttons, inputs, and links are rebuilt in the form's own vocabulary — a stock, undecorated component inside a committed world is a lapse (reuse existing document components via their `c-*` tags where they exist, but style the surface around them, not the reverse).

- **The first viewport is a thesis, not a header.** Demonstrate the mechanism immediately, at the scale the form has in life; do not trap the concept inside a standard hero or card shell. The memory test: if someone saw only the first viewport, what would they describe an hour later? If the honest answer is a mood, the concept has not committed yet.
- **Prove, don't claim.** Show the subject doing its job: the interface at work, the mechanism dramatized, specifics a competitor could not copy-paste. Sections that restate a claim in different words add length, not substance. Demonstration data is design material — author it at full fidelity and label it synthetic; never invent prices, customers, benchmarks, or capabilities.
- **Author the content; never substitute chrome.** Names, entries, copy, and imagery are yours to author at production fidelity in greenfield work. An unanswered commercial claim ships as a clearly marked placeholder. Gradients, glass, and generic icon tiles where authored content belongs are the gap wearing chrome.
- **Pace the layout like a studio.** Vary density, scale, imagery, motion, and quiet inside one grammar; a dense passage earns a quiet one, and the page ends anchored by a real close. One spacing rhythm throughout, with more space above a heading than below it.
- **Author motion as material.** The form has native motion — what it does in life between states. Give the page that motion once, orchestrated, rather than scattered hover effects.

Preserve semantics, accessibility, responsiveness, and every existing prototype rule (embed-only, device presets, HTML safety).

## 7. Inspect and finish

Critique the render against the user's request and the direction contract, fix material gaps, and re-inspect. On a Persuade surface, verify the mode did its job: a first-time visitor should know what this is, why it matters, and what to do within seconds, in the form's own vocabulary. Check the render against the `Quality floor` in the `frontend-design` skill (contrast, depth, spacing, type, motion, states, copy, coverage) before calling the work done.
