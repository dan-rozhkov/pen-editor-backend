# Podcast Stack showcase design

## Goal

Publish a hand-authored five-screen mobile showcase run for a podcast queue
called **Tandem**. The screens form one coherent task flow and demonstrate the
product working, including at-risk and error states.

## Audience and surface

- Audience: frequent podcast listeners who assemble a queue for commutes,
  walks, and offline listening.
- Surface mode: **Operate**.
- Viewport: 390×844 CSS pixels, rendered at DPR 2.
- Output: five standalone static HTML embeds, published through the existing
  showcase ingest pipeline.

## Direction contract

**THESIS:** A podcast queue should feel like a deliberate stack of things worth
hearing, not a storefront grid. Tandem refuses equal recommendation cards and
generic streaming chrome.

**OWN-WORLD:** Cold milk-white paper, ink-dark type, and one muted orange
accent. Episodes overlap like record sleeves and annotated paper covers.
Hairlines, clipped artwork, visible durations, and offset layers make the
interface recognizable without its copy.

**STORY:** The listener builds an evening queue, starts an episode, captures
chapter notes, discovers expiring downloads, and repairs one failed offline
save.

**FIRST VIEWPORT:** The top episode, “The Quiet Cost of Convenience,” is open in
the upper third; two cover edges remain visible beneath it. The timed queue
continues below, and the primary action sits in a reserved bottom bar.

## Visual system

- One Google font: Manrope.
- One accent: muted orange below 80% saturation.
- Cool neutral palette; never pure black.
- Regular Phosphor icons only.
- Square and slightly rounded cover geometry; cards appear only where layering
  communicates queue order.
- No device chrome, gradients used as photo substitutes, transitions,
  animations, filters, JavaScript, or ad-hoc interface SVGs.
- Real generated artwork for the large featured cover; seeded photo sources or
  initials may be used only for small secondary artwork.

## Screen flow

1. **Your Stack** — the evening queue with one expanded episode and two
   visibly layered episodes. It establishes order, remaining listening time,
   and the primary play action.
2. **Now Playing** — the selected episode at `18:42 / 47:16`, with chapter
   structure and an action to add a note at the current timestamp.
3. **Chapter Notes** — authored notes and short synthetic excerpts bound to
   exact timestamps, including one empty chapter that invites the next note.
4. **Queue at Risk** — two downloads expire tomorrow. The listener chooses
   which items to keep offline while storage impact remains explicit.
5. **Offline Error** — one download failed because the source URL expired. The
   screen names the cause, preserves queue position, and offers a direct retry
   plus a secondary remove action.

## Content

The content is fictional and specific. Host and guest names, durations,
timestamps, storage sizes, and dates use organic values. Synthetic quotations
are labelled as notes or excerpts so they cannot be mistaken for real
published speech.

## Layout and fit

Every screen uses a 390×844 border-box body with hidden overflow. Any pinned
bottom control has an equal or larger content reservation. Type remains within
the prototype scale; copy or spacing is trimmed instead of shrinking text to
hide overflow. Screens must render at exactly 780×1688 and show no pipeline
overflow warning.

## Assets and data flow

1. Generate and inspect the small set of large cover images through
   `showcase:image`.
2. Author five standalone HTML files in a new, run-specific scratch directory.
3. Render them with the production screenshot implementation.
4. Inspect every PNG for fit, font/icon loading, visual continuity, content
   errors, and state clarity.
5. Create a manifest marked `Codex GPT-5 (hand-authored)`.
6. Run showcase ingest with `--dry-run`.
7. Publish only after the dry-run matches the five reviewed screens.

## Verification and failure handling

- Reject any render that is not 780×1688.
- Treat render-ready warnings, blank icons, or fallback fonts as pipeline
  failures rather than HTML styling issues.
- Regenerate or replace artwork that is illegible, unrelated, or contains
  garbled text.
- Do not publish if the five screens fail to read as one continuous flow.
- Preserve existing untracked `.handrun` work by using a distinct subdirectory
  and staging only this specification for its documentation commit.
