// One reader for every user-supplied credential header (X-OpenCode-Key,
// X-BYOK-Key, X-BYOK-Base-URL). Fastify lowercases header names; a header
// sent twice arrives as an array, so the first value wins. Blank or
// whitespace-only counts as absent. Callers must keep the result out of
// every logged, traced or captured object.
export function readCredentialHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
