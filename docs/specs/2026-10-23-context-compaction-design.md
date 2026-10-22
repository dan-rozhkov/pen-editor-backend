# Context compaction — design (draft)

Status: draft plan, not implemented. Date: 2026-10-23.

## Problem

The chat history has no general bound today.

- The frontend keeps the history in `useChat` memory. Every request sends the full
  UIMessage list, including each tool-loop auto-continuation
  (`pen-editor/src/hooks/useDesignChat.ts`, `agent-harness` transport).
- The backend bounds only images (`image-budget.ts`, `imageRelevance.ts`,
  `vision-messages.ts`), MCP binary payloads (`mcp.ts`) and the skill catalogs.
- Text grows without a bound. The largest sources are:
  - `batch_design` tool-call **inputs** (full embed HTML per screen),
  - `batch_get` results (full `htmlContent` of embeds, no character cap),
  - `read_embed_html` in `full` view (no cap),
  - `snapshot_layout` results.
- A provider "context too long" error is not classified. It is not retried,
  it is not recovered, and the user sees `"An error occurred."`.

The windows of most models are about 1M tokens (`kimi-k2.7-code`: 262K), so a hard
overflow is rare. The more frequent costs are:

1. **Money and latency.** Each auto-continuation re-sends the whole history.
2. **Quality.** Long contexts degrade answers ("context rot"), well before the window
   is full.
3. **The rare hard overflow**, which ends the session with an opaque error.

## What the research says

