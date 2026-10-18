/**
 * Chat/turn attribution stamped into the audit rows of a background review so
 * the UI can show the "memory updated" row under the right reply.
 */
export interface ReviewAttribution {
  chatId?: string;
  messageId?: string;
}

/** Same bound as `chatBodySchema`'s `id` (src/routes/chat.ts). */
export const ATTRIBUTION_ID_MAX = 200;

/** The one validation rule: a string of 1..ATTRIBUTION_ID_MAX characters. */
export function isAttributionId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= ATTRIBUTION_ID_MAX;
}
