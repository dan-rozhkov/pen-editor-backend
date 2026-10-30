---
name: test-report
description: Write a test summary or completion report after testing, with a release verdict. Use when the user asks for a test report, test summary, QA report, test results or a go/no-go decision, or says "отчёт о тестировании", "итоги тестирования", "тест-репорт", "отчёт QA".
args:
  - name: topic
    description: The product, feature or flow the document is about (optional)
    required: false
user-invokable: true
---

## Purpose

A test report tells the reader what was tested, what the results were and whether the build can be released. Managers and product owners read the verdict first. The team reads the numbers, the open defects and their evidence. The report is written against the test plan.

## Gather the inputs

Use what the conversation already has first:

- The test plan in the document list. Call `doc_list`, then `doc_read`. Take the scope, the planned case count and the exit criteria from it.
- `browse_agent` results with `qa: true` from earlier in the conversation, for example a bug-hunt run. Use only what those results show.
- Browser runs saved as traces. If `trace_read` is in your tool list, read the run there. A run of this chat gives its trace id in `trace.id` of the `browse_agent` result. `trace_list` lists only the traces that are open as tabs. Read in the trace: steps, console errors, failed requests and, for a QA run, its checks. A trace without QA results has no verdict. The trace link of a run is the evidence for its result.
- Bug reports already written in this conversation or in the document list.
- Results that the user pasted or attached.

Map QA scenario outcomes into the counts like this:

- `passed` goes to Passed.
- `failed`, confirmed on the rerun, goes to Failed.
- A scenario that failed and then passed on the rerun is flaky. Report it separately. It is not a failure.
- A judge downgrade (the `qa.reason` starts with "Judge:") and `inconclusive` with the reason "Agent said pass, but check failed" are not a pass. Read the failed checks and the judge reason. Count the scenario as Failed only after a rerun that confirmed it. Otherwise count it as Blocked or not run, with the reason.
- A run with `qa.unmatchedMocks` is not verified. The mock did not run. Count the scenario as not run.
- `inconclusive`, `error`, `setup_failed` and `aborted` are not a pass and not a failure. Count each one as Blocked or not run, with the reason.
- A scenario that was planned and not run goes to not run. A scenario that could not start because of a blocker goes to blocked.

Facts you need: the build under test, the environment, the dates, the planned count, the results, the open defects.

If key facts are missing and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts only. Do not ask for facts you can find.

Never invent facts. Numbers must come from real results. Never invent counts, dates, names or versions. Put a visible placeholder `[TBD: what is missing]` instead. If you have no results, write the report skeleton and say that the counts are missing.

## Output

- Write the document with `doc_create`. The title is `Test report: [subject]`, for example "Test report: Checkout". If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing document, use `doc_list`, `doc_read`, then `doc_edit`.
- Write in the user's language. Translate the template headings and labels. Keep IDs such as `TC-01` and `BUG-01`, and the status values, the same inside the document.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- Write the metadata table as a property list (see the `doc_create` description). Write a date as `YYYY-MM-DD`.
- Write the verdict as a callout. The template starts with `> [!WARNING]` and `[TBD: Go / Go with conditions / No-go]`. Set the callout kind to match the verdict: Go is `> [!IMPORTANT]`, Go with conditions is `> [!WARNING]`, No-go is `> [!CAUTION]`. Then write the verdict text and the reason.
- Link the test plan in the property list as `[Title](/doc?id={docId})` (the docId comes from `doc_list`). Link every defect to its bug report document the same way. If no such document exists, write `[TBD: ...]` text, not a link.
- The Evidence cell holds a trace link in the form `[Trace: {short goal}](/trace/{traceId}?src={source})`, or a screenshot. Take the link from `trace.href` of the `browse_agent` result, or build it from the trace id. The source is `local` for a trace read with `trace_read`. Never write a bare trace id. If no evidence exists, write `[TBD: evidence]`. Never invent a link.
- Write the exit criteria status and the defect fields as tags with fixed colours: Met green, Not met red. Severity: Critical red, High orange, Medium yellow, Low gray. Use the same tags as the bug-report and test-plan documents.
- Delete optional sections that do not apply. Do not leave empty headings.
- The H1 of the template is the `title` argument of `doc_create`. Start `markdown` after it, with the first section. The document shows the title above the body, so a `#` heading with the title in the body shows it twice.
- After `doc_create`, reply in chat with 1 to 3 sentences. Give the verdict and name the `[TBD]` items the user must fill.

