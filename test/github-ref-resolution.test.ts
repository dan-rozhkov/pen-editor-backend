import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepoAccessCache,
  getRepoTree,
  resolveRepoTree,
} from "../src/services/github.js";
import { makeConfig } from "./helpers.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRepoTree with a slash-containing ref", () => {
  // Regression: encodeURIComponent(ref) turns "/" into "%2F", which GitHub's
  // tree API does not resolve back to a real ref — it 404s.
  it("keeps the ref's internal slashes un-percent-encoded in the request path", async () => {
    let requestedUrl = "";
    const fetchMock = vi.fn(async (url: string) => {
      requestedUrl = url;
      return jsonResponse(200, { tree: [], truncated: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({ GITHUB_ALLOW_PRIVATE_REPOS: true });
    const cache = createRepoAccessCache();
    await getRepoTree("acme", "webapp", "feature/my-branch", config, cache);

    expect(requestedUrl).toContain("/git/trees/feature/my-branch");
    expect(requestedUrl).not.toContain("%2F");
  });
});

describe("resolveRepoTree", () => {
  it("tries the shortest ref candidate first and stops at the first that resolves", async () => {
    const attempted: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const match = url.match(/\/git\/trees\/([^?]+)\?/);
      const ref = decodeURIComponent(match?.[1] ?? "");
      attempted.push(ref);
      // Only the real, multi-segment branch name resolves.
      if (ref === "feature/my-branch") {
        return jsonResponse(200, { tree: [{ path: "src/app.tsx", type: "blob" }], truncated: false });
      }
      return jsonResponse(404, { message: "Not Found" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({ GITHUB_ALLOW_PRIVATE_REPOS: true });
    const cache = createRepoAccessCache();
    const result = await resolveRepoTree(
      "o",
      "n",
      ["feature", "feature/my-branch", "feature/my-branch/src"],
      config,
      cache,
    );

    expect(result.ref).toBe("feature/my-branch");
    expect(attempted).toEqual(["feature", "feature/my-branch"]);
  });

  it("fails once every candidate is exhausted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({ GITHUB_ALLOW_PRIVATE_REPOS: true });
    const cache = createRepoAccessCache();
    await expect(
      resolveRepoTree("o", "n", ["a", "a/b", "a/b/c"], config, cache),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
