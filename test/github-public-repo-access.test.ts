import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GithubNotFoundError,
  createRepoAccessCache,
  getFile,
  getRepoMeta,
} from "../src/services/github.js";
import { makeConfig } from "./helpers.js";

// These tests exercise getRepoMeta/getFile for real (unlike repo-route.test.ts,
// which mocks them out entirely) so the public-repo visibility gate itself is
// under test: every token-bearing request must be preceded by an
// UNAUTHENTICATED probe of the repo, and a 404 on that probe must never fall
// through to an authenticated retry.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensurePublicRepoAccess (via getRepoMeta/getFile)", () => {
  it("probes unauthenticated before making the authenticated request", async () => {
    const calls: Array<{ url: string; hasAuth: boolean }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, hasAuth: headers.has("authorization") });
      return jsonResponse(200, { default_branch: "main", html_url: "https://github.com/acme/webapp" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({ GITHUB_TOKEN: "secret-token" });
    const cache = createRepoAccessCache();
    await getRepoMeta("acme", "webapp", config, cache);

    expect(calls).toHaveLength(2);
    expect(calls[0].hasAuth).toBe(false); // the probe
    expect(calls[1].hasAuth).toBe(true); // the real, token-bearing request
  });

  it("refuses a private repo (probe 404) without ever sending the token", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({ GITHUB_TOKEN: "secret-token" });
    const cache = createRepoAccessCache();

    await expect(getRepoMeta("acme", "private-repo", config, cache)).rejects.toBeInstanceOf(
      GithubNotFoundError,
    );
    // Only the probe — never falls through to a second, authenticated call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("caches the probe across multiple calls for the same repo", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/contents/")) {
        return jsonResponse(200, { type: "file", encoding: "base64", content: Buffer.from("hi").toString("base64") });
      }
      return jsonResponse(200, { default_branch: "main", html_url: "https://github.com/acme/webapp" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({ GITHUB_TOKEN: "secret-token" });
    const cache = createRepoAccessCache();
    await getRepoMeta("acme", "webapp", config, cache);
    await getFile("acme", "webapp", "main", "a.txt", config, cache);
    await getFile("acme", "webapp", "main", "b.txt", config, cache);

    // 1 probe (shared) + 1 getRepoMeta + 2 getFile = 4, never 6 (one probe
    // per call).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const probeCalls = fetchMock.mock.calls.filter((call) => {
      const headers = new Headers((call[1] as RequestInit | undefined)?.headers);
      return !headers.has("authorization");
    });
    expect(probeCalls).toHaveLength(1);
  });

  it("skips the probe entirely when GITHUB_ALLOW_PRIVATE_REPOS is set", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { default_branch: "main", html_url: "https://github.com/acme/webapp" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig({ GITHUB_TOKEN: "secret-token", GITHUB_ALLOW_PRIVATE_REPOS: true });
    const cache = createRepoAccessCache();
    await getRepoMeta("acme", "webapp", config, cache);

    // Only the real, authenticated request — no separate probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(headers.has("authorization")).toBe(true);
  });
});