## Template

````markdown
# Test report: [subject]

## Verdict

> [!WARNING]
> **[TBD: Go / Go with conditions / No-go]** [2-3 sentences: the reason. Name the blocking defects or the conditions.]

|  |  |
| --- | --- |
| Build under test | [version or build id] |
| Environment | [URL, browser, device] |
| Test period | [TBD: YYYY-MM-DD to YYYY-MM-DD] |
| Test plan | [TBD: link to the test plan] |

## Results

| Planned | Passed | Failed | Flaky | Blocked | Not run |
| --- | --- | --- | --- | --- | --- |
| [N] | [N] | [N] | [N] | [N] | [N] |

- Flaky: [case IDs: failed once, passed on the rerun]
- Blocked and not run: [case IDs, and the reason for each]

## Exit criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| [All P1 cases passed] | [TBD: Met / Not met] | [numbers and case IDs] |
| [No open Critical or High defects] | [TBD: Met / Not met] | [defect IDs, or None] |

## Open defects and evidence

| Defect | Severity | Status | Case | Evidence |
| --- | --- | --- | --- | --- |
| [TBD: link to the bug report] | [TBD: severity] | [TBD: status] | [TC-03 / None] | [Trace: {short goal}](/trace/{traceId}?src={source}) |
````

## Writing rules

1. Put the verdict first. The reader must know Go, No-go or Go with conditions before any table.
2. Explain every number: what it is out of and which cases failed.
3. State the build under test and the environment exactly.
4. Report against the plan. Use the plan's scope, case list and exit criteria. Do not change them to match the results.
5. Show each exit criterion as met or not met, with its evidence. The verdict follows from the criteria.
6. Show open Critical and High defects in the verdict text, not only in the table.
7. Do not hide blocked or not-run tests. Give the case IDs and the reason in the "Blocked and not run" line.
8. Report flaky scenarios (failed once, passed on the rerun) in the Flaky column and the Flaky line under Results, apart from failures and passes. Count inconclusive, error, setup_failed and aborted outcomes as Blocked or not run, with the reason. Do not count any of them as bugs or as passed.
9. Use the same severity scale as the bug reports: Critical, High, Medium, Low.
10. Keep the numbers consistent. Planned = Passed + Failed + Flaky + Blocked + Not run. A flaky case is not in Passed and not in Failed. If a number is unknown, write `[TBD]`. Do not guess.
11. Keep the report short. Link to the bug reports and the plan. Do not copy them.
12. Every open defect and every exit criterion cites its evidence: a trace link, a screenshot or a bug report link. A pass needs evidence too: a case with no run, trace or result from the user is not a pass, so count it as not run. A confirmed failure stays Failed even if it has no trace; write `[TBD: evidence]` in its Evidence cell.
13. List every open defect of the build, also one with no failed case of this plan (for example from an exploratory run). Write `None` in its Case cell.

## Mistakes to avoid

- A verdict at the end, after a long list of results.
- Counts that were not taken from real results.
- A number with no explanation.
- An open defect or a met criterion with no evidence.
- A passing result with no mention of a failed Critical case.
- Counting flaky or error outcomes as failed, or as passed.
- Leaving out the not-run and blocked tests.
- Changing the exit criteria after the run so that they are met.
- No build version, so nobody knows what was tested.

## Sources

- ISO/IEC/IEEE 29119-3 overview, test status report and test completion report: https://www.microtool.de/en/document-management/test-documentation-with-iso-iec-ieee-29119-32021/
- TestRail test summary report: https://www.testrail.com/blog/test-summary-report/
- IEEE 829 summary: https://en.wikipedia.org/wiki/Software_test_documentation
- ISTQB exit criteria set in the plan, evaluated in the report, used for the release decision: synthesis from a glossary mirror
- BrowserStack severity vs priority: https://www.browserstack.com/guide/bug-severity-vs-priority
