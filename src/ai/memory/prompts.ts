// Stable tier of the system prompt: appended right after CORE_PROMPT, before
// the skills catalog, and ONLY when the memory tool is actually present. It
// must sit above the snapshot itself so the varying part (the entries) stays
// at the end of the cached prefix.
export const MEMORY_GUIDANCE = `You have persistent memory across sessions. Save durable facts using the memory tool: user preferences, environment details, tool quirks, and stable conventions. Memory is injected into every turn, so keep it compact and focused on facts that will still matter later.
Prioritize what reduces future user steering — the most valuable memory is one that prevents the user from having to correct or remind you again. User preferences and recurring corrections matter more than procedural task details.
Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory. Specifically: do not record 'fixed bug X', 'Phase N done', file counts, or any artifact that will be stale in 7 days. If a fact will be stale in a week, it does not belong in memory.
Write memories as declarative facts, not instructions to yourself. 'User prefers concise responses' ✓ — 'Always respond concisely' ✗. Imperative phrasing gets re-read as a directive in later sessions and can cause repeated work or override the user's current request.
When the user asks you to remember something ('remember that…', 'запомни…', 'keep in mind…', 'don't forget…'), that is a direct instruction to call the memory tool in THIS turn. Answering 'noted' or 'got it' without calling it is a failure: nothing is stored, and the user believes it was.`;

// Behavioral guidance lives in the tool schema description by design: it is
// re-read at the moment of the call, where the model is actually deciding.
export const MEMORY_TOOL_DESCRIPTION = `Save durable facts to persistent memory that survive across sessions. Memory is injected into every future turn, so keep entries compact and high-signal.
HOW: make ALL your changes in ONE call via an 'operations' array. The batch applies atomically and the char limit is checked only on the FINAL result. The response reports current/limit chars and confirms completion; one batch call finishes the update, so don't repeat it.
WHEN: an explicit ask to remember ('remember…', 'запомни…', 'keep in mind…') REQUIRES this call in the same turn — replying 'noted' without it stores nothing while the user thinks otherwise. Otherwise save proactively when the user states a preference, correction, or personal detail, or you learn a stable fact about their environment, conventions, or workflow. Priority: user preferences & corrections > environment facts > procedures. The best memory stops the user repeating themselves.
IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or shortens enough stale entries and adds the new one together.
TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons).
SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state.`;

// Trailing user message of the background review run. Never persisted into a
// user-visible session: a stored review prompt turns the agent into "the
// curator" on the next real turn.
export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?
3. Did YOU learn something durable about operating here — a tool that behaved differently than its description implied, a convention this document or this user's files follow, an approach that reliably worked or reliably failed on this canvas? Points 1 and 2 go to target 'user'; this one goes to target 'memory', which is your own notes. Both halves matter: a memory holding only facts about the user leaves you rediscovering the same environment every session.

If something stands out, save it using the memory tool. If nothing is worth saving, just say 'Nothing to save.' and stop.

You can only call the memory tool. Other tools will be denied at runtime — do not attempt them.`;

// Terminal by design: the success response does NOT echo the entries, or the
// model re-reads its own write as new information and writes it again.
export const MEMORY_WRITE_SAVED =
  "Write saved. This update is complete — do not repeat it.";

export const MEMORY_CIRCUIT_BREAKER =
  "Stop retrying memory calls — leave memory unchanged for now and continue with your reply to the user. The fact can be saved in a later turn.";
