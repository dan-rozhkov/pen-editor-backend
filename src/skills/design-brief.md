---
name: design-brief
description: Write a project design brief as a document, before design work starts. Use when the user asks for a design brief, project brief, creative brief, scope of a design project, or says "бриф", "бриф на дизайн", "техзадание на дизайн", "brief for a redesign".
args:
  - name: topic
    description: The product, feature or flow the brief is about (optional)
    required: false
user-invokable: true
---

## Purpose

Write a design brief as a document with `doc_create`. The brief aligns the design team and the stakeholders before design work starts. It says what problem to solve, for whom, how to measure success, and what is in scope. It describes the problem. It does not describe a solution. This skill is not the same as `shape`, which plans the UX/UI of a feature in chat before it is built. The design brief is the project brief, written as a document for stakeholders. It is also not `critique` (feedback on a design).

## Gather the inputs

1. Use what the conversation already has. Sources that fit a brief:
   - The user's request and any attached files, links or notes.
   - A repo read with `read_design_repo` (product name, platform, stack, existing screens).
   - The canvas, only if a canvas tab is already open (do not open one for this document): call `get_editor_state` for existing screens, and `get_variables` for brand colours, fonts and tokens. Quote real hex codes and font names.
   - Earlier research or `browse_agent` results (competitors, references).
2. Find these facts: the problem and its evidence, the goals and how to measure them, the audience, the scope and the deliverables, the constraints, the dates, the owner and the approver.
3. If key facts are missing and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts only. Ask for the problem, the measurable goal, the audience, the deadline and the approver first. Do not ask for facts you can find.
4. Never invent facts: numbers, results, dates, names, budgets. Put a visible placeholder `[TBD: what is missing]` instead.

## Output

- Write the document with `doc_create`. Title: "Design brief: [subject]", for example "Design brief: Checkout redesign". If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing brief, use `doc_list`, `doc_read`, then `doc_edit`.
- Write the document in the user's language. Translate the template headings and labels.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- If the canvas already has screens, link them as `[Screen name](/app?node={nodeId})` (the node id comes from `get_editor_state`). If a design spec or other document exists (`doc_list`), link it as `[Title](/doc?id={docId})` (the docId comes from `doc_list`). If no such screen or document exists, write `[TBD: ...]` text, not a link.
- Write a risk or an open question that blocks the work as a callout: `> [!WARNING]`, then the text on the next quote line.
- Include the Budget section only for agency or contract work.
- To show a key existing screen, call `doc_insert_image` with its `nodeId`. Do not write `data:` URLs.
- Write dates in the property list and the tables as `YYYY-MM-DD`.
- Delete optional sections that do not apply. Do not leave empty headings.
- Keep the brief to 1 or 2 pages.
- The H1 of the template is the `title` argument of `doc_create`. Start `markdown` after it, with the first section. The document shows the title above the body, so a `#` heading with the title in the body shows it twice.
- After `doc_create`, reply in chat with 1 to 3 sentences: what the brief covers and which `[TBD]` items the user must fill.

## Template

````markdown
# Design brief: [subject]

## Summary

[2 or 3 sentences: what the project is, who it is for, what outcome it must produce.]

## Problem & background

- **Problem:** [what is wrong or missing today, for whom]
- **Evidence:** [research, analytics, support tickets, with numbers and sources]
- **Why now:** [trigger]

## Goals & success measures

| Goal | Measure | Today | Target |
| --- | --- | --- | --- |
| [outcome, not a feature] | [metric and how it is read] | [TBD: current value] | [TBD: target value] |

## Audience

- **Primary users:** [role, experience level, context of use]
- **Secondary users:** [who else is affected]
- **What they need:** [jobs to be done]

## Scope & deliverables

**In scope**

- [screen, flow or asset]

**Out of scope**

- [explicit exclusion]

**Deliverables**

- [artifact, format, owner]

## Constraints & existing assets

- **Brand:** [colours as hex codes, logo, tone]
- **Design system:** [library, tokens, components to reuse]
- **Existing screens:** [TBD: link to a screen on the canvas, or leave out]
- **Typography:** [font families, sizes]
- **Platform:** [web, iOS, Android, breakpoints, browsers]
- **Technical and legal:** [limits, accessibility level, compliance]

## Competition & references (optional)

| Reference | What to learn | Link |
| --- | --- | --- |
| [product or screen] | [one point] | [url] |

## Timeline & milestones

| Milestone | Date | Notes |
| --- | --- | --- |
| Kickoff | [TBD: YYYY-MM-DD] | |
| First review | [TBD: YYYY-MM-DD] | [who reviews] |
| Final handoff | [TBD: YYYY-MM-DD] | |

## Stakeholders & decisions

| Role | Name | Decides on |
| --- | --- | --- |
| Owner | [TBD: owner] | [day-to-day calls] |
| Approver | [TBD: approver] | [final sign-off] |
| Consulted | [TBD: consulted people] | [input only] |

## Risks, assumptions & open questions (optional)

- **Risk:** [what can go wrong, mitigation]
- **Assumption:** [what we take as true]
- **Open question:** [what we must answer, who answers, by when]

## Budget (optional)

[TBD: budget, split by phase]
````

## Writing rules

1. Put the Summary first. A reader who stops after it must know the project.
2. Describe the problem, not the solution. Do not name layouts, components or screens as the answer.
3. State goals as measurable outcomes. "Raise checkout completion from 62% to 70%" is a goal. "Add a progress bar" is not.
4. Ground each goal in evidence. Name the research, the analytics or the ticket count. If there is none, write `[TBD: evidence]`.
5. Be specific. Give hex codes, font names, breakpoints, platform versions. Do not write "modern" or "clean".
6. Write out of scope explicitly. It stops scope creep.
7. Read `get_variables` and the canvas before you write Constraints. Reuse the real tokens.
8. Name one owner and one approver. Date every milestone, or mark it `[TBD]`.
9. Agree the objectives and the audience first. Later reviews judge the design against them.
10. Keep it short. Cut any sentence that does not change a decision.

## Mistakes to avoid

- A solution in disguise: "Redesign the dashboard with cards".
- Goals that are features or feelings, with no measure.
- No audience, or "everyone" as the audience.
- No out of scope list.
- Invented numbers, dates or names. Use `[TBD]`.
- Vague constraints: "follow the brand" with no colours or fonts.
- Skipping stakeholder input on the timeline.
- A long brief that nobody reads. Stay at 2 pages.

## Sources

- Maze design brief: https://maze.co/blog/design-brief
- NN/g design critiques (agree objectives and audience first): https://www.nngroup.com/articles/design-critiques/
- Synthesis for the section order, the placeholders and the writing rules.
