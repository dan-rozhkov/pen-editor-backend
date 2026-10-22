---
name: usability-test
description: Write a usability test plan or usability test report as a document. Use when the user asks for a usability test plan, test script, tasks for user testing, or a report of test findings, or says "юзабилити-тест", "план юзабилити-тестирования", "отчёт по юзабилити-тесту".
args:
  - name: topic
    description: The product, feature or flow under test (optional)
    required: false
  - name: kind
    description: plan or report. Optional. Infer it from the request - before the sessions is a plan, after the sessions is a report.
    required: false
user-invokable: true
---

## Purpose

Write a usability test plan or a usability test report as a document with `doc_create`. A plan tells the team what to test, with whom, how, and how to judge the result. A report tells stakeholders what the sessions found and what to fix first. This skill is not `critique` or `audit` (expert review in chat).

## Gather the inputs

1. Choose the kind. If the user gave `kind`, use it. If sessions have not happened, write a plan. If the user has session data, notes or recordings, write a report.
2. Use what the conversation already has:
   - The canvas, only if a canvas tab is already open (do not open one for this document): `get_editor_state` for the screens under test, `read_embed_html` for their copy, `get_screenshot` if available.
   - A design brief or design spec document (`doc_list`, `doc_read`): goals, audience, flows.
   - `browse_agent` or QA results for a live product.
   - For a report: the user's notes, transcripts, task results and survey scores.
3. If key facts are missing and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts only. Plan: goals, user groups, method, dates. Report: where the session data is.
4. Never invent participant numbers, quotes, times or scores. If the user has no session data yet, write a plan or put `[TBD]` in the report. Put `[TBD: what is missing]` for any other missing fact.

## Output

- Write the document with `doc_create`. Title: "Usability test plan: [subject]" or "Usability test report: [subject]". If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing document, use `doc_list`, `doc_read`, then `doc_edit`.
- Write the document in the user's language. Translate the template headings and labels. Keep IDs such as `F-01` and `Task 1` consistent.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- Write the finding severity as a tag with a fixed colour: 4 red, 3 orange, 2 yellow, 1 gray, 0 gray. Use the same colour for the same number in the whole document.
- Show a key screen or a finding as a picture with `doc_insert_image` (`nodeId` of the screen, or an image URL; `alt` says what it shows). Do not write `data:` URLs. Link the screens as `[Name](/app?node={nodeId})` (the node id comes from `get_editor_state`) and the brief or spec as `[Title](/doc?id={docId})` (the docId comes from `doc_list`). If you have no node id or document, write `[TBD: ...]` text, not a link.
- In the findings table, replace the `[TBD: 0-4]` placeholder with the severity tag.
- Use the template for the chosen kind only. Delete optional sections that do not apply.
- Each template starts with an H1. That H1 is the `title` argument of `doc_create`. Start `markdown` after it. The document shows the title above the body, so do not repeat it as a `#` heading.
- After `doc_create`, reply in chat with 1 to 3 sentences: what the document covers and which `[TBD]` items the user must fill.

## Template: plan

````markdown
# Usability test plan: [subject]

## Objectives & research questions

- **Objective:** [business question the test answers]
- **RQ1:** [what we need to learn]
- **RQ2:** [what we need to learn]

## Participants

| Group | Profile | Screener | Count |
| --- | --- | --- | --- |
| [group] | [experience with the product or domain, device, context] | [questions] | 5 |

## Method

- **Type:** [moderated | unmoderated], [remote | in person]
- **Session length:** [minutes]
- **Prototype or product:** [link, version]
- **Task order:** [fixed | counterbalanced, how]
- **Roles:** [moderator, note-taker]

## Tasks

### Task 1

- **Scenario:** [short story in the user's words. No UI labels, no hints.]
- **Start:** [screen or URL]
- **Success criteria:** [what counts as complete, set before the sessions]
- **Research question:** [RQ1]

## Metrics

| Metric | How to measure | Rule |
| --- | --- | --- |
| Task completion | success, partial, fail | Criteria fixed in advance |
| Time on task | start and stop points | A failed task is [excluded or capped] |
| Ease (SEQ) | 1 to 7 after each task | |
| Confidence | 1 to 7 after each task | Report with completion |
| SUS | 10 questions after the test | Score 0 to 100 |

## Schedule

| Step | Date | Owner |
| --- | --- | --- |
| Pilot session | [TBD: YYYY-MM-DD] | |
| Sessions | [TBD: YYYY-MM-DD to YYYY-MM-DD] | |
| Readout | [TBD: YYYY-MM-DD] | |
````

## Template: report

````markdown
# Usability test report: [subject]

## Overview

- **Goal:** [what we wanted to learn]
- **Method:** [moderated or not, remote or not, length]
- **Dates:** [TBD: YYYY-MM-DD to YYYY-MM-DD]
- **Participants:** [N] in [groups]

## Top findings

1. [Most important finding, one sentence, with severity as a tag]
2. [Second finding]
3. [Third finding]

## Participants

| ID | Group | Experience | Device |
| --- | --- | --- | --- |
| P1 | [group] | [level] | [device] |

## Task metrics

| Task | Completed | Time (median) | SEQ (mean) | Notes |
| --- | --- | --- | --- | --- |
| Task 1 | [x of N] | [TBD: median time] | [TBD: mean SEQ] | |

## Findings

| ID | Finding | Where | Evidence | Severity | Principle | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 | [what went wrong] | [TBD: link to the screen] | [x of N], "[quote]" | [TBD: 0-4] | [heuristic] | [fix] |

Severity: 0 not a problem, 1 cosmetic, 2 minor, 3 major, 4 catastrophe.

## What worked

- [strength, with evidence]

## Test metrics

- **SUS:** [TBD: SUS score], [N] responses
- **Overall confidence:** [TBD: confidence]

## Next steps

- [action, owner, TBD: YYYY-MM-DD]

## Appendix

- **Tasks and scenarios:** [list]
- **Moderator script:** [link or text]
````

## Writing rules

1. Tie each task to a research question. Tie each question to a business decision.
2. Write neutral tasks. Describe the goal in the user's words. Do not name buttons and do not lead.
3. Set the success criteria before the sessions. Do not set them after you see the results.
4. Recruit by experience and behaviour, not by demographics only. Plan about 5 participants for each user group.
5. Report completion together with confidence. A pass with low confidence is a warning.
6. State the time-on-task rules: where the clock starts, where it stops, and what happens to a failed task.
7. In a report, put the top findings first. Then the details.
8. Give each finding an ID, the place, the evidence, a severity from 0 to 4, the violated principle and a fix.
9. Keep frequency separate from severity. "4 of 5" is evidence. Severity rates impact and persistence.
10. List what worked. Strengths stay in the next version.
11. Keep the plan short. Cut every section the team will not use.

## Mistakes to avoid

- A bloated plan that nobody reads.
- Leading tasks: "Click the Settings icon to change your name".
- Invented participants, quotes, times or scores.
- Success criteria written after the data.
- Severity and frequency mixed into one number.
- Findings without evidence or without a recommendation.
- A report with no strengths.
- A plan with no pilot session.

## Sources

- MeasuringU, usability test plan: https://measuringu.com/usability-test-plan/
- NN/g, usability testing 101: https://www.nngroup.com/articles/usability-testing-101/
- NN/g, severity ratings for usability problems: https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/
- NN/g, UX expert reviews (finding, severity, principle, fix, strengths): https://www.nngroup.com/articles/ux-expert-reviews/
