---
name: visualize
description: Optional pre-build step — render 2-3 compositional options for a locked direction and put them before the user before generating the final HTML. Use when image generation is available and the surface is visually ambitious.
args: []
---

Load this from `new-work` when image generation is available and the surface is visually ambitious. This step is entirely **optional and non-blocking**: image generation is a backend capability, not a guarantee. If no image-generation tool is available in this session, skip this file and go straight to building the HTML — do not stall the request waiting on it.

The direction has already been chosen by `new-work` before this file loads; this step never reopens that decision. The purpose of a compositional option is to test composition, narrative, hierarchy, density, focal moment, and image requirements — it is not a second identity workshop. Keep the committed palette, typography direction, material language, component character, and imagery stance fixed across every option.

## Generate two or three compositional options

Render 2–3 distinct high-fidelity options of the requested surface, using whatever image-generation capability is available. Base them on the real content and the direction already committed with the user. More than one option is the point: a single rendering invites rubber-stamping, and the spread across two or three is what surfaces the composition actually worth building.

- When one direction is committed, vary the structural uncertainty an image can resolve: topology, sequence, density, hierarchy, focal composition, or interaction framing — not the palette or type voice.
- Show enough beyond the opening moment to prove the concept can govern the whole requested surface.
- Do not generate a palette study, ask new atmosphere questions, introduce a different type voice, or invent a new motif. If the committed direction cannot support the concept as rendered, return to `new-work`'s direction step rather than quietly changing the world here.

Treat each option as a direction test, not a pixel-exact spec to trace. Core UI text, responsive behavior, accessibility, and interaction states remain implementation responsibilities for the build step, not for the rendered options.

## One approval point

Show the options together in chat. Ask the user what should carry forward, what feels false to the direction, and whether the committed concept should be approved, combined, or revised. Then wait for the answer before generating the final HTML — do not start the build while the options are still pending review.

If the user delegates the choice, choose using the brief and the direction contract already recorded, and state the evidence for the pick.

After approval, briefly summarize the composition and note anything from the options that must not be taken literally (an option is a reference for structure and mood, not markup to trace). Return to `new-work` to finalize (or re-confirm) the direction contract, then build with `batch_design` as usual.

## Deliverable

The deliverable of this step is the set of options shown in chat and the user's decision — never files written anywhere; there is no project filesystem to write them to. If image generation fails or is unavailable partway through, say so plainly and fall back to building directly from the direction contract already recorded in `new-work`.
