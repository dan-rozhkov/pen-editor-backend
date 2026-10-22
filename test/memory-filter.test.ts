import { describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { envSchema } from "../src/config.js";
import {
  MAX_FILTERED_ADDS,
  MAX_ENTRY_CHARS,
  runMemoryFilter,
} from "../src/ai/memory/filter.js";
import type { SystemOneAnswers, SystemOneClient } from "../src/services/systemone.js";
import type { MemoryOperation } from "../src/ai/memory/types.js";

type Call = { state: { existing_entries: string[]; new_entries: { text: string }[] }; questions: Record<string, { instructions: string }>; signal?: AbortSignal };

function fakeClient(answers: Record<string, number> | ((c: Call) => Record<string, number>)) {
  const calls: Call[] = [];
  const client = {
    evaluate: vi.fn(async (params: Call) => {
      calls.push(params);
      const map = typeof answers === "function" ? answers(params) : answers;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(map)) out[k] = { type: "noul", noul: v };
      return { model: "m", answers: out as SystemOneAnswers, usage: { input_tokens: 0, output_tokens: 0 } };
    }),
  } as unknown as SystemOneClient;
  return { client, calls };
}

const config = makeConfig();
const add = (content: string): MemoryOperation => ({ action: "add", content });
const run = (client: SystemOneClient | null, ops: MemoryOperation[], existing: string[] = [], target: "user" | "memory" = "user", extra = {}) =>
  runMemoryFilter(client, { config, target, operations: ops, existing, ...extra });

describe("config defaults", () => {
  it("ships off with the documented thresholds", () => {
    expect(envSchema.shape.MEMORY_FILTER_MODE.parse(undefined)).toBe("off");
    expect(envSchema.shape.MEMORY_FILTER_DURABLE_MIN.parse(undefined)).toBe(0.3);
    expect(envSchema.shape.MEMORY_FILTER_DUPLICATE_MIN.parse(undefined)).toBe(0.7);
    expect(envSchema.shape.MEMORY_FILTER_TIMEOUT_MS.parse(undefined)).toBe(2000);
    expect(envSchema.shape.MEMORY_FILTER_SHADOW_TIMEOUT_MS.parse(undefined)).toBe(10000);
  });
});

