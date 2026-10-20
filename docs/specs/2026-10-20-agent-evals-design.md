# Agent evals (prototype / slides / research)

Date: 2026-10-20. Source: Anthropic, "Demystifying evals for AI agents".

## Why

The agent is judged today by `/improve-design-agent`: a few showcase runs, a
person reads the PNGs, "1 of 3 = suspected". There is no number that moves
over time, no fixed regression set built from shipped bugs, and no check of
how far the LLM judge (`tasteCheck`) agrees with a human. This adds a small
eval harness that gives those numbers.

## Scope

- In: prototype (mobile screens), slides, prototype routing from a plain chat
  turn, research (via the `/research` skill; needs `MOBBIN_ACCESS_TOKEN`).
- Out: **edits mode** (user decision). **browse** — it already has its own
  benches (see `@sideform/browser-agent`), not duplicated here.
- Out: CI. Evals spend real tokens. They run by hand only. Unit tests of the
  harness itself DO run in CI like any other test (LLM mocked).

## Hard constraint: the LLM is OpenCode Go, never OpenRouter

- The agent model is an `opencode-go/<id>` ref from
  `OPENCODE_CHAT_COMPLETIONS_MODELS["opencode-go"]` (`src/ai/opencode.ts`).
  Default `opencode-go/deepseek-v4-pro`, override with `--model`. A
  ref without the `opencode-go/` prefix is a usage error.
- The key comes from env `OPENCODE_GO_API_KEY`, read **only** by the eval CLI
  and passed as `prepareChatTurn({ opencodeApiKey })`. It is never added to
  `src/config.ts` (the product has no server-side OpenCode key by design,
  `docs/specs/2026-09-18-opencode-byok-design.md`). Missing key = exit 2 with
  a clear message.
- `generate_image` is emulated with the runner's picsum placeholder
  (`placeholderImageUrl` in `src/showcase/runner.ts`) — real generation goes
  through OpenRouter.
- Guard: the eval CLI wraps `globalThis.fetch` and rejects any request whose
  host ends in `openrouter.ai`. A trial that hits the guard is recorded as
  `infra_error: "openrouter_blocked"` (with the URL), not as an agent failure.
  This is the proof the constraint held.
- `config.ts` still demands `OPENROUTER_API_KEY` to boot. The CLI may put a
  dummy value in `process.env` before `loadConfig()` when it is unset; the
  guard makes any real use visible.
- The LLM judge is `tasteCheck` (`src/ai/tasteCheck.ts`, TypeSafe SystemOne,
  not OpenRouter). When `TYPESAFE_API_KEY` is unset, graders that need it
  report `skipped`, never pass.

## Terms (from the article)

- **task** — one prompt + mode + list of graders. **trial** — one run of a task.
- **transcript** — ordered tool calls (name, args, result) + final text + step
  count + finish reason, saved per trial.
- **outcome** — the harvested embeds (name, width, height, x, y, htmlContent)
  and issued image URLs.
- **suite** — `regression` (should sit near 100%) or `capability` (may be low).

## Harness

One trial = one `prepareChatTurn` + `generateText` loop, the same way
`runShowcaseGeneration` does it (shared turn, local `execute` additions only —
the root CLAUDE.md rule: never assemble a separate system prompt or tool set).
Emulated tools:

- `get_editor_state`, `get_variables` — the runner's empty-document answers.
- `ask_user` — recorded in the transcript, answered with the runner's
  `DELEGATED_BRIEF_ANSWER`.
- `batch_design` — harvests embeds with `extractEmbeds`, also keeps the raw
  `operations` string for graders.
- `generate_image` — placeholder URL, counted, URL recorded as issued.
- every other client-executed tool — the runner's "unavailable" stub;
  `get_screenshot` removed, as in the runner.

Reuse the runner's pieces by exporting them from `runner.ts` (or moving them to
a small shared module the runner imports). Do not copy them. The showcase
runner's behaviour must not change.

Step cap: `SHOWCASE_MAX_STEPS`. No retry inside a trial: a model flake is a
failed trial (the article counts it — pass^k should see it). A trial that dies
on transport / HTTP 5xx / guard is `infra_error` and is excluded from pass
rates but reported in a separate count.

## Graders

Every grader returns `{ id, status: "pass" | "fail" | "skipped", detail }`.
A trial passes when no grader fails and at least one did not skip. Prefer
deterministic graders. Grade the outcome, not the path, except where the path
is the behaviour under test (routing, ask_user).

Deterministic:

- `embeds-present` — at least N embeds harvested.
- `embed-only` — every insert op in every `batch_design` call is an embed
  (FIR-45 embed-only guard).
- `box-size` — every embed is W×H (mobile: preset from `src/showcase/platform.ts`;
  slides: 1024×768).
- `filmstrip` — slides share one `y` and `x` increases strictly left to right.
- `html-complete` — the number of embed inserts in the raw `operations`
  strings equals the number harvested, and every `htmlContent` closes
  (`</html>` or `</body>`). Regression for the unescaped-quote truncation.
