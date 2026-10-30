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
- Browser runs saved as traces. If `trace_read` is in your tool list, read the run there. A run of this chat gives its trace id in `trace.id` and its trace link in `trace.href` of the `browse_agent` result. `trace_list` lists only the traces that are open as tabs. Read in the trace: steps, console errors, failed requests and, for a QA run, its checks. A trace without QA results has no verdict. `trace_read` also lists the screenshots of the run in `frames` (`frameId`, `step`, `kind`). Choose the frames that show the bug.
- The design on the canvas (`get_editor_state`) for the expected behaviour of a screen. Use it only if a canvas tab is already open. Never open a canvas tab only to write a bug report.
- The spec or PRD, for the expected result.
- Screenshots, logs or text that the user attached.

Report a defect only if a rerun reproduced it. If you have no rerun that reproduced the bug, run one first, or do not file the report.

## Diagnose before you report

Put each failure in one of three classes. Write a report only for a product bug.

1. **Product bug.** The product does not do what the spec, the design or the user expects. A rerun shows the same failure. Write a report.
2. **Wrong check.** The scenario or the expected result is wrong or out of date. For example, the spec changed and the check still expects the old behaviour, or the check uses a step that the spec does not have. If the spec still requires the behaviour that the product does not show, it is a product bug, not a wrong check. Do not write a report. Tell the user in chat which check to fix and why.
3. **Flaky or environment.** The failure did not occur again on the rerun, or the cause is outside the product: a test account that is not set up, a network failure, an anti-bot page, a CAPTCHA. Do not write a report. List the failure in chat as flaky or untested.

If you are not sure that the behaviour is a bug, because you do not know what the product must do, do not write a report yet. If `ask_user` is in your tool list, put the question in the one `ask_user` form (see "Collect the facts"): what the user expected and what they saw. If `ask_user` is not in your tool list, tell the user in chat what you saw and what you need to know. Do not write a report until the class is clear.

If half or more of the checks in one run fail, or most requests fail with a 5xx status or a network error, treat it as one outage. An outage is class 3. Do not write one report for each failed check. Tell the user in chat about the outage: what failed, how many checks, and the first error. Write one report about the outage only if the user asks for it.

Never change the expected result to agree with the actual result. Never remove a step or a check because the product fails it. A softer expected result hides the bug.

## Search for duplicates

Before you write, search for duplicates. Call `doc_list`. A title that is different does not mean a different bug. The `Bug report:` prefix can be in another language, for example `Баг-репорт:`. Compare the behaviour: the same area, the same steps and the same actual result make a duplicate. Read with `doc_read` first the bug reports with the same area, then the reports whose title names the same screen or feature. Read at most 5 reports. A document can hold several bugs (`## BUG-01`, `## BUG-02`), so compare each section.

The open statuses are New, Triaged, In progress, Ready for retest and Reopened.

- If a duplicate exists and it is open, do not write a second report. Use `doc_read` and `doc_edit` to add the new occurrence under Evidence: the date, the build and the new evidence. Add the build to Tested builds only if your own run in this turn showed the bug there. A build that only the user names stays under Evidence. Update Reproducibility if the count changed.
- If a duplicate exists and its status is Fixed, Verified, Closed or Cannot reproduce, the bug came back or now reproduces. Set its status to Reopened with the red tag (`<span data-bg="red">Reopened</span>`). Add the build where it occurs under Evidence. If your own run in this turn showed the bug there, also add the build to Tested builds as failing. If the report names the build with the fix, set Regression to `Yes: last good build [fix build], first bad build [this build]`. Otherwise set Regression to `Yes` and write the builds as Unknown. Do not write a new report.
- If the duplicate has the status Duplicate, follow its link to the main report and apply these rules to that report.
- If the duplicate is Won't fix or Deferred, do not change its status. Tell the user in chat that the bug occurs again.

When the user asks again about a bug that you already reported, do one of these two things:

- Run the scenario again with `browse_agent`, then add the new run under Evidence. Write the trace link of the new run under Evidence. The Trace field keeps the run that first reproduced the bug. Do this if the user names a newer build, or asks you to check the bug. If `browse_agent` is not in your tool list, say in chat that you cannot check the bug in this chat.
- Do not run it again. Say in chat that you did not check it again. Name the run that the report cites: give its trace link (from the Trace field), or the date in its Evidence if Trace is `None`. If the report names no run, say that. Do not give a time or a chat that you cannot see. Do not add a run of your own to Evidence, and do not change Reproducibility, Environment or Tested builds.

An older report can have no Tested builds row or no Trace row, and its build can be in Environment. When you edit such a report, add the missing row after Environment or after Reproducibility. Do not move or delete the old values. If it has no Trace row, look for a trace link or a trace id in its Evidence.

If the user gives a new occurrence (a build, a screenshot, an error text), add it under Evidence as the user's report, as the duplicate rules say. That is not a check by you.

