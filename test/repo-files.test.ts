import { describe, expect, it } from "vitest";
import { fetchFilesWithBudget, truncateUtf8, type FetchOneResult } from "../src/services/repoFiles.js";

const TRUNCATION_MARKER = "\n/* ... truncated ... */";

describe("truncateUtf8", () => {
  it("returns the content untouched when it fits under the cap", () => {
    const { text, bytes } = truncateUtf8("hello", 100);
    expect(text).toBe("hello");
    expect(bytes).toBe(5);
  });

  it("returns nothing for a non-positive cap", () => {
    expect(truncateUtf8("hello", 0)).toEqual({ text: "", bytes: 0 });
  });

  // Regression: Buffer.subarray(0, cap).toString("utf-8") cuts a multi-byte
  // sequence mid-way and renders the trailing bytes as U+FFFD. "€" is 3
  // bytes (E2 82 AC) in UTF-8 — cutting after 1 or 2 of those bytes used to
  // produce a replacement character; the fix must back off to the last
  // complete code point instead.
  it("never ends a truncated result on a partial UTF-8 sequence", () => {
    const content = "€".repeat(20); // 60 bytes
    for (const cap of [1, 2, 3, 4, 5, 29, 30, 31, 59]) {
      const { text, bytes } = truncateUtf8(content, cap);
      expect(text).not.toContain("�");
      expect(Buffer.byteLength(text, "utf-8")).toBe(bytes);
      expect(bytes).toBeLessThanOrEqual(cap);
    }
  });

  it("keeps every character resolvable back to whole euro signs", () => {
    const content = "€".repeat(10); // 30 bytes
    const { text } = truncateUtf8(content, 10); // not a multiple of 3
    expect([...text].every((ch) => ch === "€")).toBe(true);
  });
});

function makeFetchOne(contents: Record<string, string>) {
  return async (path: string): Promise<FetchOneResult> => {
    if (!(path in contents)) return { kind: "missing" };
    return { kind: "content", content: contents[path] };
  };
}

describe("fetchFilesWithBudget", () => {
  it("returns content and marks unknown paths as missing", async () => {
    const outcome = await fetchFilesWithBudget(
      ["a.ts", "b.ts"],
      makeFetchOne({ "a.ts": "hello" }),
      { deadlineAt: Date.now() + 10_000, concurrency: 4, maxResponseBytes: 1_000, maxFileBytes: 1_000, truncationMarker: TRUNCATION_MARKER },
    );
    expect(outcome.files).toEqual([{ path: "a.ts", content: "hello", truncated: false, bytes: 5 }]);
    expect(outcome.missing).toEqual(["b.ts"]);
    expect(outcome.notRead).toEqual([]);
  });

  it("stops issuing fetches once the deadline has passed and reports notRead", async () => {
    let now = 0;
    let calls = 0;
    const outcome = await fetchFilesWithBudget(
      ["a.ts", "b.ts", "c.ts"],
      async (path) => {
        calls++;
        now += 100; // simulate each fetch taking time
        return { kind: "content", content: `content of ${path}` };
      },
      {
        deadlineAt: 50, // passes after the first chunk's fetch (now jumps to 100)
        concurrency: 1,
        maxResponseBytes: 10_000,
        maxFileBytes: 10_000,
        truncationMarker: TRUNCATION_MARKER,
        now: () => now,
      },
    );
    expect(calls).toBe(1);
    expect(outcome.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(outcome.notRead).toEqual(["b.ts", "c.ts"]);
    expect(outcome.missing).toEqual([]);
  });

  it("fetches up to `concurrency` paths per chunk", async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const outcome = await fetchFilesWithBudget(
      ["a", "b", "c", "d", "e"],
      async (path) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { kind: "content", content: path };
      },
      { deadlineAt: Date.now() + 10_000, concurrency: 2, maxResponseBytes: 10_000, maxFileBytes: 10_000, truncationMarker: TRUNCATION_MARKER },
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(outcome.files).toHaveLength(5);
  });

  // Regression: once the shared response budget was used up, every
  // remaining path still burned a fetch and came back as an empty
  // truncation-marker-only stub. The fix stops issuing new fetches once the
  // budget is gone (chunk granularity) and reports those paths as notRead,
  // separate from `missing`.
  it("stops once the response budget is exhausted and reports notRead distinctly from missing", async () => {
    const attempted: string[] = [];
    const outcome = await fetchFilesWithBudget(
      ["a.ts", "b.ts", "c.ts", "d.ts", "does-not-exist.ts"],
      async (path) => {
        attempted.push(path);
        if (path === "does-not-exist.ts") return { kind: "missing" };
        return { kind: "content", content: "x".repeat(50) };
      },
      {
        deadlineAt: Date.now() + 10_000,
        concurrency: 1,
        maxResponseBytes: 60, // enough for ~1 file, not all 4
        maxFileBytes: 1_000,
        truncationMarker: TRUNCATION_MARKER,
      },
    );
    expect(outcome.files.length).toBeGreaterThanOrEqual(1);
    expect(outcome.notRead.length).toBeGreaterThan(0);
    // Every notRead path was never actually attempted — the whole point of
    // stopping the loop.
    for (const path of outcome.notRead) {
      expect(attempted).not.toContain(path);
    }
  });

  it("truncates a file larger than the per-file cap and records it distinctly", async () => {
    const outcome = await fetchFilesWithBudget(
      ["huge.ts"],
      async () => ({ kind: "content", content: "x".repeat(1000) }),
      { deadlineAt: Date.now() + 10_000, concurrency: 4, maxResponseBytes: 10_000, maxFileBytes: 100, truncationMarker: TRUNCATION_MARKER },
    );
    expect(outcome.files[0].truncated).toBe(true);
    expect(outcome.files[0].content.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(outcome.files[0].bytes).toBeLessThan(1000);
  });

  it("aborts the whole call on a fetch error and reports it distinctly", async () => {
    const boom = new Error("boom");
    const outcome = await fetchFilesWithBudget(
      ["a.ts", "b.ts"],
      async (path) => (path === "a.ts" ? { kind: "content", content: "ok" } : { kind: "error", err: boom }),
      { deadlineAt: Date.now() + 10_000, concurrency: 1, maxResponseBytes: 10_000, maxFileBytes: 10_000, truncationMarker: TRUNCATION_MARKER },
    );
    expect(outcome.error?.err).toBe(boom);
    expect(outcome.error?.path).toBe("b.ts");
  });
});
