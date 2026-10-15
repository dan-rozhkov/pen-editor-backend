# Browse subagent: browsing on deepseek without reasoning

Date: 2026-10-14. Status: implemented behind `BROWSE_MODE=agent` (default stays `manual` until a bench run says otherwise).

## Why

OM2W bench, 30 tasks, manual browse loop (one run per task):

| chat model driving the browser | success | wall p50 |
|---|---|---|
| deepseek-v4.1-flash, reasoning off | 57% | 48–55 s |
| deepseek-v4.1-flash, reasoning on | 53% | 122 s |
| Haiku 5.5 | 50% | 40 s |
| gpt-6-luna | 33% | 68 s |

So browsing works best on deepseek with reasoning OFF, while the user may pick any chat model, and a deepseek chat itself runs WITH reasoning. Browsing therefore always goes to a subagent pinned to deepseek-v4.1-flash with reasoning off, whatever the main model is (including deepseek).

## Shape

1. **Main turn** (`BROWSE_MODE=agent`, browser available): the tool set has ONE browser tool, `browse_agent({ goal, url? })`. All other `browse_*` tools (and `browse_task`) are removed from the main turn. The system prompt's browser section tells the model to put the whole task with every constraint into `goal` (the subagent does not see the chat), and to call `browse_agent` again for a follow-up.
2. **Execution is on the client**, like every `browse_*` tool. The frontend handler runs a nested, headless chat session against the same `/api/chat`, with `agentMode: "browse"` in the body. Tool calls of that session go through the normal `executeToolCall` with the PARENT chat's `sessionId`, so the same browser (desktop IPC or the cloud Steel session keyed by chat id) and the same loop guard are used.
3. **Subagent turn** (`agentMode: "browse"`): the backend builds a browse-only turn —
   - tools: `browse_open`, `browse_snapshot`, `browse_screenshot`, `browse_act`, `browse_tabs`, `browse_find_images`, `browse_read` (the usual browser/vision gates still apply), nothing else;
   - system prompt: a short dedicated browse prompt (the manual browser guidance plus a reporting rule: end with a plain-text answer of observed facts and the final URL);
   - no skills, memory, MCP, web tools or canvas context;
   - model: always `BROWSE_AGENT_MODEL` (default `deepseek/deepseek-v4.1-flash` on OpenRouter), with the OpenRouter provider order `BROWSE_AGENT_PROVIDER_ORDER` (default `together`). A `model` in the request body is ignored. This holds also for a user whose main chat is on OpenCode Go: until 2026-10-15 such a user's subagent ran on `opencode-go/deepseek-v4.1-flash`, but OM2W showed the same success at p50 93 s on Go vs 53 s on OpenRouter + Together. The user's main-chat model is never used here;
   - reasoning: forced `none` The user's main OpenCode deepseek chat is NOT affected, so it keeps reasoning;
   - a request with `agentMode: "browse"` while `BROWSE_MODE` is not `agent` is a 400 `browse_agent_disabled`, so the rollback switch turns the whole path off.
4. **Result** to the main model: `{ status: "done" | "error" | "aborted" | "step_limit" | "timeout", answer, steps }`. On `done`, `answer` is the subagent's final text; on any other status it is all text the subagent wrote, so partial findings are not lost.
5. **Irreversible steps** (purchase, booking, sending, submitting personal data, deleting): the subagent stops and reports what is pending unless the goal says the user already confirmed that exact step. The main model asks the user, then calls `browse_agent` again with the confirmation stated in `goal`.
6. **Images**: deepseek-v4.1-flash sees images. Tool-result screenshots reach it natively on OpenRouter and on OpenCode Go (the backend rewrites the SDK's JSON-stringified tool result into `image_url` parts; verified live 2026-10-14). Other OpenCode models keep the text-description fallback.

## Limits

- The subagent sees no chat history: the whole context travels in `goal`.
- After it returns, the main model cannot see the page. A follow-up is a new `browse_agent` call (the browser tab stays open, so the subagent starts where the last one stopped).
- The nested session is capped at 60 model requests, has its own deadline just below the client tool timeout (so a slow run returns `timeout` with its partial answer instead of a bare tool error), and stops on the user's Stop.
- `browse_agent` must not be serialized in the client tool queue: its nested tool calls go through the same queue and would deadlock behind it.
