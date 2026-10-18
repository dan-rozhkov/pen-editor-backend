import { describe, expect, it } from "vitest";
import { buildActivityDetail } from "../src/ai/memory/activityDetail.js";

describe("buildActivityDetail", () => {
  it("maps memory operations (add/replace/remove) and renames old_text", () => {
    expect(
      buildActivityDetail("memory", "add", {
        target: "user",
        operations: [
          { action: "add", content: "likes dark mode" },
          { action: "replace", old_text: "a", content: "b" },
          { action: "remove", old_text: "gone" },
        ],
      }),
    ).toEqual({
      kind: "memory",
      target: "user",
      operations: [
        { action: "add", content: "likes dark mode" },
        { action: "replace", oldText: "a", content: "b" },
        { action: "remove", oldText: "gone" },
      ],
    });
  });

  it.each([
    ["create", { name: "n", description: "d" }, { name: "n", description: "d" }],
    ["revive", { name: "n", description: "d" }, { name: "n", description: "d" }],
    ["patch", { name: "n", oldString: "o", newString: "w" }, { name: "n", oldString: "o", newString: "w" }],
    ["delete", { name: "n", absorbedInto: "m" }, { name: "n", absorbedInto: "m" }],
  ])("maps skill %s", (action, payload, expected) => {
    expect(buildActivityDetail("skill", action, { ...payload, bodyLines: 3 })).toEqual({
      kind: "skill",
      action,
      ...expected,
    });
  });

  it("caps strings at 500 chars with an ellipsis and operations at 10", () => {
    const long = "x".repeat(600);
    const detail = buildActivityDetail("memory", "add", {
      target: "memory",
      operations: Array.from({ length: 12 }, () => ({ action: "add", content: long })),
    });
    expect(detail?.kind === "memory" && detail.operations).toHaveLength(10);
    const first = detail?.kind === "memory" ? detail.operations[0].content : "";
    expect(first).toBe(`${"x".repeat(500)}…`);
  });

  it("counts dropped valid operations in moreOperations and omits it at the cap", () => {
    const ops = (n: number) => Array.from({ length: n }, () => ({ action: "add", content: "c" }));
    const over = buildActivityDetail("memory", "add", {
      target: "memory",
      operations: [...ops(12), { action: "boom" }, ...ops(1)],
    });
    expect(over).toMatchObject({ kind: "memory", moreOperations: 3 });
    const exact = buildActivityDetail("memory", "add", { target: "memory", operations: ops(10) });
    expect(exact).not.toHaveProperty("moreOperations");
  });

  it("does not split a surrogate pair at the cap boundary", () => {
    const detail = buildActivityDetail("skill", "create", { name: `${"x".repeat(499)}😀tail` });
    expect(detail?.kind === "skill" && detail.name).toBe(`${"x".repeat(499)}😀…`);
  });

  it.each([
    ["memory", "add", null],
    ["memory", "add", { target: "evil", operations: [{ action: "add", content: "x" }] }],
    ["memory", "add", { target: "memory", operations: "nope" }],
    ["memory", "add", { target: "memory", operations: [{ action: "boom" }, 5] }],
    ["skill", "create", { description: "no name" }],
    ["skill", "create", { name: 5 }],
    ["skill", "weird", { name: "n" }],
  ])("omits detail for malformed %s/%s payload %#", (subsystem, action, payload) => {
    expect(buildActivityDetail(subsystem as "memory" | "skill", action, payload)).toBeUndefined();
  });

  it("never passes through other payload keys", () => {
    const json = JSON.stringify([
      buildActivityDetail("memory", "add", {
        target: "memory",
        operations: [{ action: "add", content: "c", secret: "s1" }],
        usage: 1,
        entryCount: 2,
        chatId: "c1",
      }),
      buildActivityDetail("skill", "create", { name: "n", bodyLines: 9, usage: 1, chatId: "c1" }),
    ]);
    for (const leaked of ["s1", "usage", "entryCount", "bodyLines", "chatId"]) {
      expect(json).not.toContain(leaked);
    }
  });
});
