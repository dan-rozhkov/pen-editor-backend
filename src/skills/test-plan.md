---
name: test-plan
description: Write a test plan with test cases and the evidence to capture for a feature or product. Use when the user asks for a test plan, test cases, test scenarios, or a test strategy, or says "тест-план", "тест-кейсы", "сценарии тестирования".
args:
  - name: topic
    description: The product, feature or flow the document is about (optional)
    required: false
user-invokable: true
---

## Purpose

A test plan says what will be tested and when testing is done. The team uses it to agree on scope before testing starts. Testers use the test cases to run the checks, and each case says what evidence proves it. The test report later links to that evidence. This skill writes the plan as a document. To actually test a running app in the browser, the `bug-hunt` skill is the right one.

## Gather the inputs

Use what the conversation already has first. Fit these sources to the request:

- The feature spec or PRD that the user gave or attached. It is the main source of requirements.
- The design on the canvas, only if a canvas tab is already open (do not open one for this document). Call `get_editor_state` to list the screens, states, forms and controls. Each screen state is a candidate for a test case.
- A repo read earlier with `read_design_repo`, for routes, validation rules and limits.
- A live app. Only if the spec is not enough and the user gave a URL, make one recon `browse_agent` call WITHOUT `qa`. Ask it to map pages, forms, modals and navigation.

Facts you need: the feature and its requirements, the target platforms and builds, and the dates.

If key facts are missing and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts only. Do not ask for facts you can find.

Never invent facts: requirements, versions, dates, names, limits. Put a visible placeholder `[TBD: what is missing]` instead.

## Output

- Write the document with `doc_create`. The title is `Test plan: [subject]`, for example "Test plan: Checkout". If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing document, use `doc_list`, `doc_read`, then `doc_edit`.
- Write in the user's language. Translate the template headings and labels. Keep IDs such as `TC-01`, and the status and priority values, the same inside the document.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- Put steps in numbered lists under the test case heading.
- A `mermaid` code block renders a diagram.
- Write the metadata table as a property list (see the `doc_create` description). Write a date as `YYYY-MM-DD`.
- Call `doc_list`. If a design spec of the subject exists, link it as `[Title](/doc?id={docId})` (the docId comes from `doc_list`). If none exists, write `[TBD: ...]` text, not a link.
- In the test cases table, replace each `[TBD: P1 / P2 / P3 / P4]` placeholder with the Priority tag.
- Write Priority as a tag with a fixed colour: P1 red, P2 orange, P3 yellow, P4 gray. Use the same tags in the bug-report documents.
- Delete optional sections that do not apply. Do not leave empty headings.
- The H1 of the template is the `title` argument of `doc_create`. Start `markdown` after it, with the first section. The document shows the title above the body, so a `#` heading with the title in the body shows it twice.
- After `doc_create`, reply in chat with 1 to 3 sentences. Say what the plan covers and which `[TBD]` items the user must fill.

## Template

````markdown
# Test plan: [subject]

|  |  |
| --- | --- |
| Build under test | [version or build id] |
| Environment | [test URL, browsers and devices] |
| Dates | [TBD: YYYY-MM-DD to YYYY-MM-DD] |
| Design spec | [TBD: link to the design spec, or leave empty] |

## Scope

**In scope**
- [feature or flow]

**Out of scope**
- [feature or flow, and the reason it is not tested]

## Exit criteria

- [All P1 cases passed, each with its evidence.]
- [No open Critical or High defects.]

## Test cases

| ID | Case | Priority |
| --- | --- | --- |
| TC-01 | [Pay with a valid card] | [TBD: P1 / P2 / P3 / P4] |
| TC-02 | [Payment is refused for an expired card] | [TBD: P1 / P2 / P3 / P4] |

### TC-01 [Pay with a valid card]

**Preconditions**
- [A signed-in user has at least one item in the cart.]

**Steps**
1. [Open the cart.]
2. [Start the checkout.]
3. [Enter valid card data and confirm the payment.]

**Expected result**
- [The confirmation page shows the order number.]

**Evidence to capture**
- [Screenshot of the confirmation page with the order number.]
- [The order request and its success status, from the network log or the trace.]
````

## Writing rules

1. Give every case an `Evidence to capture` list: the screenshot, request, log line or trace that proves the expected result. A tester marks a case passed only with that evidence. A test report links to it.
2. Write one behaviour per test case. Do not chain many checks into one long script.
3. Make cases independent. A case must not need the result of another case.
4. Describe preconditions as kinds of data ("a user with an expired subscription"). Do not hardcode values.
5. Give every case a unique ID. If the spec numbers its requirements, name the requirement in the case heading, for example `TC-01 [REQ-12] Pay with a valid card`, so that a requirement with no case is easy to see.
6. Write expected results that a tester can check. "The page loads correctly" is not testable. "The page shows the order number and the total" is testable.
7. Cover negative and boundary cases, not only the happy path. Use empty value, minimum, maximum, maximum plus 1, wrong format, no permission, network failure.
8. Put steps in a numbered list under each `### TC-xx` heading. Never put steps in table cells.
9. Gherkin Given/When/Then is an option for behaviour scenarios. Use the declarative style: write the behaviour, not the clicks. Do not write UI wording such as "click the blue button". Do not hardcode data.
10. Write the exit criteria so that it can be measured: a number or a yes/no check. Write environment versions exactly.
11. State what is out of scope and why. Features that are not tested are part of the plan.

## Mistakes to avoid

- Happy path only, with no negative or boundary cases.
- Long chained scripts where one failed step hides all later checks.
- Vague expected results such as "works as expected".
- No out-of-scope list.
- Exit criteria without numbers or checks, such as "quality is good".
- A case with no evidence to capture, or evidence that does not show the expected result.
- Hardcoded test data or real personal data in the cases.
- Cases that copy the spec text and do not say what to check.
- Invented requirements, versions or dates.

## Sources

- ISO/IEC/IEEE 29119-3 overview: https://www.microtool.de/en/document-management/test-documentation-with-iso-iec-ieee-29119-32021/
- IEEE 829 summary, including "features not to be tested": https://en.wikipedia.org/wiki/Software_test_documentation
- Cucumber Better Gherkin: https://cucumber.io/docs/bdd/better-gherkin/
- ISTQB entry and exit criteria: synthesis from a glossary mirror
- Test case rules and common mistakes: synthesis of the sources above
