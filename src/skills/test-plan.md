---
name: test-plan
description: Write a test plan with test scenarios and test cases for a feature or product. Use when the user asks for a test plan, test cases, test scenarios, or a test strategy, or says "тест-план", "тест-кейсы", "сценарии тестирования".
args:
  - name: topic
    description: The product, feature or flow the document is about (optional)
    required: false
user-invokable: true
---

## Purpose

A test plan says what will be tested, how, by whom and when, and when testing is done. The team uses it to agree on scope before testing starts. Testers use the test cases to run the checks. The test report later compares its results to this plan. This skill writes the plan as a document. To actually test a running app in the browser, the `bug-hunt` skill is the right one.

## Gather the inputs

Use what the conversation already has first. Fit these sources to the request:

- The feature spec or PRD that the user gave or attached. It is the main source of requirements.
- The design on the canvas. Call `get_editor_state` to list the screens, states, forms and controls. Each screen state is a candidate for a scenario.
- A repo read earlier with `read_design_repo`, for routes, validation rules and limits.
- A live app. Only if the spec is not enough and the user gave a URL, make one recon `browse_agent` call WITHOUT `qa`. Ask it to map pages, forms, modals and navigation.

Facts you need: the feature and its requirements, the target platforms and builds, the test data kinds, the team and the dates.

If key facts are missing and the `ask_user` tool is in your tool list, call it ONCE with a short form for the missing facts only. Do not ask for facts you can find.

Never invent facts: requirements, versions, dates, names, limits. Put a visible placeholder `[TBD: what is missing]` instead.

## Output

- Write the document with `doc_create`. The title is `Test plan: [subject]`, for example "Test plan: Checkout". If `doc_create` is not in your tool list, reply in chat with the same markdown.
- To update an existing document, use `doc_list`, `doc_read`, then `doc_edit`.
- Write in the user's language. Translate the template headings and labels. Keep IDs such as `TC-01` and `SC-01`, and the status and priority values, the same inside the document.
- Use only the markdown that the `doc_create` description allows. A table cell holds ONE line of inline text. Put multi-line content in lists under a heading.
- Put steps in numbered lists under the test case heading.
- A `mermaid` code block renders a diagram.
- Delete optional sections that do not apply. Do not leave empty headings.
- After `doc_create`, reply in chat with 1 to 3 sentences. Say what the plan covers and which `[TBD]` items the user must fill.

## Template

````markdown
# Test plan: [subject]

| Field | Value |
| --- | --- |
| Version | [1.0] |
| Author | [name] |
| Date | [date] |
| Build under test | [version or build id] |

## 1. Introduction

[2-3 sentences: what is tested and why.]

## 2. Scope

**In scope**
- [feature or flow]

**Out of scope**
- [feature or flow, and the reason it is not tested]

## 3. Test approach

- Test types: [functional, negative, boundary, usability, compatibility]
- Levels: [manual, automated, exploratory]
- Tools: [tools]

## 4. Entry and exit criteria

**Entry criteria**
- [The build is deployed to the test environment.]
- [Test data is ready.]

**Exit criteria**
- [100% of P1 cases executed and passed.]
- [No open Critical or High defects.]
- [At least 95% of all cases executed.]

## 5. Environment and data

| Item | Value |
| --- | --- |
| Environment | [test URL] |
| Browsers and devices | [Chrome 130, Safari 18, iPhone 15] |
| Accounts and roles | [kind of account] |
| Test data | [kind of data, not real personal data] |

## 6. Test scenarios

| ID | Scenario | Requirement | Priority | Type |
| --- | --- | --- | --- | --- |
| SC-01 | [User can pay with a valid card] | [REQ-12] | P1 | Functional |
| SC-02 | [Payment is refused for an expired card] | [REQ-13] | P1 | Negative |

## 7. Test cases

### TC-01 [Pay with a valid card]

- **Scenario:** SC-01
- **Priority:** P1
- **Type:** Functional

**Preconditions**
- [A signed-in user has at least one item in the cart.]

**Steps**
1. [Open the cart.]
2. [Start the checkout.]
3. [Enter valid card data.]
4. [Confirm the payment.]

**Expected result**
- [The order is created and its confirmation page shows the order number.]
- [The cart is empty.]

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| [Test environment is unstable] | [Delay] | [Daily smoke check] |

## 9. Roles and schedule

| Role | Person | Task | Dates |
| --- | --- | --- | --- |
| [QA lead] | [name] | [Plan and report] | [dates] |

## 10. Traceability (optional)

| Requirement | Scenarios | Cases |
| --- | --- | --- |
| [REQ-12] | SC-01 | TC-01 |
````

## Writing rules

1. Write one behaviour per test case. Do not chain many checks into one long script.
2. Make cases independent. A case must not need the result of another case.
3. Describe preconditions as kinds of data ("a user with an expired subscription"). Do not hardcode values.
4. Give every scenario and case a unique ID and a link to a requirement.
5. Write expected results that a tester can check. "The page loads correctly" is not testable. "The page shows the order number and the total" is testable.
6. Cover negative and boundary cases, not only the happy path. Use empty value, minimum, maximum, maximum plus 1, wrong format, no permission, network failure.
7. Put steps in a numbered list under each `### TC-xx` heading. Never put steps in table cells.
8. Gherkin Given/When/Then is an option for behaviour scenarios. Use the declarative style: write the behaviour, not the clicks. Do not write UI wording such as "click the blue button". Do not hardcode data.
9. Write exit criteria that can be measured: a number or a yes/no check. Write environment versions exactly.
10. State what is out of scope and why. Features that are not tested are part of the plan.

## Mistakes to avoid

- Happy path only, with no negative or boundary cases.
- Long chained scripts where one failed step hides all later checks.
- Vague expected results such as "works as expected".
- No out-of-scope list.
- Exit criteria without numbers, such as "quality is good".
- Hardcoded test data or real personal data in the cases.
- Cases that copy the spec text and do not say what to check.
- Invented requirements, versions or dates.

## Sources

- ISO/IEC/IEEE 29119-3 overview: https://www.microtool.de/en/document-management/test-documentation-with-iso-iec-ieee-29119-32021/
- IEEE 829 summary, including "features not to be tested": https://en.wikipedia.org/wiki/Software_test_documentation
- Cucumber Better Gherkin: https://cucumber.io/docs/bdd/better-gherkin/
- ISTQB entry and exit criteria: synthesis from a glossary mirror
- Test case rules and common mistakes: synthesis of the sources above
