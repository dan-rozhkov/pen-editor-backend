// Regex PII scrubber. The implementation lives in @sideform/browser-agent
// (the browse policy uses it too); re-exported so the backend's callers keep
// one import path.
export { scrubPii, containsPii, findPiiSpans, PII_KINDS } from "@sideform/browser-agent/policy";
export type { PiiSpan } from "@sideform/browser-agent/policy";
