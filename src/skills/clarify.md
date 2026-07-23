---
name: clarify
description: Improve unclear UX copy, error messages, microcopy, labels, and instructions. Makes interfaces easier to understand and use.
args:
  - name: target
    description: The feature or component with unclear copy (optional)
    required: false
user-invokable: true
---

> **Additional context needed**: audience knowledge and emotional state.

Rewrite unclear interface text so users understand what happened, what matters, and what to do next. Preserve factual meaning, product terminology, and brand voice.

---

## Audit the language

Read the entire interaction path, not isolated strings. Identify:

- ambiguous nouns, verbs, and actions;
- internal jargon or assumed knowledge;
- vague labels, outcomes, and system states;
- missing consequences, recovery, or timing;
- inconsistent terminology and capitalization;
- redundant headings, intros, helper text, and confirmations;
- text that breaks at realistic widths or in translation;
- tone that ignores stress, risk, success, or urgency.

Infer audience and task from product context and surrounding UI. STOP and {{ask_instruction}} before changing factual claims, legal meaning, or a term that may be domain-specific.

## Set the message hierarchy

For each state, decide:

1. the one fact the user needs now;
2. the action available next;
3. supporting context that changes the decision;
4. the appropriate tone for this moment.

Say each idea once. If the heading already explains the state, the introduction should add new information or disappear.

## Rewrite by function

### Actions and navigation

Use a specific verb and object when the outcome is not already obvious. Labels should describe what will happen, not the gesture used to trigger it. Keep the same noun and verb for the same concept throughout the product.

For destructive actions, name the object and consequence. Prefer undo over confirmation when recovery is safe. When confirmation is necessary, name the action on both the message and button instead of using "Yes", "No", "OK", or "Submit".

### Forms

Use persistent labels; placeholders are examples, not labels. Put format and eligibility requirements before submission. Explain why information is requested only when it is not obvious. Required and optional treatment should be consistent.

Validation says what needs attention and how to correct it without blaming the user. Keep related instructions near the field and announce errors accessibly.

### Errors and permissions

An actionable error answers:

1. what failed;
2. why, when known and useful;
3. how to recover or what alternative remains.

Do not expose internal codes as the primary message. Do not promise a cause or resolution the system cannot know. Treat privacy, payment, deletion, access loss, and blocked work seriously; warmth is welcome, jokes are not.

### Loading, empty, and success states

Loading text names the real operation and sets an honest expectation when the wait is meaningful. Show determinate progress when available; never invent progress.

An empty state distinguishes first use, no results, filters, permissions, and failure. Explain the state and provide the next useful action.

Success confirms the completed outcome and mentions the next consequence only when it changes what the user should do. Routine success should be brief.

### Help and instructional text

Helper text answers an implicit question instead of restating the control. Use progressive disclosure for uncommon detail. Link text must make sense out of context; icon-only controls need accessible names.

## Voice, accessibility, and localization

Voice stays consistent; tone adapts to the moment. Use plain language without flattening terminology the audience genuinely knows.

- Write complete translatable messages rather than concatenated fragments.
- Keep variables and numbers structured so translators can reorder them.
- Allow expansion instead of abbreviating prematurely (German is ~30% longer than English, Finnish 30-40%).
- Make alt text convey the image's information; use empty alt for decoration.
- Keep screen-reader names aligned with visible labels and outcomes.
- Do not rely on punctuation, color, or iconography to carry the message alone.

Maintain a short terminology glossary when inconsistency spans the product. Do not vary words for literary effect in an interface.

## Verify

Read the flow in context and test:

- comprehension without hidden product knowledge;
- actionability at errors, empty states, and decision points;
- factual accuracy and consistent terminology;
- scanability at target widths and 200% zoom;
- long names, localization expansion, pluralization, and dynamic values;
- accessible names and announced state changes;
- tone appropriate to consequence and emotional context.

The final copy is as short as it can be without removing meaning or recovery.

When the language reads cleanly, hand off to the `/polish` skill for the final pass.

## Quality floor

**Verify**
- Contrast: rewritten labels, errors, and helper text still meet ≥4.5:1 body contrast; secondary/muted copy is tinted from the surface hue, never generic gray.
- Depth: any callout or banner used to surface an error keeps a real offset+blur shadow if elevated, not a zero-offset colored halo.
- Spacing: message blocks keep tight-group/generous-separation rhythm; more space above a heading than below it.
- Type: body copy measure stays 65–75ch; tracking floor -0.04em.
- Motion: at most one authored transition for a state change (e.g. error appearing); no decorative motion on copy alone.
- States: hover/disabled/loading/error/empty each get their own real copy, not a single string reused everywhere.
- Copy: every control names its action, every error names problem + recovery, and nothing is vague ("Something went wrong" without explanation) or ambiguous.

**Refuse**
- Jargon without explanation, blaming the user, humor in error states, and varying terminology for the same concept.

Full floor lives in the `frontend-design` skill.