| Source | Finding that changes our design |
|---|---|
| JetBrains / TUM, "The Complexity Trap" (NeurIPS DL4Code 2025, arXiv 2508.21433) | Observation masking (replace old tool outputs with a placeholder, keep the agent's reasoning and actions) cut cost by about 50% and matched or beat LLM summarization on solve rate. Summaries made trajectories 13–15% longer and cost up to 7% extra in summary calls. Recommendation: mask first, summarize late, keep a verbatim tail. |
| Anthropic, "Effective context engineering for AI agents" | Tool-result clearing is "the lightest touch" form of compaction. Tune a summary prompt for recall first, then for precision. Over-aggressive compaction loses details whose value shows later. |
| Anthropic API docs (compaction, context editing) | Server compaction keeps recent turns verbatim and replaces the older turns with one summary block. Context editing clears old tool results by rule. Both are Claude-API-only — we route through OpenRouter/OpenCode, so we must build our own. |
| Manus, "Context Engineering … Lessons from Building Manus" | KV-cache hit rate is the key production metric. Keep the prefix stable and the context append-only. Make compression **restorable**: drop content, keep the reference (URL, path) to fetch it again. Keep errors in context. |
| OpenCode (`packages/core/src/session/compaction.ts`, `docs/compaction.mdx`) | Trigger = window − reserve (15%, at least 16K). Keep about 15K recent tokens verbatim beside the summary. Send the summary request **as the normal request plus a summary prompt** so it reads the prompt cache. Later compactions *update* the previous summary. A provider "too long" rejection triggers one recovery compaction with shrink steps 0.85/0.7/0.5/0.35. A structured template: Objective, Requirements, Decisions, Work State, Next Move, Relevant Files, Important Context. |
| Codex CLI | Auto-compact at about 90% of the window. Keep up to 20K tokens of recent user messages verbatim. Re-inject recently edited files after compaction. Users complain when compaction fires mid-task without warning. |
| Vercel AI SDK cookbook | `prepareStep` + `pruneMessages({ toolCalls: 'before-last-3-messages', reasoning: 'all' })` above a token estimate. No LLM-summary recipe. No cross-request state. |

Conclusions for us:

1. Do masking before summaries. It is cheap, deterministic and needs no extra model call.
2. Every rewrite of the history middle breaks the prompt-cache prefix. So rewrites must be
   rare, in large steps, and byte-identical on every later turn (the same rule as
   `image-budget.ts`).
3. The summary is the last resort. Use it only for long sessions, and keep a verbatim tail.
4. Placeholders must say how to get the content back (node id → `read_embed_html` /
   `batch_get`). Our canvas is the "file system" from the Manus post: the current state is
   always readable through tools and `canvas_context`.

## Plan

### Phase 0 — measure (1 day)

Do not pick thresholds before we have data.

1. Query `raw_traces` (14-day window) per `session_id`:
   - the distribution of the last-step input tokens (p50/p90/p99/max),
   - the share of the history by part type: tool-call input, tool result, user text,
     assistant text, images,
   - the top tools by bytes in history.
2. Count the provider errors that match context-length patterns in logs and in
   PostHog `error_kind: "provider_error"`.
3. Output: a short table in this spec. It sets the Phase 1 and Phase 2 thresholds.

Exit: we know which tool parts dominate and how often a session passes 64K / 128K / 256K.

#### Phase 0 results (2026-10-23, `raw_traces` 2026-10-11 … 2026-10-22)

7,325 rows, 425 sessions, all `deepseek-v4.1-flash` (OpenRouter 380 sessions, OpenCode Go 45).

| Metric | Value |
|---|---|
| Input tokens per request, p50 / p90 / p99 / max | 25.6K / 82.6K / 202K / 389K |
| Sessions over 32K / 64K / 128K / 200K / 256K (of 425) | 207 / 67 / 16 / 5 / 2 |
| Requests per session, p50 / p90 / max | 12 / 41 / 103 |
| User exchanges per session, p50 / p90 / max | 1 / 2 / 13 |
| Context-overflow errors | 0 |
| Input tokens, browse subagent (304 sessions) | 189M of 281M total (67%) |
| Input tokens, edits mode (121 sessions) | 93M; p90 163K per request, max 389K |
| `cache_read_tokens` recorded | 0 of 7,325 rows — the column was added after this sample (see conclusion 4) |

History composition (estimated tokens, longest history per session): tool outputs 80%,
reasoning 8%, tool inputs 4%, assistant text 4%, user text 3%. Top tool outputs:
`browse_act` 3.95M, `browse_snapshot` 0.57M, `browse_open` 0.45M, `browse_read` 0.38M,
`browse_agent` 0.33M. `browse_act` output per call: p50 3.7K chars, p90 11.9K.

Simulated masking (tool outputs over 2,000 chars, errors and skills kept):

| Rule | Share of history removed, all sessions | Sessions ≥ 32K |
|---|---|---|
| Keep the last 3 **exchanges** (the first draft of Phase 1) | 0.8% | 1.2% |
| Keep the last 3 **tool calls** | 62% | 72% |
| Keep the last 5 tool calls | 57% | 69% |
| Keep the last 10 tool calls | 46% | 59% |

Conclusions:

1. The history grows **inside one user message**, in the tool loop. The exchange is the
   wrong unit. Phase 1 must count tool calls.
2. The browse subagent is the largest consumer. Its old page observations are the first target.
3. A hard overflow did not happen. Phase 3 is low priority. Phase 2 (summary) has no data
   to support it yet: 2 sessions passed 256K.
4. We cannot see the prompt cache yet. The recording was not broken: it shipped in
   `079be4d` (2026-10-23 00:21, migration `023`), after the last row of this sample.
   Check the column on new rows **before** Phase 1 goes to `enforce`, because masking
   trades cache hits for fewer tokens, and we must measure both sides.
5. Side finding: 5 requests failed on OpenRouter credits with `max_tokens` 131,072. The
   output cap is larger than any reply needs.

### Phase 1 — observation masking for text (main phase)

New pure pass `src/ai/text-budget.ts`, called from `prepareChatTurn` after
`convertToModelMessages` and before `applyImageBudget`.

Rules:

1. **Off below a threshold.** If the estimated history is under `TEXT_BUDGET_START_TOKENS`
   (start value 64K, tune from Phase 0), the pass returns the input unchanged. Short
   sessions keep a 100% cache-stable prefix.
2. **Verbatim tail.** The last `KEEP_RECENT_TOOL_CALLS` tool calls (start value 5) stay
   word for word, and so does the last user message. Phase 0 showed that the exchange is
   the wrong unit: p50 is 1 exchange per session, and an exchange-based tail saves about 1%.
   The pass runs on every request, also on tool-loop continuations, and also on the
   browse subagent turn (`agentMode: "browse"`), which is the first target.
3. **What gets masked**, outside the tail, only when a part is larger than
   `MASK_MIN_CHARS` (start value 2,000):
   - tool results of `browse_act`, `browse_snapshot`, `browse_open`, `browse_read`
     (Phase 0: most of all history bytes; the page state is readable again with
     `browse_snapshot`);
   - tool results of `batch_get`, `snapshot_layout`, `read_embed_html`, `read_repo_files`,
     `fetch_url`, MCP and web search results;
   - the `htmlContent` strings inside `batch_design` / `edit_embed_html` tool-call
     **inputs**. The call itself, its node ids and its other arguments stay.
4. **What never gets masked:** user text, assistant text, error results (Manus: keep the
   wrong turns), `lookup_skill` synthetic results, `ask_user` answers, `update_tasks`.
5. **Placeholder is constant and restorable.** For example:
   `[elided: 41,200 chars of HTML for node "abc123". Call read_embed_html(nodeId:"abc123") to read the current version.]`
   The text is a pure function of the part (tool name, ids, size). It is never a
   function of process state, so it is byte-identical on every later turn.
6. **Step-wise boundary.** The masking boundary moves forward in steps of
   `MASK_STEP_TOOL_CALLS` (start value 5), not on every request. The cached prefix then
   breaks once per step, not once per request. This is the `TOOL_RESULT_ELISION_STEP`
   idea from `image-budget.ts`.
7. **Frozen.** A part that was masked stays masked. Derive this from the step boundary
   (pure), not from an in-process ratchet, so a restart cannot un-mask it.
   Known exception: the start threshold (rule 1) is measured on the current history. If
   the history becomes shorter than the threshold (a regenerate, an edit of an older
   message), masked parts come back once. That is one cache break, and it is accepted.

#### Phase 1a — as shipped (shadow, 2026-10-23)

`src/ai/text-budget.ts`, `TEXT_BUDGET_MODE=off|shadow|enforce` (default `shadow`),
`TEXT_BUDGET_START_TOKENS` (default 64,000). Differences from the rules above:

- Masked tools: `browse_act`, `browse_snapshot`, `browse_open` only. `browse_read`,
  `fetch_url` and `web_search` are **not** masked: they carry extracted data that the
  final answer may need, and no tool returns the same data for an old page.
- The tail is the last 5 tool results of any tool, plus the **newest result of each
  masked tool**. After a run of other tools, the last `browse_snapshot` is still the only
  element table that the next `browse_act` can use.
- The placeholder keeps the first 300 characters of the original result. A `browse_act`
  result opens with its outcome (`url`, `changed`, …). Without it the model cannot tell
  that an old "Submit" click succeeded, and it can repeat an irreversible action.
- A `content` output that carries an image is never masked (image-budget.ts owns images).
- The token estimate counts the messages only. The system prompt, the tool schemas and
  image data are not in it, so the real input is larger than `estimatedTokens`.
- Shadow writes `payload.textBudget` to `raw_traces` and `text_budget_*` counts to the
  `agent_turn_completed` PostHog event. Use these numbers to decide on `enforce`.
- Before `enforce` with `BROWSE_MODE=manual`: `runReviewSafe` gets the masked history.

Tests:

- unit: the pass is a no-op below the threshold;
- unit: the same history gives byte-identical output, also after one more exchange is
  appended (except at a step boundary);
- unit: errors, user text and the tail are never changed;
- unit: placeholders name the right node id and tool;
- integration (`/api/chat` + `MockLanguageModelV3`): a long synthetic session reaches the
  model with masked parts, and `systemPromptHash` stays constant.

Exit: on the Phase 0 replay set, p90 input tokens drop, and the agent's re-read rate
(`read_embed_html` calls after a placeholder) is acceptable.

### Phase 2 — summary checkpoint (last resort)

Only when Phase 1 is not enough: the masked history is still over
`COMPACT_TRIGGER = min(contextWindow, CONTEXT_SOFT_LIMIT) − reserve`
(start values: `CONTEXT_SOFT_LIMIT` 200K, reserve 15% and at least 16K).

**Where the state lives.** The frontend owns the history, and the backend is stateless
per request. So the frontend also owns the checkpoint:

1. The backend decides that compaction is due, at the **start of a turn** (last message is
   a user message, not a tool-loop continuation). Codex users dislike compaction in the
   middle of a task, and a turn boundary is a natural cache break anyway.
2. The backend writes the summary and streams it as a `data-compaction` part:
   `{ coversThroughMessageId, summary, version }`.
3. `chatStore` keeps the checkpoint per chat. On the next send, the frontend replaces the
   covered messages with one checkpoint user message:
   `<conversation_checkpoint><summary>…</summary></conversation_checkpoint>`.
   The UI keeps showing the full history, with one divider ("Earlier messages are
   summarized for the agent").
4. A later compaction **updates** the previous summary (OpenCode update prompt: newer history
   wins, move completed work out of "active").

**Summary call.**

- Use the chat model and send the normal request prefix plus a summary prompt, so the
  call reads the prompt cache (OpenCode). Fallback: `STRUCTURED_MODEL`.
- Strip images to their placeholders first.
- Template, adapted to design work:
  - Objective
  - User requirements and taste (brand, palette, fonts, references, things the user rejected), with exact quotes
  - Decisions
  - Canvas map: frame/embed ids and names that matter. References only, no HTML (the current state is in `canvas_context` and the tools)
  - Work state: completed / active / blocked
  - Next move
  - Open user questions
- Rules: keep exact ids, URLs and user wording. Do not restate the system prompt or skills.
  Do not call tools.

**Same turn.** The checkpoint text is fixed after it is written, so all later requests have
a stable prefix again.

Tests: summary prompt snapshot; the frontend replaces exactly the covered messages; a
second compaction updates the first; `raw_traces` stores the checkpoint id and the original
message count.

### Phase 3 — overflow recovery

1. In `retry.ts`, add `isContextOverflowError` (400/413 plus patterns such as
   `context_length_exceeded`, `maximum context length`, `prompt is too long`,
   `too many tokens`). It must be checked **before** the generic
   `provider returned error` pattern, so it is never retried as-is.
2. In `streamWithRetry`, before any content is sent: retry **once** with a forced
   Phase 1 pass at shrink steps 0.85 / 0.7 / 0.5 of the rejected size (OpenCode).
3. If that fails, send a clear error to the client (`error_kind: "context_overflow"`),
   not `"An error occurred."`. The frontend shows: "The chat is too long. Start a new chat
   or compact it."

Tests: an integration test with a mock model that throws a 400 "context length" error once.

### Optional — later

- A manual `/compact` slash command (OpenCode and Claude Code have one). Only if users ask
  for it, following "no UI if it works without UI".
- Background precompute of the summary at 85% of the trigger (OpenCode), when Phase 2
  latency becomes a problem.
- Caps on `batch_get` and `read_embed_html full` results at the source.

## Invariants (check in review)

1. `canvasContext` never goes into `system`. `systemPromptHash` stays constant inside a session.
2. Every history rewrite is a pure function of the history. Never a function of
   process-global state, LRU caches or time.
3. A masked part never comes back un-masked.
4. User attachments and user text are never masked. A summary keeps user quotes verbatim.
5. Errors stay in context.
6. Below `TEXT_BUDGET_START_TOKENS`, the history reaches the model unchanged.
7. The pass order in `prepareChatTurn` is: skills → sanitize → convert → **text budget** →
   image relevance → image budget → vision → cache breakpoint → canvas context.

## Open questions

1. Thresholds — from Phase 0.
2. Does OpenCode Go cache the prefix for the summary call? Measure `cachedInputTokens`.
3. `x-opencode-session` falls back to a random UUID when there is no chat id. A summary
   call must send the same session header as the chat request, or it gets no cache.

## Sources

- https://arxiv.org/html/2508.21433v3
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://platform.claude.com/docs/en/build-with-claude/compaction
- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- https://github.com/sst/opencode — `packages/core/src/session/compaction.ts`, `services/www/src/docs/content/compaction.mdx`
- https://codex.danielvaughan.com/2026/04/14/context-compaction-deep-dive-codex-cli-claude-code-opencode/
- https://ai-sdk.dev/cookbook/guides/agent-context-compaction
