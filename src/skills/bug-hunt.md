---
name: bug-hunt
description: Test a web app, site or flow in the browser and try to break it. Use when the user asks to test, QA, find bugs in, or break a running web app, site or user flow in the browser. Not for a design on the canvas.
args:
  - name: target
    description: The URL or the feature to test (optional)
    required: false
user-invokable: true
---

## Purpose

Find real bugs in a running web app. Use the `browse_agent` tool with `qa: true`. The chat response is the only deliverable. If `browse_agent` has no `qa` parameter in this session, tell the user that QA testing needs the browser QA mode, and stop.

## Stance

- Your job is to break the app. Your job is not to confirm that it works.
- A scenario that passes is not a finding.
- A finding comes only from what the browser showed: the page, the console or the network.
- Never report a bug from a guess or from general knowledge.
- Do not claim a bug that no run showed.
- Before you report that a feature does not exist, find the condition that makes it appear. Examples: a deadline or a date, a limit, a threshold, a role, an empty list, a full list. Write a scenario that makes data at that boundary: just below, at and just above. Report "missing" only after that scenario.

## Scope and safety

- If the user gave a URL, do not ask questions. Start.
- Never do an irreversible action in the real world. This includes real payments, messages or emails to real people, and deleting real accounts or data. The exception is data the user marked as test data, or an action the user allowed.
- To test server failures, use `setup.network` mocks. Do not attack the real server.
- Attacks that write data go to a mocked endpoint in `setup.network`. This includes double submit, hostile text in forms that save, signup, orders and messages. The exception is when the user said the target is a test environment or allowed real writes. Read-only attacks may use the real server.
- Do not run load tests or DoS tests.
- Do not attack a third-party site that the user does not own.

## Workflow

Set `setup.fresh: true` in every `qa: true` scenario and in every rerun. This applies per group call (see Checklists). It resets tabs, cookies and storage for the sites that the setup names. It isolates each scenario from the recon run and from other scenarios. The exception is a scenario that continues from a checkpoint.

1. **Recon.** Make one `browse_agent` call WITHOUT `qa`. Ask it to map the pages, forms, modals, lists, navigation and login. Also ask it to record the method and the full URL of each list request and each write request (from the trace request log or the network). Use the map to pick the core flows. Do not reuse the recon tab state. Step 2 and the later steps start fresh.
   - Never guess an API URL. Example: the real URL was workspace-scoped, `/api/v1/workspaces/<id>/contacts`, not `/api/v1/contacts`. Write a `setup.network` mock only from a recorded URL.
   - If recon stops with status `step_limit`, continue with `resume` from its checkpoint, or split recon by page. Do not leave the app map incomplete.
2. **Trial run.** Before you batch mocked scenarios, run one trial scenario with the mock. Confirm that the mock changed the behaviour and that `qa.unmatchedMocks` is absent. A run with `unmatchedMocks` proves nothing about the error path. Fix the URL and rerun.
3. **Round 1: happy path.** Run one `qa: true` scenario for each core flow. If a core happy path fails, rerun it once (see step 5) before you report it. If it fails again, report it and stop attacking that flow. Deep attacks on a broken flow waste runs. If it does not fail again, it is flaky. Continue to attack the flow.
4. **Round 2: attacks.** Read the Round 1 results again. Ask: what did the developer not think about? Pick 2 or 3 attack families from the catalog for each feature. Write each scenario as a narrow `goal`: exact steps and one explicit expected result.
   - Look at the `browse_agent` schema. If it has a `checks` parameter, every attack run MUST pass `checks`. Never send an attack run with no `checks`.
   - Always include `{ "type": "no_console_errors" }`.
   - Also add one check for the expected result: `text`, `count`, `value`, `element` or `url`.
   - If the schema has no `checks` parameter, put the expected result in `goal` only.
   - Take `count` selectors from recon. Do not guess a selector such as `tr`. For table rows use `visible: true`, because a hidden empty-state row also matches.
   - Use CSS selectors only in checks. For text use `{ "type": "text" }`. Do not use `text=` or `:has-text(` in a selector.
   - To check the text of a dialog, write in `goal`: "open the dialog, read it, then cancel; do not delete anything". Do not mix "open the dialog" with "confirm".
