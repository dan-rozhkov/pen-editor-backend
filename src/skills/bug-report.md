---
name: bug-report
description: Write a bug report (defect report) for one or more bugs, with steps to reproduce, expected and actual results, severity and priority. Use when the user asks for a bug report, a defect, a ticket for a bug, or says "баг-репорт", "описание бага", "дефект", "заведи баг".
args:
  - name: topic
    description: The product, feature or flow the document is about (optional)
    required: false
user-invokable: true
---

## Purpose

A bug report lets a developer reproduce a problem and fix it without asking questions. The reader may be a developer, a tester who retests, or a manager who sets priority. One report describes one bug.

## Gather the inputs

Use what the conversation already has first:

- `browse_agent` results with `qa: true`, for example from a bug-hunt run. Take the steps, `qa.reason`, console errors and failed requests from them. Use only what the run showed.
- QA runs saved in trace tabs. If `trace_list` and `trace_read` are in your tool list, read the run there: steps, checks, console errors and failed requests.
- The design on the canvas (`get_editor_state`) for the expected behaviour of a screen.
- The spec or PRD, for the expected result.
- Screenshots, logs or text that the user attached.

Before you write, search for duplicates. Call `doc_list` and look for a report of the same problem. If one exists, update it with `doc_read` and `doc_edit`. Do not write a second report.

Facts you need: the exact steps, the expected result, the actual result, the environment (build, browser, OS, device) and how often it happens.

If key facts are missing and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts only. Do not ask for facts you can find.

Never invent facts: steps, versions, error text, counts. Put a visible placeholder `[TBD: what is missing]` instead.

## Output

- Write the document with `doc_create`. The title is `Bug report: [summary]`. If the user gave several bugs, write ONE document with one self-contained section per bug (`## BUG-01 ...`, `## BUG-02 ...`). Each section holds all fields, so it can be copied alone. Write one document per bug only if the user asks. If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing document, use `doc_list`, `doc_read`, then `doc_edit`.
- Write in the user's language. Translate the template headings and labels. Keep IDs such as `BUG-01` and the status values the same inside the document.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- Use the field table only for single-line fields. Put steps, expected and actual results under headings, in lists or paragraphs.
- Delete optional sections that do not apply. Do not leave empty headings.
- After `doc_create`, reply in chat with 1 to 3 sentences. Say how many bugs the document holds and which `[TBD]` items the user must fill.

## Template

````markdown
# Bug report: [Area] [Summary]

| Field | Value |
| --- | --- |
| ID | [BUG-01] |
| Status | New |
| Area | [component or feature] |
| Environment | [build, OS, browser and version, device] |
| Reproducibility | [Always / Sometimes, N of M / Once] |
| Severity | [Critical / High / Medium / Low] |
| Priority | [set at triage, for example P1] |
| Regression | [Yes, worked in build X / No / Unknown] (optional) |

## Preconditions

- [Account, data and settings needed before step 1.]

## Steps to reproduce

1. [Start from a clean state: open the app in a new session.]
2. [Action.]
3. [Action.]

## Expected result

[What should happen. Cite the spec or the design if you can.]

## Actual result

[What happens. Say what you see, in plain facts.]

## Evidence

- Console errors: `[error text]`
- Failed requests: [method, URL, status]
- QA run reason: [qa.reason]
- Screenshots: [link]

## Workaround (optional)

[How the user can avoid the bug.]

## Notes

**Facts**
- [Observed behaviour that is confirmed.]

**Guesses**
- [A possible cause. Mark it as a guess.]
````

## Writing rules

1. Write one bug per report. Two problems in one report make it hard to assign, fix and close.
2. Search for duplicates with `doc_list` before you create a report.
3. Write a summary that names the problem, not the fix. Keep it near 60 characters. Add an optional `[Area]` tag at the start. Good: "[Checkout] Total ignores the discount code". Bad: "Fix the total".
4. Number the steps. Start from a clean state. Keep the steps minimal: remove every step that is not needed to show the bug.
5. Write expected and actual results as two separate parts. Say what you see, not what you think is wrong inside.
6. Give the reproducibility: always, sometimes with a count ("3 of 5"), or once. If a rerun did not fail, say so.
7. Add evidence: console errors, failed requests, `qa.reason`, screenshots. Check that the bug exists in the latest build. Name the build.
8. Use the same severity scale in every report. Severity is the technical impact. Priority is the urgency of the fix, and it is set at triage. The two are independent.
   - Critical: data loss, security problem, payment error, or the core flow is blocked.
   - High: a main feature fails and there is no workaround.
   - Medium: a feature fails but a workaround exists.
   - Low: a cosmetic or rare problem.
   - Example: a crash in a rare feature is High severity and low priority. A misaligned button in a launch campaign is Low severity and high priority. If you cannot know the priority, write `[TBD: set at triage]`.
9. Keep facts apart from guesses about the cause. Put guesses under Notes and mark them.
10. Use these statuses: New, Triaged, In progress, Fixed, Ready for retest, Verified, Closed, Reopened. Closing variants: Won't fix, Duplicate, Cannot reproduce, Deferred. A new report has the status New.

## Mistakes to avoid

- A title such as "It does not work" or "Fix the button".
- Several bugs in one report.
- Steps with gaps ("then do the usual flow") or steps that start from a dirty state.
- Mixing the expected and actual results in one paragraph.
- Setting severity by how annoying the bug feels, and not by its impact.
- Writing a guess about the cause as a fact.
- No environment or build version.
- Reporting a bug that no run or test showed.

## Sources

- Mozilla bug writing guidelines: https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html
- Chromium bug reporting guidelines: https://www.chromium.org/for-testers/bug-reporting-guidelines/
- VS Code bug template: https://github.com/microsoft/vscode/blob/main/.github/ISSUE_TEMPLATE/bug_report.md
- Atlassian Jira bug report template: https://www.atlassian.com/software/jira/templates/bug-report
- BrowserStack severity vs priority: https://www.browserstack.com/guide/bug-severity-vs-priority
- ISO/IEC/IEEE 29119-3 overview, incident report: https://www.microtool.de/en/document-management/test-documentation-with-iso-iec-ieee-29119-32021/
- Bug status values: synthesis
