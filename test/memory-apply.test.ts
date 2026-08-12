import { describe, expect, it } from "vitest";
import { applyMemoryOperations, serializeEntries, usageOf } from "../src/ai/memory/apply.js";
import { MEMORY_LIMITS } from "../src/ai/memory/types.js";

describe("serializeEntries / usageOf", () => {
  it("joins with the record separator and measures characters", () => {
    expect(serializeEntries(["a", "b"])).toBe("a\n§\nb");
    expect(usageOf(["a", "b"], "user")).toEqual({ current: 5, limit: 1375 });
    expect(usageOf([], "memory")).toEqual({ current: 0, limit: 2200 });
  });
});

describe("applyMemoryOperations", () => {
  it("appends an add and reports the new usage", () => {
    const out = applyMemoryOperations([], [{ action: "add", content: "User prefers concise responses" }], "user");
    expect(out).toEqual({
      ok: true,
      entries: ["User prefers concise responses"],
      usage: { current: 30, limit: 1375 },
    });
  });

  it("applies a whole batch atomically in order", () => {
    const out = applyMemoryOperations(
      ["old note", "keep me"],
      [
        { action: "remove", old_text: "old note" },
        { action: "add", content: "new note" },
        { action: "replace", old_text: "keep me", content: "kept" },
      ],
      "memory",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.entries).toEqual(["kept", "new note"]);
  });

  it("rejects an ambiguous old_text without mutating anything", () => {
    const out = applyMemoryOperations(
      ["user likes blue", "user likes blue buttons"],
      [{ action: "remove", old_text: "likes blue" }],
      "user",
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe("ambiguous");
      expect(out.message).toContain("matches 2 entries");
      expect(out.currentEntries).toEqual(["user likes blue", "user likes blue buttons"]);
    }
  });

  it("reports no_match when old_text matches nothing", () => {
    const out = applyMemoryOperations(["a"], [{ action: "remove", old_text: "zzz" }], "user");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("no_match");
  });

  it("rejects an empty add as invalid", () => {
    const out = applyMemoryOperations([], [{ action: "add", content: "   " }], "user");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("invalid");
  });

  it("checks the budget on the FINAL state only", () => {
    const filler = "x".repeat(MEMORY_LIMITS.user - 10);
    // Intermediate state is over budget, final state is not.
    const out = applyMemoryOperations(
      [filler],
      [
        { action: "add", content: "y".repeat(100) },
        { action: "remove", old_text: filler },
      ],
      "user",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.entries).toEqual(["y".repeat(100)]);
  });

  it("treats an exact duplicate 'add' as a silent no-op, not a second copy", () => {
    const out = applyMemoryOperations(
      ["User prefers concise responses"],
      [{ action: "add", content: "User prefers concise responses" }],
      "user",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.entries).toEqual(["User prefers concise responses"]);
  });

  it("still adds a near-duplicate that differs after trimming", () => {
    const out = applyMemoryOperations(
      ["User prefers concise responses"],
      [{ action: "add", content: "  User prefers concise responses  " }],
      "user",
    );
    expect(out.ok).toBe(true);
    // Trimmed content matches the existing entry exactly -> still a no-op.
    if (out.ok) expect(out.entries).toEqual(["User prefers concise responses"]);
  });

  it("keeps the rest of a batch atomic when one 'add' is a duplicate", () => {
    const out = applyMemoryOperations(
      ["keep me", "already here"],
      [
        { action: "add", content: "already here" },
        { action: "replace", old_text: "keep me", content: "kept" },
      ],
      "memory",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.entries).toEqual(["kept", "already here"]);
  });

  it("replace-into-a-duplicate drops the source entry instead of leaving two identical copies", () => {
    const out = applyMemoryOperations(
      ["User prefers concise responses", "User is a designer"],
      [{ action: "replace", old_text: "is a designer", content: "User prefers concise responses" }],
      "user",
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.entries).toEqual(["User prefers concise responses"]);
      expect(out.entries.filter((e) => e === "User prefers concise responses")).toHaveLength(1);
    }
  });

  it("replace with content equal to the entry's own current text is a no-op", () => {
    const out = applyMemoryOperations(
      ["User prefers concise responses", "User is a designer"],
      [{ action: "replace", old_text: "is a designer", content: "User is a designer" }],
      "user",
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.entries).toEqual(["User prefers concise responses", "User is a designer"]);
    }
  });

  it("rejects an over-capacity final state and reports pre-batch usage", () => {
    const existing = "x".repeat(1370);
    const out = applyMemoryOperations([existing], [{ action: "add", content: "y".repeat(50) }], "user");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe("over_capacity");
      expect(out.usage).toEqual({ current: 1370, limit: 1375 });
      expect(out.message).toContain("50 chars");
      expect(out.currentEntries).toEqual([existing]);
    }
  });
});