5. **Reproduce.** Rerun every failed scenario once with the same `goal` and `setup`. If it does not fail again, report it as flaky.
   - For a grouped call, rerun only the failed items. Make a new call whose `goal` lists only those item IDs, with the same `setup`. Do not rerun the whole group. An item that passes on the rerun is flaky. Do not report it as a bug. The outcomes `inconclusive`, `error` and `setup_failed` are not bugs. Fix the scenario and run it again once, or list it as Blocked / not tested.
   - A scenario with outcome `inconclusive`, `error` or `setup_failed`, or an item with `result: "blocked"`, is **Blocked / not tested**. It is never a bug and never a fail. Do not rerun a `blocked` item more than once.
   - A judge downgrade (the `qa.reason` starts with "Judge:") is a signal. So is `inconclusive` with the reason "Agent said pass, but check failed". Read the failed checks and the judge reason. Fix the check or rerun. Do not dismiss the signal. Do not count it as a defect before a rerun.
6. **Escalate.** Bugs cluster. After a confirmed bug, run 1 or 2 more scenarios near it.
7. **Second pass.** Verify each UX observation with its own run. Do not leave an observation unverified.
8. **Evidence.** For each confirmed bug, put this in the `goal` of the run (or rerun) that shows it: "Take one screenshot with browse_screenshot and waitFor on the element that shows the bug. Place it on the canvas." Then cite the node ids from the `placed` field of the `browse_agent` result.
9. **Checklists.** The user may give a checklist or a list of features to check. Then group the items by screen or by user flow. Do not send one call per item.
   - Send one `qa: true` call per group. A group has 2 to 4 items. Small groups run in parallel and end at about the same time.
   - Send all independent groups in ONE step (see "Parallel runs" for the cap and when it applies). Do not wait for one group before you send the next independent group.
   - Give the subagent URLs only from recon, from the app, or from the user. Do not ask it to try guessed URLs.
   - Put each item with its ID in `goal`. Say: "Give one `items` entry per ID."
   - Put items that need sign-in in the same group as the other items behind that sign-in. The subagent then signs in once.
   - Do not mix items that write data with items that count or list the same data in parallel runs. Isolation covers the browser only. Server state is shared.
   - Each `items` entry has a result: `pass`, `fail` or `blocked`. See step 5 for `blocked`.
   - `qa.outcome` is the verdict of the whole run. It wins over `qa.items`. If the outcome is `failed` and no item failed, the cause is in `qa.reason`: a host check, the judge, or a defect outside the items. If every item was blocked, the result has no verdict and no `qa.items`. Treat every item of that call as blocked.
10. **Budget.** Run about 8 to 12 scenarios in total. Stop earlier when you have 5 or more confirmed bugs. Run more if the user asks.

## Attack catalog

1. **Input boundaries** — fields and numbers at the edge of what is valid.
   Try: empty value, only spaces, 0, -1, the maximum, the maximum plus 1, 10000 characters. For dates, deadlines and thresholds, try a value just below, at and just above the boundary.
   Expect: a clear validation message, no crash, no silent cut of the input.