describe("runMemoryFilter questions", () => {
  it("uses target-specific durable text", async () => {
    const u = fakeClient({});
    await run(u.client, [add("a")], [], "user");
    const m = fakeClient({});
    await run(m.client, [add("a")], [], "memory");
    expect(u.calls[0].questions.durable_0.instructions).toContain("who the user is");
    expect(m.calls[0].questions.durable_0.instructions).toContain("environment, conventions, tool quirks");
    expect(m.calls[0].questions.durable_0.instructions).not.toContain("who the user is");
  });

  it("omits duplicate questions when there are no existing entries", async () => {
    const { client, calls } = fakeClient({});
    await run(client, [add("a"), add("b")]);
    expect(Object.keys(calls[0].questions)).toEqual(["durable_0", "durable_1"]);
  });

  it("asks both questions per add when entries exist", async () => {
    const { client, calls } = fakeClient({});
    await run(client, [add("a")], ["old"]);
    expect(Object.keys(calls[0].questions).sort()).toEqual(["duplicate_0", "durable_0"]);
    expect(calls[0].state).toEqual({ target: "user", existing_entries: ["old"], new_entries: [{ text: "a" }] });
    expect(calls[0].questions.durable_0.instructions).toContain("new_entries[0].text");
  });

  it("excludes exact copies of the new entries from the existing list", async () => {
    const { client, calls } = fakeClient({});
    await run(client, [add("  same ")], ["same", "other"]);
    expect(calls[0].state.existing_entries).toEqual(["other"]);
    const only = fakeClient({});
    await run(only.client, [add("same")], ["same"]);
    expect(Object.keys(only.calls[0].questions)).toEqual(["durable_0"]);
  });

  it("judges only the first 8 adds and indexes into the operations array", async () => {
    const ops: MemoryOperation[] = [{ action: "remove", old_text: "x" }];
    for (let i = 0; i < 10; i++) ops.push(add(`e${i}`));
    const { client, calls } = fakeClient({});
    const r = await run(client, ops);
    expect(calls[0].state.new_entries).toHaveLength(MAX_FILTERED_ADDS);
    expect(r.asked).toBe(8);
    expect(r.verdicts.map((v) => v.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("scrubs PII and truncates what it sends", async () => {
    const { client, calls } = fakeClient({});
    await run(client, [add("mail me at jane.doe@example.com " + "x".repeat(2000))], ["write to bob@example.org"]);
    const sent = JSON.stringify(calls[0].state);
    expect(sent).not.toContain("jane.doe@example.com");
    expect(sent).not.toContain("bob@example.org");
    expect(calls[0].state.new_entries[0].text.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS);
  });

  it("passes an abort signal", async () => {
    const { client, calls } = fakeClient({});
    await run(client, [add("a")]);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("runMemoryFilter verdicts", () => {
  it("drops not_durable strictly below the bound, keeps at it", async () => {
    const { client } = fakeClient({ durable_0: 0.29, durable_1: 0.3, durable_2: 0.5 });
    const r = await run(client, [add("a"), add("b"), add("c")]);
    expect(r.verdicts.map((v) => v.drop)).toEqual(["not_durable", null, null]);
  });

  it("drops duplicate at or above the bound, keeps below", async () => {
    const { client } = fakeClient({ durable_0: 0.9, duplicate_0: 0.7, durable_1: 0.9, duplicate_1: 0.69 });
    const r = await run(client, [add("a"), add("b")], ["old"]);
    expect(r.verdicts.map((v) => v.drop)).toEqual(["duplicate", null]);
  });

  it("missing answers never drop", async () => {
    const { client } = fakeClient({ durable_1: 0.1 });
    const r = await run(client, [add("a"), add("b")], ["old"]);
    expect(r.outcome).toBe("asked");
    expect(r.verdicts[0]).toEqual({ index: 0, drop: null });
    expect(r.verdicts[1].drop).toBe("not_durable");
  });
});

describe("runMemoryFilter failure modes", () => {
  it("no client", async () => {
    expect((await run(null, [add("a")])).outcome).toBe("no-client");
  });
  it("nothing to ask", async () => {
    const { client } = fakeClient({});
    const r = await run(client, [{ action: "remove", old_text: "x" }, add("  ")]);
    expect(r.outcome).toBe("nothing-to-ask");
    expect(client.evaluate).not.toHaveBeenCalled();
  });
  it("client throws -> failed, nothing dropped", async () => {
    const client = { evaluate: vi.fn(async () => { throw new Error("boom"); }) } as unknown as SystemOneClient;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run(client, [add("a")]);
    expect(r).toEqual({ outcome: "failed", verdicts: [], asked: 0 });
  });
  it("timeout -> failed", async () => {
    const client = {
      evaluate: vi.fn((p: Call) => new Promise((_, reject) => {
        p.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
    } as unknown as SystemOneClient;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await run(client, [add("a")], [], "user", { timeoutMs: 20 });
    expect(r.outcome).toBe("failed");
  });
});

describe("runMemoryFilter consolidation", () => {
  it("excludes entries rewritten by a remove/replace of the same batch from existing", async () => {
    const f = fakeClient({});
    await run(
      f.client,
      [
        { action: "remove", old_text: " prefers dark UI " },
        add("prefers dark UI and dark themes"),
        { action: "replace", old_text: "Uses Vim", content: "Uses Neovim" },
      ],
      ["prefers dark UI", "Uses Vim daily", "Is a designer"],
    );
    expect(f.calls[0].state.existing_entries).toEqual(["Is a designer"]);
  });

  it("asks no duplicate question when the only existing entry is being removed", async () => {
    const f = fakeClient({});
    await run(
      f.client,
      [{ action: "remove", old_text: "prefers dark UI" }, add("prefers dark UI and dark themes")],
      ["prefers dark UI"],
    );
    expect(Object.keys(f.calls[0].questions)).toEqual(["durable_0"]);
  });
});
