// Shape validation only — there is no auth in this phase, so this is not a
// security boundary. It exists to stop two different browsers from silently
// sharing one memory row because they both sent a trivial, low-entropy id
// like "1" or "test" (see the `userId` field doc on chatBodySchema).
//
// Mirrors the two id shapes `pen-editor/src/lib/userId.ts` (frontend, sibling
// repo, read-only from here) actually produces:
//   - canonical `crypto.randomUUID()`: 8-4-4-4-12 dashed hex, case-insensitive
//   - the non-secure-context fallback (`crypto.getRandomValues` formatted by
//     hand): 32 lowercase hex chars, no dashes
// A strict RFC4122 UUID regex alone would wrongly reject genuine ids from the
// fallback path (e.g. LAN http dev, older browsers).
const DASHED_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_HEX_RE = /^[0-9a-f]{32}$/i;

export function isPlausibleUserId(id: string): boolean {
  return DASHED_UUID_RE.test(id) || RAW_HEX_RE.test(id);
}
