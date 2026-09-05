// Fetch-with-budget helper backing POST /api/repo/files (src/routes/repo.ts).
// Pulled out of the route handler so the deadline/concurrency/truncation
// logic is unit-testable without a real HTTP server or real timers — the
// route just wires `fetchOne` to the real `getFile` and passes real time.

export interface FileResult {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

export type FetchOneResult =
  | { kind: "content"; content: string }
  | { kind: "missing" }
  | { kind: "error"; err: unknown };

export interface FetchFilesOutcome {
  files: FileResult[];
  missing: string[];
  // Paths that were never (fully) read, distinct from `missing` (which
  // means "does not exist at this ref"): these existed but reading them was
  // cut short by the overall deadline or by the response byte budget
  // running out. The model needs to be able to tell the two apart —
  // "missing" is a fact about the repo, "notRead" is a fact about this
  // call's limits.
  notRead: string[];
  // Set when a fetch failed with a genuine upstream/rate-limit error (not a
  // 404 — those come back as `missing`). The caller aborts the whole
  // request on this, matching the pre-existing behavior of failing the
  // request rather than returning a partial result silently.
  error?: { path: string; err: unknown };
}

export interface FetchFilesOpts {
  // Absolute deadline (compatible with `now()`, i.e. epoch ms by default) —
  // once reached, remaining paths are reported as `notRead` rather than
  // fetched.
  deadlineAt: number;
  // How many paths to fetch concurrently.
  concurrency: number;
  // Total content bytes to return across every file combined.
  maxResponseBytes: number;
  // Per-file cap once the shared budget still has room.
  maxFileBytes: number;
  truncationMarker: string;
  // Injectable clock, for tests — defaults to the real Date.now.
  now?: () => number;
}

// Backs off to the last complete UTF-8 code point instead of slicing a
// Buffer mid-sequence (which turns the trailing bytes into U+FFFD).
// TextDecoder's `{ stream: true }` mode buffers an incomplete trailing
// sequence internally and simply omits it from the output, which is exactly
// the "back off to a boundary" behavior we want.
export function truncateUtf8(content: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= maxBytes) {
    return { text: content, bytes: buf.byteLength };
  }
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(buf.subarray(0, maxBytes), { stream: true });
  return { text, bytes: Buffer.byteLength(text, "utf-8") };
}

export async function fetchFilesWithBudget(
  paths: string[],
  fetchOne: (path: string) => Promise<FetchOneResult>,
  opts: FetchFilesOpts,
): Promise<FetchFilesOutcome> {
  const now = opts.now ?? Date.now;
  const files: FileResult[] = [];
  const missing: string[] = [];
  const notRead: string[] = [];
  let remainingBudget = opts.maxResponseBytes;
  let attempted = 0;

  while (attempted < paths.length) {
    if (now() >= opts.deadlineAt || remainingBudget <= 0) break;

    const batch = paths.slice(attempted, attempted + opts.concurrency);
    attempted += batch.length;

    const settled = await Promise.all(
      batch.map(async (path) => ({ path, result: await fetchOne(path) })),
    );

    for (const { path, result } of settled) {
      if (result.kind === "error") {
        // Abort immediately — the caller maps this to an error response and
        // discards files/missing/notRead, matching the pre-existing
        // behavior of failing the whole request rather than returning a
        // partial result.
        return { files, missing, notRead, error: { path, err: result.err } };
      }
      if (result.kind === "missing") {
        missing.push(path);
        continue;
      }
      if (remainingBudget <= 0) {
        // The shared budget ran out partway through this batch (fetches in
        // a batch run concurrently, so we can't check this before issuing
        // them) — stop rendering content rather than returning an empty
        // truncated stub that still cost a GitHub call.
        notRead.push(path);
        continue;
      }
      const cap = Math.max(0, Math.min(opts.maxFileBytes, remainingBudget));
      const bytes = Buffer.byteLength(result.content, "utf-8");
      let outContent = result.content;
      let truncated = false;
      if (bytes > cap) {
        outContent = truncateUtf8(result.content, cap).text + opts.truncationMarker;
        truncated = true;
      }
      const outBytes = Buffer.byteLength(outContent, "utf-8");
      remainingBudget = Math.max(0, remainingBudget - outBytes);
      files.push({ path, content: outContent, truncated, bytes: outBytes });
    }
  }

  if (attempted < paths.length) {
    notRead.push(...paths.slice(attempted));
  }

  return { files, missing, notRead };
}
