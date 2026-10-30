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
3. If key facts are missing and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts only. Plan: research questions, user groups, method, dates. Report: where the session data is.
4. Never invent participant numbers, quotes, times or scores. If the user has no session data yet, write a plan or put `[TBD]` in the report. Put `[TBD: what is missing]` for any other missing fact.

## Output

- Write the document with `doc_create`. Title: "Usability test plan: [subject]" or "Usability test report: [subject]". If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing document, use `doc_list`, `doc_read`, then `doc_edit`.
- Write the document in the user's language. Translate the template headings and labels. Keep IDs such as `F-01` and `Task 1` consistent.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- Write the finding severity as a tag with a fixed colour: 4 red, 3 orange, 2 yellow, 1 gray, 0 gray. Use the same colour for the same number in the whole document.
- Show a key screen or a finding as a picture with `doc_insert_image` (`nodeId` of the screen, or an image URL; `alt` says what it shows). Do not write `data:` URLs. Link the screens as `[Name](/app?node={nodeId})` (the node id comes from `get_editor_state`) and the brief or spec as `[Title](/doc?id={docId})` (the docId comes from `doc_list`). If you have no node id or document, write `[TBD: ...]` text, not a link.
- In each finding, replace the `[TBD: 0-4]` placeholder with the severity tag.
- Put a screenshot of a finding under it with `doc_insert_image` and `afterHeading` set to the full text of the finding heading, for example "F-01 Users miss the Save button". Then delete its `[TBD: screenshot or recording timestamp]` line. If you have a recording timestamp or a clip link instead, write it in that line. If you have neither, keep the `[TBD]`. Never invent a timestamp or a link.
- If the sessions measured time on task, add a `Time (median)` column to the Task results table.
- Use the template for the chosen kind only. Keep each of its sections.
- Each template starts with an H1. That H1 is the `title` argument of `doc_create`. Start `markdown` after it. The document shows the title above the body, so do not repeat it as a `#` heading.
- After `doc_create`, reply in chat with 1 to 3 sentences: what the document covers and which `[TBD]` items the user must fill.

## Template: plan

````markdown
# Usability test plan: [subject]

|  |  |
| --- | --- |
| Prototype or product | [link, version] |
| Method | [moderated / unmoderated, remote / in person, session length in minutes] |
| Participants | [N per group: profile and experience with the product] |
| Dates | [TBD: YYYY-MM-DD to YYYY-MM-DD, pilot session first] |

## Research questions

- **RQ1:** [what we need to learn, and the decision it informs]

## Tasks

### Task 1

- **Scenario:** [short story in the user's words. No UI labels, no hints.]
- **Start:** [screen or URL]
- **Success criteria:** [what counts as complete, set before the sessions]
- **Evidence to capture:** [screen recording with timestamps, completion, ease 1 to 7 (SEQ), quotes]
- **Research question:** RQ1
````

## Template: report

````markdown
# Usability test report: [subject]

|  |  |
| --- | --- |
| Method | [moderated or not, remote or not, length] |
| Dates | [TBD: YYYY-MM-DD to YYYY-MM-DD] |
| Participants | [N] in [groups]: P1 [group, device], P2 [group, device] |
| Test plan | [TBD: link to the usability test plan] |

## Top findings

1. [Most important finding, one sentence, with severity as a tag and its evidence: x of N]
2. [Second finding]
3. [Third finding]

## Task results

| Task | Completed | Ease (SEQ, mean) | Evidence |
| --- | --- | --- | --- |
| Task 1 | [x of N] | [TBD: mean SEQ] | [TBD: recording or clip link] |

## Findings

### F-01 [what went wrong]

- **Severity:** [TBD: 0-4]
- **Where:** [TBD: link to the screen]
- **Seen in:** [x of N participants: P1, P3]
- **Quote:** "[participant quote]" (P3)
- **Screenshot or clip:** [TBD: screenshot or recording timestamp]
- **Recommendation:** [fix]

Severity: 0 not a problem, 1 cosmetic, 2 minor, 3 major, 4 catastrophe.

## What worked

- [strength, with evidence: x of N, quote]
````

## Writing rules

1. Tie each task to a research question. Tie each question to a decision.
2. Write neutral tasks. Describe the goal in the user's words. Do not name buttons and do not lead.
3. Set the success criteria before the sessions. Do not set them after you see the results.
4. Recruit by experience and behaviour, not by demographics only. Plan about 5 participants for each user group.
5. Report completion together with the ease score. A pass with a low score is a warning.
6. Give every task an `Evidence to capture` line: what the sessions record to judge it (recording, completion, ease score, quotes). If you measure time on task, say where the clock starts and stops, and what happens to a failed task.
7. In a report, put the top findings right after the property list. Then the details.
8. Give each finding an ID, the place, a severity from 0 to 4, a fix and its evidence. "Seen in" (x of N, with the participant IDs) is required: a finding that no participant showed is an opinion, so leave it out. Add a quote from one of those participants and a screenshot or a recording timestamp when the session data has them. If it has none, keep the `[TBD]` or delete the line. Never invent a quote.
9. Keep frequency separate from severity. "4 of 5" is evidence. Severity rates impact and persistence.
10. List what worked. Strengths stay in the next version.
11. Keep the plan short. Cut every section the team will not use.

## Mistakes to avoid

- A bloated plan that nobody reads.
- Leading tasks: "Click the Settings icon to change your name".
- Invented participants, quotes, times or scores.
- Success criteria written after the data.
- Severity and frequency mixed into one number.
- Findings without evidence (x of N, quote, screenshot or clip) or without a recommendation.
- A report with no strengths.
- A plan with no pilot session in its dates.

## Sources

- MeasuringU, usability test plan: https://measuringu.com/usability-test-plan/
- NN/g, usability testing 101: https://www.nngroup.com/articles/usability-testing-101/
- NN/g, severity ratings for usability problems: https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/
- NN/g, UX expert reviews (finding, severity, fix, strengths): https://www.nngroup.com/articles/ux-expert-reviews/
