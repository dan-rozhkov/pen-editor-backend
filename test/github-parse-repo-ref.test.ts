import { describe, expect, it } from "vitest";
import { parseRepoRef, RepoRefValidationError } from "../src/services/github.js";

describe("parseRepoRef", () => {
  it("parses owner/name", () => {
    expect(parseRepoRef("vercel/next.js")).toEqual({
      owner: "vercel",
      name: "next.js",
      ref: undefined,
      refCandidates: undefined,
      subPath: undefined,
    });
  });

  it("parses a full github.com URL", () => {
    expect(parseRepoRef("https://github.com/vercel/next.js")).toEqual({
      owner: "vercel",
      name: "next.js",
      ref: undefined,
      refCandidates: undefined,
      subPath: undefined,
    });
  });

  it("parses a github.com URL with no protocol", () => {
    expect(parseRepoRef("github.com/vercel/next.js")).toEqual({
      owner: "vercel",
      name: "next.js",
      ref: undefined,
      refCandidates: undefined,
      subPath: undefined,
    });
  });

  it("strips a trailing .git", () => {
    expect(parseRepoRef("https://github.com/vercel/next.js.git")).toEqual({
      owner: "vercel",
      name: "next.js",
      ref: undefined,
      refCandidates: undefined,
      subPath: undefined,
    });
  });

  it("strips a trailing slash", () => {
    expect(parseRepoRef("https://github.com/vercel/next.js/")).toEqual({
      owner: "vercel",
      name: "next.js",
      ref: undefined,
      refCandidates: undefined,
      subPath: undefined,
    });
  });

  it("parses a /tree/<ref> URL with nothing after it as unambiguous", () => {
    expect(parseRepoRef("https://github.com/vercel/next.js/tree/canary")).toEqual({
      owner: "vercel",
      name: "next.js",
      ref: "canary",
      refCandidates: undefined,
      subPath: undefined,
    });
  });

  // A ref with a subpath after it is genuinely ambiguous — the ref itself
  // may contain "/" (see the "branch name containing /" tests below), so
  // parseRepoRef can't know the boundary from the URL shape alone. It
  // offers shortest-first candidates instead of guessing a single answer.
  it("parses a /tree/<ref>/<subpath> URL as ambiguous, offering ref candidates", () => {
    expect(
      parseRepoRef("https://github.com/vercel/next.js/tree/canary/packages/next"),
    ).toEqual({
      owner: "vercel",
      name: "next.js",
      ref: undefined,
      refCandidates: ["canary", "canary/packages", "canary/packages/next"],
      subPath: "packages/next",
    });
  });

  it("caps ref candidates at 3 for a longer subpath", () => {
    expect(
      parseRepoRef("https://github.com/shadcn-ui/ui/tree/main/apps/www/registry/new-york"),
    ).toEqual({
      owner: "shadcn-ui",
      name: "ui",
      ref: undefined,
      refCandidates: ["main", "main/apps", "main/apps/www"],
      subPath: "apps/www/registry/new-york",
    });
  });

  // Regression for the branch-name-with-slashes bug: this used to come back
  // as ref: "feature" (wrong — "feature" alone is not a real branch here).
  it("offers the full multi-segment branch name as a ref candidate", () => {
    const result = parseRepoRef(
      "https://github.com/o/n/tree/feature/my-branch/src/app",
    );
    expect(result.ref).toBeUndefined();
    expect(result.refCandidates).toEqual(["feature", "feature/my-branch", "feature/my-branch/src"]);
  });

  it("rejects an empty string", () => {
    expect(() => parseRepoRef("")).toThrow(RepoRefValidationError);
    expect(() => parseRepoRef("   ")).toThrow(RepoRefValidationError);
  });

  it("rejects a bare repo name with no owner", () => {
    expect(() => parseRepoRef("next.js")).toThrow(RepoRefValidationError);
  });

  it("rejects a non-github URL", () => {
    expect(() => parseRepoRef("https://gitlab.com/vercel/next.js")).toThrow(RepoRefValidationError);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseRepoRef("https://")).toThrow(RepoRefValidationError);
  });

  it("rejects /tree/ with no ref", () => {
    expect(() => parseRepoRef("https://github.com/vercel/next.js/tree/")).toThrow(
      RepoRefValidationError,
    );
  });

  it("rejects owner/name containing invalid characters", () => {
    expect(() => parseRepoRef("vercel/next js")).toThrow(RepoRefValidationError);
  });

  // Regression: SEGMENT_RE's character class matches "." and "..", which
  // used to slip through as a literal owner/name segment. "../user" would
  // normalize to "/user" in a URL path, surfacing the TOKEN OWNER's account
  // (not the caller's) when interpolated into a GitHub API path.
  it("rejects a \"..\" owner segment", () => {
    expect(() => parseRepoRef("../user")).toThrow(RepoRefValidationError);
  });

  it("rejects a \".\" owner segment", () => {
    expect(() => parseRepoRef("./user")).toThrow(RepoRefValidationError);
  });

  it("rejects a \"..\" name segment", () => {
    expect(() => parseRepoRef("owner/..")).toThrow(RepoRefValidationError);
  });
});