- `image-urls-issued` — every `<img src>` / CSS `url()` with an http(s) URL is
  either an issued URL, or a known stock host (picsum.photos,
  images.unsplash.com). An URL within edit distance 3 of an issued URL but not
  equal is a fail and is named in `detail`. Regression for mistyped image URLs.
- `image-budget` — `generate_image` calls ≤ `MAX_GENERATED_IMAGES`.
- `asked-first` / `not-asked` — `ask_user` called before the first
  `batch_design` / never called.
- `skill-loaded-first` — `load_skill` with the expected name before the first
  `batch_design`. Regression for prototype routing.
- `grounded-refs` (research) — every URL in the final text appears in some
  tool result of the trial. If the turn had no MCP tools the grader and the
  trial are `skipped` with reason `no_mcp_tools`.

Model-based:

- `taste-clean` — `runTasteCheck` over the harvested screens reports no
  findings. Capability suite only.

## Tasks (first set, ~12)

Regression:

- `reg-routing-prototype` — default mode, "create a new mobile onboarding
  screen for a meditation app" → `skill-loaded-first(prototype)`,
  `embeds-present(1)`, `embed-only`.
- `reg-quotes` — prototype, a reviews screen whose copy is full of quotes and
  apostrophes (Russian «» and English ' ") → `html-complete`, `embeds-present`.
- `reg-image-urls` — prototype, image-heavy travel screens →
  `image-urls-issued`, `image-budget`.
- `reg-mobile-box` — prototype, 3-screen flow → `box-size`, `embed-only`,
  `embeds-present(3)`.
- `reg-slides-structure` — slides, 5-slide deck → `box-size(1024×768)`,
  `filmstrip`, `embeds-present(5)`.

Negative / positive pairs (regression — they come straight from the skill
text "Skip this only if the user's message already pins down every one of
these"):

- `neg-ask-pinned-prototype` — brief that pins audience, platform, visitor
  mode, tone, scope, reuse → `not-asked`.
- `pos-ask-vague-prototype` — "make a screen for a coffee shop app" →
  `asked-first`.
- `neg-ask-pinned-slides` / `pos-ask-vague-slides` — the same pair for slides.

Capability:

- `cap-taste-mobile` — themed 3-screen flow → `taste-clean`.
- `cap-taste-slides` — 5-slide deck → `taste-clean`.
- `cap-research-grounded` — research mode, "find onboarding references for a
  fintech app" → `grounded-refs`.

Tasks live in code (`src/evals/tasks.ts`), each with `id`, `suite`, `mode`,
`prompt`, `graders`, and `source` (incident / skill line it came from, same
rule as `probes/`: an incident-sourced task is not softened later).

## Metrics

Per task with n non-infra trials and c passes, unbiased estimators:
`pass@k = 1 − C(n−c, k) / C(n, k)`, `pass^k = C(c, k) / C(n, k)` (0 when
n < k). Report pass@1 and pass^k for the chosen k (default 3), per task and
mean per suite, plus infra-error count.

## CLI and storage

```
npm run evals:run -- [--suite=regression|capability|all] [--task=<id>] [--k=3] [--model=opencode-go/<id>] [--concurrency=2]
npm run evals:calibrate -- --labels=<file>
```

- `evals:run` writes `evals/runs/<timestamp>-<model>/` (gitignored):
  `trials/<task>-<n>.json` (transcript + outcome + grader results) and
  `screens/<task>-<n>-<name>.html`. It prints a table and appends one JSON line
  per run to `evals/history.jsonl` (tracked): date, git sha, model, k, suite,
  per-task {n, c, infra, pass@1, pass^k}. It also writes
  `labels.template.json` listing every harvested screen for human labelling.
- Exit code 0 when the run completed (pass rates are data, not failure).

## Calibration

`evals:calibrate --labels=<file>`: the file lists screens (run dir + screen
file) with a human verdict per taste rule id (`pass` / `fail` / `unknown`).
The command runs `runTasteCheck` on the same HTML and prints, per rule:
agreement %, Cohen's kappa, false-pass and false-fail counts. `unknown` labels
are excluded. Output also goes to `evals/calibration.jsonl` (tracked). A rule
with < 10 labelled screens prints "not enough labels".

## Probes

`probes/showcase-mobile.md` gets a `tier:` field per probe — `regression` for
incident-sourced and pipeline-invariant probes, `capability` for taste
probes (P-009, P-011, P-012). The header explains the two tiers.

## Tests (CI, no keys)

- metrics: estimator values on known (n, c, k).
- every deterministic grader: pass and fail fixture.
- harness: one trial with `MockLanguageModelV3` that calls `ask_user` then
  `batch_design`; check transcript order and harvested embed.
- guard: an `openrouter.ai` fetch is rejected and reported as
  `openrouter_blocked`.
- CLI arg parsing: a model without the `opencode-go/` prefix is rejected.
- calibration: agreement and kappa on a fixed label set.

## Left to the builder

File split inside `src/evals/`, exact prompts of the tasks, table formatting.