If your rerun does not show the bug, add the run and its trace link under Evidence, add the build to Tested builds as passing, and update Reproducibility (for example "2 of 3"). Do not change Status yourself. Tell the user in chat that the rerun passed, so the team can set Fixed, Verified or Cannot reproduce.

Only a `browse_agent` run in this turn is a new check. Reading a saved trace with `trace_read` is not a new check. Never say that you checked, reran or reproduced a bug in this turn if you did not call `browse_agent` in this turn. A report that is only translated or corrected is not a new check.

## Collect the facts

Facts you need: the exact steps, the expected result, the actual result, the environment (browser, OS, device), the tested builds and how often it happens.

If key facts are missing, or the class of the failure is not clear, and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts and the open question only. Do not ask for facts you can find.

Never invent facts: steps, versions, error text, counts. Put a visible placeholder `[TBD: what is missing]` instead.

## Check before you create

Run this check before `doc_create`, and again after each `doc_edit` of a bug report. If an item fails, fix the report first.

1. Each step is one action. The steps start from a clean state.
2. Expected result and Actual result are both filled. They are separate.
3. Tested builds names at least one build. If no build is known, it is `[TBD: build]`.
4. Trace holds a trace link or `None`.
5. Severity is a tag. Priority is a tag only if the user gave it.
6. Every missing fact is a visible `[TBD: ...]` placeholder. No fact is invented.

## Output

- Write the document with `doc_create`. The title is `Bug report: [summary]`, in the language of the document. If the user gave several bugs, write ONE document with one self-contained section per bug (`## BUG-01 ...`, `## BUG-02 ...`). Each section holds all fields, so it can be copied alone. Write one document per bug only if the user asks. If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing document, use `doc_list`, `doc_read`, then `doc_edit`.
- Write in the language of the user's own words in this chat. The `/bug-report` command and a one-word argument after it are not a language signal. Use the language of the user's other messages in this chat. If there are no other words, write in English. If the user's words are Russian, the document is Russian. Translate the title (also the `Bug report:` prefix), the headings and the field names. Keep these values unchanged in every language: IDs such as `BUG-01`, trace ids, the `None` value of Trace, the Status values, the Severity values and the Priority values (for example `Reopened`, `High`, `P2`). You can translate the words of a `[TBD: ...]` placeholder, but keep the `TBD` marker and the values in it, for example `P1 / P2 / P3 / P4`.
- When you edit an existing document, keep its language. Do not translate a whole document only to add evidence.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- Use the field table only for single-line fields. Put steps, expected and actual results under headings, in lists or paragraphs.
- Write the metadata table as a property list (see the `doc_create` description). Write Status, Severity and Priority as tags with the fixed colours in the writing rules. In the template, Severity and Priority are `[TBD: ...]` placeholders. Replace the Severity placeholder with the tag. Keep the Priority placeholder `[TBD: P1 / P2 / P3 / P4, set at triage]` (translated as the language rule says) unless the user gave the priority. Then write the priority the user gave as the tag.
- Insert each screenshot with `doc_insert_image` and `afterHeading` "Evidence", and an `alt` that says what the image shows. For a screenshot from a trace, give `traceId` and the `frameId` from `trace_read`. This is the way to put a trace frame into a document. Do one call for each relevant frame. Otherwise give `nodeId`: a node id from the `placed` field of the `browse_agent` result, or the `placedNodeId` of `browse_screenshot`. Or give an image URL. Use `trace_frame` only when it is in your tool list, and only to look at a frame or to place it on the canvas. Then delete the `[TBD: screenshot]` line.
- The H1 of the template is the `title` argument of `doc_create`. Start `markdown` after it, with the first section. The document shows the title above the body, so a `#` heading with the title in the body shows it twice.
- Write a link to a document as `[Title](/doc?id={docId})` (the docId comes from `doc_list`). If no such document exists, do not write a link.
- Write every trace as a link: `[Trace: {short goal}](/trace/{traceId}?src={source})`. Never write a bare trace id. Take the link from `trace.href` in the `browse_agent` result. Or build it from the trace id and its source. A trace that you read with `trace_read` has the source `local`. Use this link in Evidence and in the Trace field of the property list.
- Delete optional sections that do not apply. Do not leave empty headings.
- After `doc_create`, reply in chat with 1 to 3 sentences. Say how many bugs the document holds and which `[TBD]` items the user must fill.

## Template

````markdown
# Bug report: [Area] [Summary]

