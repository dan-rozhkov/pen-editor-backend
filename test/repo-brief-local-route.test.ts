import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";

// POST /api/repo/brief-local: the second caller of the shared
// buildDesignBriefFromSource core (src/services/repoDesignSystem.ts), fed
// by a local agent pushing a repo's tree + a handful of files over WebMCP
// instead of GitHub. No network/github.js mocking needed here — the whole
// point of this route is that it never touches GitHub.

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function startServer(): Promise<string> {
  app = await buildApp(makeConfig(), { logger: false });
  return app.listen({ port: 0, host: "127.0.0.1" });
}

function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TAILWIND_CONFIG = `
  export default {
    theme: {
      extend: {
        colors: { brand: "#3b82f6" },
      },
    },
  };
`;

const GLOBAL_CSS = `
  :root {
    --background: #ffffff;
  }
`;

describe("POST /api/repo/brief-local", () => {
  it("builds a brief from a supplied tree + files, tokens extracted from CSS/tailwind config, components from tree alone", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief-local", {
      name: "my-local-app",
      tree: [
        "package.json",
        "tailwind.config.ts",
        "app/globals.css",
        "src/components/ui/button.tsx",
        "src/components/Header.tsx",
      ],
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            dependencies: { react: "^18.0.0", next: "^14.0.0", tailwindcss: "^3.4.0" },
          }),
        },
        { path: "tailwind.config.ts", content: TAILWIND_CONFIG },
        { path: "app/globals.css", content: GLOBAL_CSS },
        // Deliberately NOT supplying src/components/ui/button.tsx or
        // Header.tsx's content — the component inventory is derived from
        // `tree` alone and must not need their content.
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo: { owner: string; name: string; ref: string; htmlUrl: string };
      source: string;
      framework: string[];
      styling: string[];
      tokens: { colors: Record<string, string> };
      components: Array<{ path: string }>;
      keyFiles: string[];
    };
    expect(body.source).toBe("local");
    expect(body.repo).toEqual({ owner: "", name: "my-local-app", ref: "local", htmlUrl: "" });
    expect(body.framework).toContain("next");
    expect(body.styling).toContain("tailwindcss");
    expect(body.tokens.colors).toMatchObject({ brand: "#3b82f6", background: "#ffffff" });
    expect(body.components.map((c) => c.path)).toEqual(
      expect.arrayContaining(["src/components/ui/button.tsx", "src/components/Header.tsx"]),
    );
    expect(body.keyFiles).toEqual(
      expect.arrayContaining(["package.json", "app/globals.css", "tailwind.config.ts"]),
    );
  });

  it("degrades with a note instead of throwing when a key file named in the tree was not supplied", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief-local", {
      name: "thin-repo",
      tree: ["package.json", "tailwind.config.ts"],
      files: [
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { react: "^18.0.0" } }),
        },
        // tailwind.config.ts is in the tree but its content is withheld.
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: string[]; keyFiles: string[] };
    expect(body.keyFiles).toContain("tailwind.config.ts");
    expect(
      body.notes.some((n) => n.includes("tailwind.config.ts") && n.includes("could not be read")),
    ).toBe(true);
  });

  it("rejects more than 20000 tree entries", async () => {
    const base = await startServer();
    const tree = Array.from({ length: 20_001 }, (_, i) => `file${i}.ts`);
    const res = await postJson(base, "/api/repo/brief-local", { name: "big", tree, files: [] });
    expect(res.status).toBe(400);
  });

  it("rejects more than 2000 files", async () => {
    const base = await startServer();
    const files = Array.from({ length: 2001 }, (_, i) => ({ path: `file${i}.ts`, content: "x" }));
    const res = await postJson(base, "/api/repo/brief-local", {
      name: "big",
      tree: files.map((f) => f.path),
      files,
    });
    expect(res.status).toBe(400);
  });

  it("rejects more than 8MB of total file content", async () => {
    const base = await startServer();
    const big = "x".repeat(9 * 1024 * 1024);
    const res = await postJson(base, "/api/repo/brief-local", {
      name: "huge-file",
      tree: ["huge.ts"],
      files: [{ path: "huge.ts", content: big }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects path traversal and absolute paths in tree", async () => {
    const base = await startServer();
    const res1 = await postJson(base, "/api/repo/brief-local", {
      name: "evil",
      tree: ["../../etc/passwd"],
      files: [],
    });
    expect(res1.status).toBe(400);
    const res2 = await postJson(base, "/api/repo/brief-local", {
      name: "evil",
      tree: ["/etc/passwd"],
      files: [],
    });
    expect(res2.status).toBe(400);
  });

  it("rejects path traversal and absolute paths in files", async () => {
    const base = await startServer();
    const res1 = await postJson(base, "/api/repo/brief-local", {
      name: "evil",
      tree: [],
      files: [{ path: "../../etc/passwd", content: "x" }],
    });
    expect(res1.status).toBe(400);
    const res2 = await postJson(base, "/api/repo/brief-local", {
      name: "evil",
      tree: [],
      files: [{ path: "/etc/passwd", content: "x" }],
    });
    expect(res2.status).toBe(400);
  });

  it("returns 400 for an invalid body (missing name)", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief-local", { tree: [], files: [] });
    expect(res.status).toBe(400);
  });

  // A payload right at the schema's own 8MB/20000-entry ceiling, once
  // JSON-escaped inside the request body, exceeds the app-wide 10MB
  // bodyLimit (src/app.ts) — without a route-level override this would 413
  // with Fastify's generic FST_ERR_CTP_BODY_TOO_LARGE instead of the 400
  // that names which schema cap was actually hit.
  it("still returns the schema's 400 (not a body-size 413) for a payload over the app-wide 10MB default", async () => {
    const base = await startServer();
    const tree = Array.from({ length: 20_000 }, (_, i) => `file${i}.ts`);
    // 12MB of raw content: comfortably over both the schema's 8MB files-
    // content cap AND the app-wide 10MB default bodyLimit (src/app.ts),
    // while staying under this route's own override. Without the route-
    // level bodyLimit override, Fastify would reject this at the transport
    // layer (FST_ERR_CTP_BODY_TOO_LARGE, 413) before briefLocalBodySchema
    // ever runs — the point of this test is that the schema's own 400,
    // naming the 8MB cap, is what actually comes back.
    const big = "x".repeat(12 * 1024 * 1024);
    const res = await postJson(base, "/api/repo/brief-local", {
      name: "near-ceiling",
      tree,
      files: [{ path: "huge.ts", content: big }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/8 MB|8MB/);
  });
});