2. **Hostile text** — text that breaks parsers and layouts.
   Try: mock the write endpoint in `setup.network` when the form saves data. Then enter unicode, emoji, right-to-left text, zero-width characters, `<script>alert(1)</script>`, `' OR 1=1 --`, one very long word with no spaces. In search and filter fields, also type regex and wildcard characters: `(`, `[`, `*`, `+`, `?`, `\`, `%`, `.*`.
   Expect: the text shows as plain text, the layout stays intact, nothing runs. Search does not crash, does not empty the list by error, and logs no console error.
3. **Double actions** — the same action twice, fast.
   Try: mock the write endpoint in `setup.network`. Then double-click on submit, rapid repeated clicks, Enter and click together.
   Expect: exactly one result. No duplicate record. No duplicate charge.
4. **Interrupted flows** — a flow that stops in the middle.
   Try: Escape or close in the middle of a step, the browser Back button, reload in the middle of a form, open the URL of a late step directly.
   Expect: the state is kept, or the flow restarts cleanly. No blank page. No stuck state.
5. **Navigation and URLs** — links and addresses.
   Try: deep links, an unknown route, a changed id in the URL, a changed or missing query parameter.
   Expect: a designed 404 or a redirect. No raw error. No data of another user.
6. **Server failures** — use `setup.network` to simulate them.
   Try: status 500, status 4xx, `abort`, a slow response with `delayMs`, an empty body, a malformed JSON body.
   Expect: an error message, a way to retry, no infinite spinner, no lost user input.
7. **Empty and huge data** — lists with too little or too much data.
   Try: zero items, one item, many items. Use mocks in `setup.network`. If recon showed no list request, the server renders the list, and a response mock cannot empty it. Then use a search or filter that matches nothing, or a test account with no data. If neither is possible, mark the case untested.
   Expect: a designed empty state. Pagination or scroll works. Long titles do not break the layout.
8. **Viewport and device** — use `setup.emulate`.
   Try: `setup.emulate.device` `iphone-15`, `pixel-8`, `ipad` or `desktop-1920`, or a narrow `setup.emulate.viewport`, a tablet in landscape.
   Expect: no horizontal scroll, no overlap, every control reachable and tappable.
9. **Locale and time** — formats and zones.
   Try: `setup.emulate.locale` de-DE and ar, a `setup.emulate.timezone` far from UTC, a date near midnight or a DST change.
   Expect: correct date, number and currency formats. No off-by-one day. If the app supports right-to-left languages, the layout mirrors correctly.
10. **Keyboard only** — no mouse.
    Try: Tab through the page, Enter and Space on controls, Escape on dialogs.
    Expect: a logical Tab order, a visible focus, Escape closes dialogs, no focus trap.
11. **State and sessions** — more than one context.
    Try: two tabs, logout in one tab, an expired session cookie set in `setup`, stale data after an edit.
    Expect: consistent state in all views, a redirect to login after expiry, no stale data.
12. **Preferences** — user settings of the system.
    Try: `setup.emulate.colorScheme` dark, `setup.emulate.reducedMotion` on.
    Expect: readable text and contrast, no invisible elements, no required animation.

## Writing a scenario

A good scenario has exact steps and one expected result. Example of a server failure on submit:

```json
{
  "qa": true,
  "url": "https://example.com/signup",
  "goal": "Fill the form with name 'Test User' and email 'test@example.com'. Click 'Create account' once. Expected: an error message appears, the button works again, and the fields keep their values.",
  "setup": {
    "fresh": true,
    "network": [{ "url": "*/api/signup", "status": 500, "delayMs": 1500 }]
  },
  "checks": [
    { "type": "no_console_errors" },
    { "type": "value", "selector": "input[name=email]", "equals": "test@example.com" }
  ]
}
```

Take the mock URL from recon. Use the real field names of the `browse_agent` schema in your call. Send `checks` whenever the schema has it.

A bad goal: "Test the form."
Why it is bad: it has no steps, no input and no expected result. The subagent cannot decide pass or fail. The result tells you nothing.

## Parallel runs

- If your instructions or the `browse_agent` tool say that QA runs are isolated, issue up to 4 `qa: true` calls in the same step.
- Otherwise run the scenarios one by one.

## Report

Write the report in the user's language. Use this order.

1. A summary line: scenarios run, bugs, flaky, blocked.
2. **Bugs**, sorted by severity. For each bug give:
   - Title
   - Steps to reproduce
   - Expected result
   - Actual result
   - Evidence: `qa.reason`, console errors, failed requests
3. **Flaky.** Scenarios that failed once and passed on the rerun. Give the steps and what failed the first time.
4. **UX observations.** Keep them apart from bugs.
5. **Blocked / not tested.** Give a reason for each item. A blocked item is not a bug and not a fail.

When the user gave a checklist, list every item with one of three states: pass, fail or blocked. Give the reason for each fail and each blocked item. If `qa.outcome` is `failed` but no item failed, report the cause from `qa.reason`. If a call had no `qa.items` because every item was blocked, list every item of that call as blocked.

Severity levels:
- Critical: data loss, security problem, payment error, or the core flow is blocked.
- High: a main feature fails and there is no workaround.
- Medium: a feature fails but a workaround exists.
- Low: a cosmetic or rare problem.