|  |  |
| --- | --- |
| ID | [BUG-01] |
| Status | <span data-bg="gray">New</span> |
| Area | [component or feature] |
| Environment | [OS, browser and version, device] |
| Tested builds | [build: fails / passes, for each tested build, for example "0.74.1: fails, 0.73.0: passes"] |
| Reproducibility | [Always / Sometimes, N of M. A rerun must have reproduced it] |
| Trace | [link to the trace of the run that reproduced the bug / None] |
| Severity | [TBD: Critical / High / Medium / Low] |
| Priority | [TBD: P1 / P2 / P3 / P4, set at triage] |
| Regression | [Yes: last good build X, first bad build Y / No / Unknown] (optional) |

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
- Suspect change: [the deploy, release or commit after which the bug first occurs] (optional)
- Trace: [Trace: {short goal}](/trace/{traceId}?src={source})
- Screenshot: [TBD: screenshot]

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
2. Search for duplicates before you create a report (see "Search for duplicates"). In the `doc_list` result, look for the test plan and the test report of the subject. Only if one exists, add a row `| Test plan | [Title](/doc?id={docId}) |` (or `Test report`) at the end of the property list. The docId comes from `doc_list`. If none exists, do not add the row. Do not write a `[TBD]` row.
3. Write a summary that names the problem, not the fix. Keep it near 60 characters. Add an optional `[Area]` tag at the start. Good: "[Checkout] Total ignores the discount code". Bad: "Fix the total".
4. Number the steps. Start from a clean state. Keep the steps minimal: remove every step that is not needed to show the bug.
5. Write expected and actual results as two separate parts. Say what you see, not what you think is wrong inside.
6. Give the reproducibility: always, or sometimes with a count ("3 of 5"). A bug seen once and never reproduced is not a report; list it as flaky in the chat.
7. Add evidence: console errors, failed requests, `qa.reason`, screenshots. Check that the bug exists in the latest build. Name every build you ran in Tested builds. The latest build must be among them. Write the trace link in Trace if the run that reproduced the bug produced one. If that rerun has no trace, for example the user ran it again by hand, write `None`. A report still needs a rerun that reproduced the bug. Never invent a trace id.
8. Use the same severity scale in every report. Severity is the technical impact. Priority is the urgency of the fix, and it is set at triage. The two are independent.
   - Critical: data loss, security problem, payment error, or the core flow is blocked.
   - High: a main feature fails and there is no workaround.
   - Medium: a feature fails but a workaround exists.
   - Low: a cosmetic or rare problem.
   - Example: a crash in a rare feature is High severity and low priority. A misaligned button in a launch campaign is Low severity and high priority. Write the priority only if the user gave it. Otherwise write `[TBD: P1 / P2 / P3 / P4, set at triage]`.
9. Find the change that caused a regression, if you can. The change that caused the bug is the strongest clue for a developer. Give the last build where it worked and the first build where it fails. Take them from Tested builds. If Tested builds holds a passing older build and a failing newer build, fill Regression from them. If Reproducibility is Sometimes, one pass does not prove a good build. Then write the last good build as Unknown, or run the older build again until the count is clear. If the user, a trace or a release list names the deploy or commit between them, write it in "Suspect change". If you do not know these builds, write Unknown. Do not guess a commit.
10. Keep facts apart from guesses about the cause. Put guesses under Notes and mark them.
11. Use these statuses: New, Triaged, In progress, Fixed, Ready for retest, Verified, Closed, Reopened. Closing variants: Won't fix, Duplicate, Cannot reproduce, Deferred. A new report has the status New.
12. Write Status and Severity as tags. Write Priority as a tag only when the user gave it. Always use the same colours. Do not use other colours.
   - Status: New gray, Triaged yellow, In progress blue, Fixed green, Ready for retest orange, Verified green, Closed gray, Reopened red, Duplicate purple, Won't fix, Cannot reproduce and Deferred brown.
   - Severity: Critical red, High orange, Medium yellow, Low gray.
   - Priority: P1 red, P2 orange, P3 yellow, P4 gray.
13. Do not put a screenshot in the document as a `[link]` or a `data:` URL. Use `doc_insert_image`.

## Mistakes to avoid

- A title such as "It does not work" or "Fix the button".
- Several bugs in one report.
- Steps with gaps ("then do the usual flow") or steps that start from a dirty state.
- Mixing the expected and actual results in one paragraph.
- Setting severity by how annoying the bug feels, and not by its impact.
- Writing a guess about the cause as a fact.
- No environment or no tested build.
- Reporting a bug that no run or test showed.
- Reporting a flaky failure, a wrong check or an outage as a product bug.
- Writing a second report for a known bug because its title is different.
- Changing the expected result so that the check passes.
- Saying in chat that you checked the bug again when you did not run it again.
- Setting Priority yourself. Priority is `[TBD: P1 / P2 / P3 / P4, set at triage]` unless the user gave it.
- Writing the document in a language that is not the language of the user's own words. Translate the title, the headings and the field names too.

## Sources

- Mozilla bug writing guidelines: https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html
- Chromium bug reporting guidelines: https://www.chromium.org/for-testers/bug-reporting-guidelines/
- VS Code bug template: https://github.com/microsoft/vscode/blob/main/.github/ISSUE_TEMPLATE/bug_report.md
- Atlassian Jira bug report template: https://www.atlassian.com/software/jira/templates/bug-report
- BrowserStack severity vs priority: https://www.browserstack.com/guide/bug-severity-vs-priority
- ISO/IEC/IEEE 29119-3 overview, incident report: https://www.microtool.de/en/document-management/test-documentation-with-iso-iec-ieee-29119-32021/
- Bug status values: synthesis
