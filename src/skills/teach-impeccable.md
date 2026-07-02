---
name: teach-impeccable
description: One-time setup that establishes persistent design context for this project — register (brand vs product), users, purpose, brand personality, anti-references, and strategic design principles. Run once so every other design command starts on-brand.
user-invokable: true
---

The setup command for a project. One pass over the current design and project feeds the strategic context every other command reads before it does any work.

It captures **strategic** context — who/what/why:

- **Register** (brand vs product): does design IS the product (marketing, landing, campaign, portfolio) or does design SERVE the product (app UI, admin, dashboard, tool)? This single choice shapes every downstream decision.
- **Users, product purpose, brand personality, anti-references, and strategic design principles.**

The **visual** system — how it looks (color, typography, components, layout) — is captured separately by the `/document` skill. This skill offers to hand off to it at the end; it does not gather colors or fonts itself.

It closes by pointing you at the best command to run next.

## Step 1: Load current state

Check what context already exists. Read the project's config file ({{config_file}}) with your file tool if it is present.

Decision tree:

- **No context yet**: do Steps 2-4 to establish it, then decide on the visual system in Step 5.
- **Context exists but has no register**: infer a register hypothesis from the design (see Step 2), confirm it with the user, and add the field.
- **Context already exists and is current**: STOP and {{ask_instruction}} whether to refresh it. Skip anything the user doesn't want changed.

Never silently overwrite existing context. Always confirm first.

If this setup was invoked as a blocker by another command (e.g. the user ran `/craft` or `/critique` with no context yet), pause that command here, complete setup, then resume the original task. For a build task, resume into `/shape` next — setup creates project context, but it is not a substitute for the task-specific design brief.

## Step 2: Explore the current design and project

Before asking questions, scan what you can so you only ask about what you can't infer:

- **Existing scene**: read the current design with `get_editor_state` / `batch_get` — what surfaces, flows, and content already exist.
- **Design tokens**: `get_variables` — the color, typography, and spacing variables already defined.
- **Components**: existing component embeds (`isComponent: true`) — the established building blocks.
- **Any README, brand assets, style guide, or brand documentation** available for the project: purpose, target audience, logos, committed colors.

Also form a **register hypothesis** from what you find:

- **Brand signals**: hero sections, big expressive typography, landing/marketing/portfolio content, scroll-driven storytelling, "design is the point."
- **Product signals**: forms, data tables, dashboards, settings, app-shell nav, dense repeated UI, "design serves a task."

Register is a hypothesis at this point, not a decision; Step 3 confirms it. Note what you learned and what remains unclear, plus any rough edges worth a follow-up command later (thin hierarchy, flat or gray palette, missing error/empty states, dull copy).

## Step 3: Ask strategic questions

{{ask_instruction}} — but only about what you couldn't infer. Skip anything already clear from Step 2.

### Interview mode, not confirmation mode

Do **not** turn a one-sentence brief into a complete inferred context and ask for blanket confirmation. Run a short interview:

- Ask **2-3 questions per round**, then wait for answers.
- Use inferred answers as hypotheses or options, not finished facts.
- Complete at least one real answer round before drafting the context, unless every answer is directly discoverable from project docs.
- Round 1: register, users/purpose, desired outcome.
- Round 2: brand personality or references, anti-references, accessibility needs.

### Register (ask first — it shapes everything below)

Every design task is either **brand** (design IS the product) or **product** (design SERVES the product).

If Step 2 produced a clear hypothesis, lead with it: *"From the current design this looks like a [brand / product] surface. Does that match your intent, or should we treat it differently?"* If the signal is genuinely split (e.g. a product with a big marketing landing), {{ask_instruction}} which register describes the **primary** surface. Context carries one default; individual tasks can override it later.

### Users & Purpose
- Who uses this? What's their context when using it?
- What job are they trying to get done?
- For brand: what emotions should the interface evoke? (confidence, delight, calm, urgency)
- For product: what workflow are they in? What's the primary task on any given screen?

### Brand & Personality
- How would you describe the brand personality in 3 words?
- Reference sites or apps that capture the right feel — and the *specific* thing about each that fits (not generic "modern" adjectives or category lanes)?
- What should this explicitly NOT look like? Any anti-references?

### Accessibility & Inclusion
- Specific accessibility requirements? (WCAG level, known user needs)
- Considerations for reduced motion, color blindness, or other accommodations?

**Do NOT ask about colors, fonts, radii, or visual styling here.** Those belong to the visual system (`/document`), not the strategic context.

## Step 4: Write the strategic context

Write the context only after the user has confirmed the strategic answers from Step 3. If an inferred answer is uncertain or unconfirmed, ask before writing.

Synthesize into this structure:

```markdown
## Design Context

### Register
[brand | product — a bare value]

### Users
[Who they are, their context, the job to be done]

### Product Purpose
[What this product/experience does, why it exists, what success looks like]

### Brand Personality
[Voice, tone, 3-word personality, emotional goals]

### Anti-references
[What this should NOT look like. Specific bad-example sites or patterns to avoid.]

### Design Principles
[3-5 strategic principles derived from the conversation — e.g. "show, don't tell", "expert confidence", "practice what you preach". NOT visual rules like "use OKLCH" or "magenta accent".]

### Accessibility & Inclusion
[WCAG level, known user needs, considerations]
```

Write this to {{config_file}}. If the file exists, merge into the existing Design Context section rather than starting from scratch.

## Step 5: Decide on the visual system

Offer `/document` either way — it captures the visual design system (colors, typography, components, layout) so future work stays on-brand:

- **A design already exists**: "I can capture your visual system — colors, typography, components — so new screens stay consistent. Want to do that now?"
- **Pre-implementation (empty canvas)**: "I can seed a starter visual direction from a few quick questions about color strategy, type direction, and references. You can re-run once there's something built, to capture the real tokens. Want to do that now?"

If the user agrees, hand off to the `/document` skill and follow its flow. If they prefer to skip, mention they can run `/document` any time later.

## Step 6: Recommend starting points, then wrap up

Summarize tersely:

- Register captured (brand / product)
- What was written (strategic context, visual system, or a subset)
- The 3-5 strategic principles that will guide future work
- If the visual system is still pending, one line on how to set it up later

Then recommend the **best commands to run next**, drawn from what your Step 2 pass already surfaced — don't run a fresh analysis. Tailor to register and to what you saw; offer the 2-4 most relevant (not a menu dump), with the exact command to type, grouped by intent:

- **Build something new**: `/craft <feature>` (shape, then build end-to-end) or `/shape <feature>` (plan first). Lead with this for empty or early-stage projects.
- **Improve what's there**: name the specific surface. `/critique <surface>` for a scored UX review; `/audit <area>` for a11y / perf / responsive checks; `/polish <component>` for a pre-ship pass. When Step 2 flagged a specific weakness, point the matching command at it: thin hierarchy or spacing → `/layout`, flat or gray palette → `/colorize`, missing error/empty states → `/harden` or `/onboard`, dull or unclear copy → `/clarify`.

If setup was invoked as a blocker by another command, resume that original task now. Your own writes are the freshest source; no reload needed.
