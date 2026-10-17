import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browseAgentToolNoQa, penTools } from "../src/ai/tools.js";

// Both browse_agent variants are pinned exactly, so a drift in either text is
// a visible diff. To change them on purpose, edit test/fixtures/browse-agent-descriptions.golden.json.
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/browse-agent-descriptions.golden.json", import.meta.url), "utf8"),
) as { withQa: string; withoutQa: string };

describe("browse_agent descriptions", () => {
  it("the QA variant matches the golden text", () => {
    expect((penTools.browse_agent as { description: string }).description).toBe(golden.withQa);
  });

  it("the variant without qa matches the golden text", () => {
    expect((browseAgentToolNoQa as { description: string }).description).toBe(golden.withoutQa);
  });
});
