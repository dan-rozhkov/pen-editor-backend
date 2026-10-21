import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildDocTemplates, extractTemplateBlock, getDocTemplates } from "../src/ai/docTemplates.js";
import { getSkill, loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";

const IDS = [
  "test-plan",
  "test-report",
  "bug-report",
  "design-brief",
  "design-spec",
  "usability-test-plan",
  "usability-test-report",
];

describe("doc templates extraction", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("finds all 7 templates in the real skills", () => {
    const templates = buildDocTemplates(getSkill);
    expect(templates.map((t) => t.id)).toEqual(IDS);
  });

  it("sets skill, kind, title, label and description", () => {
    const byId = Object.fromEntries(buildDocTemplates(getSkill).map((t) => [t.id, t]));
    expect(byId["bug-report"].title).toBe("Bug report: [Area] [Summary]");
    expect(byId["bug-report"].skill).toBe("bug-report");
    expect(byId["bug-report"].kind).toBeUndefined();
    expect(byId["usability-test-plan"]).toMatchObject({
      skill: "usability-test",
      kind: "plan",
      label: "Usability test plan",
    });
    expect(byId["usability-test-report"].kind).toBe("report");
    for (const t of Object.values(byId)) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.description).not.toContain("\n");
    }
  });

  it("returns a body without the H1 and without a leftover fence", () => {
    for (const t of buildDocTemplates(getSkill)) {
      expect(t.markdown.startsWith("# ")).toBe(false);
      expect(t.markdown.startsWith("\n")).toBe(false);
      expect(t.markdown).not.toContain("````");
      expect(t.markdown.trim().length).toBeGreaterThan(50);
      expect(t.markdown.split("\n").some((l) => l.startsWith("# "))).toBe(false);
    }
  });

  it("has only valid-looking mermaid blocks with no placeholders in the data", () => {
    const KNOWN = ["flowchart", "graph", "pie", "xychart-beta", "sequenceDiagram", "gantt", "stateDiagram-v2", "journey"];
    let seen = 0;
    for (const t of buildDocTemplates(getSkill)) {
      for (const m of t.markdown.matchAll(/```mermaid\n([\s\S]*?)\n```/g)) {
        seen++;
        const lines = m[1].split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("%%"));
        const first = lines[0].trim();
        expect(KNOWN.some((k) => first === k || first.startsWith(`${k} `)), `${t.id}: ${first}`).toBe(true);
        if (first.startsWith("pie") || first.startsWith("xychart-beta")) {
          for (const line of lines.slice(1)) {
            // A bracket outside quotes may only hold numbers, commas and quoted labels.
            const unquoted = line.replace(/"[^"]*"/g, '""');
            for (const br of unquoted.matchAll(/\[([^\]]*)\]/g)) {
              expect(br[1], `${t.id}: ${line}`).toMatch(/^[\d\s.,"-]*$/);
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it("keeps nested triple-backtick blocks intact", () => {
    const spec = buildDocTemplates(getSkill).find((t) => t.id === "design-spec")!;
    expect(spec.markdown).toContain("```mermaid");
    const report = buildDocTemplates(getSkill).find((t) => t.id === "test-report")!;
    expect(report.markdown).toContain("pie title");
    expect(report.markdown).toContain("xychart-beta");
  });

  it("returns undefined when the heading or fence is missing", () => {
    expect(extractTemplateBlock("no template here")).toBeUndefined();
    expect(extractTemplateBlock("## Template\n\ntext only")).toBeUndefined();
    expect(extractTemplateBlock("## Template: plan\n````markdown\n# T\nbody\n````", "plan")).toBe("# T\nbody");
  });

  it("caches the built list", async () => {
    const a = await getDocTemplates();
    expect(await getDocTemplates()).toBe(a);
  });
});

describe("GET /api/doc-templates", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns the templates", async () => {
    app = await buildApp(makeConfig(), { logger: false });
    const res = await app.inject({ method: "GET", url: "/api/doc-templates" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { templates: Array<{ id: string; markdown: string; title: string }> };
    expect(body.templates.map((t) => t.id)).toEqual(IDS);
    expect(body.templates[0].markdown).not.toMatch(/^# /);
  });

  it("answers CORS like the other GET routes", async () => {
    app = await buildApp(makeConfig(), { logger: false });
    const origin = "http://localhost:5173";
    const skills = await app.inject({ method: "GET", url: "/api/skills", headers: { origin } });
    const res = await app.inject({ method: "GET", url: "/api/doc-templates", headers: { origin } });
    expect(res.headers["access-control-allow-origin"]).toBe(skills.headers["access-control-allow-origin"]);
  });
});
