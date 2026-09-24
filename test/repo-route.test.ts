import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp, type RunningApp } from "./chatHarness.js";
import { GithubNotFoundError } from "../src/services/github.js";
import { FIXTURE_META, githubFixtureMocks } from "./githubRepoFixtures.js";

// GitHub IO is mocked end to end: getRepoMeta/getRepoTree/getFile are faked
// with the in-memory acme/webapp fixtures (test/githubRepoFixtures.ts) so the
// route (validation, error mapping, truncation/missing bookkeeping) is
// exercised without real network calls. parseRepoRef is left real — it's
// pure and cheap.
const github = githubFixtureMocks(async (owner, name) => {
  if (owner === "acme" && name === "webapp") return FIXTURE_META;
  throw new GithubNotFoundError(`GitHub returned 404 for /repos/${owner}/${name}.`);
});

vi.mock("../src/services/github.js", async (importOriginal) =>
  (await import("./githubRepoFixtures.js")).githubModuleWithMocks(await importOriginal(), () => github),
);

let running: RunningApp | undefined;

afterEach(async () => {
  github.getRepoMeta.mockClear();
  github.getRepoTree.mockClear();
  github.getFile.mockClear();
  await running?.close();
  running = undefined;
});

async function startServer(): Promise<string> {
  running = await startApp();
  return running.url;
}

function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/repo/brief", () => {
  it("returns a full brief for a known repo", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief", { repo: "acme/webapp" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo: { owner: string; name: string; ref: string };
      framework: string[];
      styling: string[];
      tokens: { colors: Record<string, string> };
      components: Array<{ path: string }>;
      keyFiles: string[];
    };
    expect(body.repo).toEqual({ owner: "acme", name: "webapp", ref: "main", htmlUrl: FIXTURE_META.htmlUrl });
    expect(body.framework).toContain("next");
    expect(body.styling).toContain("tailwindcss");
    expect(body.tokens.colors).toMatchObject({ brand: "#3b82f6", background: "#ffffff" });
    expect(body.components.map((c) => c.path)).toContain("src/components/ui/button.tsx");
    expect(body.keyFiles).toContain("package.json");
    expect(body.keyFiles).toContain("tailwind.config.ts");
  });

  it("uses an explicit ref override instead of the default branch", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief", { repo: "acme/webapp", ref: "feature-x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repo: { ref: string } };
    expect(body.repo.ref).toBe("feature-x");
    expect(github.getRepoTree).toHaveBeenCalledWith(
      "acme",
      "webapp",
      "feature-x",
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns 404 for an unknown repo", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief", { repo: "nobody/nothing" });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  it("returns 400 for an invalid body (missing repo)", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief", {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for a repo string that cannot be parsed", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief", { repo: "not-a-repo-ref" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a repo string containing a \"..\" segment", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief", { repo: "../user" });
    expect(res.status).toBe(400);
  });

  // Regression: mapGithubError used to turn ANY unexpected Error (a bug, a
  // TypeError) into a 400 blamed on the caller, and skipped logging since
  // the log branch only fired for status >= 500.
  it("returns 500, not 400, for an unexpected non-GitHub error, and never leaks the raw message", async () => {
    github.getRepoMeta.mockImplementationOnce(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    });
    const base = await startServer();
    const res = await postJson(base, "/api/repo/brief", { repo: "acme/webapp" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("Cannot read properties");
  });
});

describe("POST /api/repo/files", () => {
  it("returns file contents and lists missing paths", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/files", {
      repo: "acme/webapp",
      paths: ["package.json", "does/not/exist.ts"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repo: { owner: string; name: string; ref: string };
      files: Array<{ path: string; content: string; truncated: boolean }>;
      missing: string[];
    };
    expect(body.repo).toEqual({ owner: "acme", name: "webapp", ref: "main" });
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe("package.json");
    expect(body.files[0].truncated).toBe(false);
    expect(body.missing).toEqual(["does/not/exist.ts"]);
  });

  it("truncates a file larger than the 64KB per-file cap", async () => {
    github.getFile.mockImplementationOnce(async () => "x".repeat(70_000));
    const base = await startServer();
    const res = await postJson(base, "/api/repo/files", {
      repo: "acme/webapp",
      paths: ["huge.ts"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: Array<{ path: string; content: string; truncated: boolean; bytes: number }>;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0].truncated).toBe(true);
    expect(body.files[0].content).toContain("truncated");
    expect(body.files[0].bytes).toBeLessThan(70_000);
  });

  it("rejects more than 20 paths", async () => {
    const base = await startServer();
    const paths = Array.from({ length: 21 }, (_, i) => `file${i}.ts`);
    const res = await postJson(base, "/api/repo/files", { repo: "acme/webapp", paths });
    expect(res.status).toBe(400);
  });

  it("rejects path traversal and absolute paths", async () => {
    const base = await startServer();
    const res1 = await postJson(base, "/api/repo/files", {
      repo: "acme/webapp",
      paths: ["../../etc/passwd"],
    });
    expect(res1.status).toBe(400);
    const res2 = await postJson(base, "/api/repo/files", {
      repo: "acme/webapp",
      paths: ["/etc/passwd"],
    });
    expect(res2.status).toBe(400);
  });

  it("returns 400 for an invalid body (empty paths array)", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/files", { repo: "acme/webapp", paths: [] });
    expect(res.status).toBe(400);
  });

  it("returns an empty notRead array on an ordinary successful call", async () => {
    const base = await startServer();
    const res = await postJson(base, "/api/repo/files", {
      repo: "acme/webapp",
      paths: ["package.json"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notRead: string[] };
    expect(body.notRead).toEqual([]);
  });

  it("returns 500, not 400, for an unexpected non-GitHub error while resolving the repo", async () => {
    github.getRepoMeta.mockImplementationOnce(async () => {
      throw new TypeError("boom");
    });
    const base = await startServer();
    const res = await postJson(base, "/api/repo/files", {
      repo: "acme/webapp",
      paths: ["package.json"],
    });
    expect(res.status).toBe(500);
  });
});
