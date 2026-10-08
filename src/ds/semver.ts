// Plain MAJOR.MINOR.PATCH versions for design-system libraries. No
// prerelease or build parts: a library version is always a published release.
export type Bump = "major" | "minor" | "patch";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function parseVersion(text: string): Semver | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function bumpVersion(v: Semver, bump: Bump): Semver {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

const BUMP_RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

export function bumpRank(bump: Bump): number {
  return BUMP_RANK[bump];
}

/** The version each bump would produce; the first publish is always 1.0.0. */
export function nextVersions(latest: string | null): Record<Bump, string> {
  const parsed = latest === null ? null : parseVersion(latest);
  if (!parsed) return { major: "1.0.0", minor: "1.0.0", patch: "1.0.0" };
  return {
    major: formatVersion(bumpVersion(parsed, "major")),
    minor: formatVersion(bumpVersion(parsed, "minor")),
    patch: formatVersion(bumpVersion(parsed, "patch")),
  };
}
