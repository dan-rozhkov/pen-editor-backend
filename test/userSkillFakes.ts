// In-memory UserSkillStore double, keyed like the real `user_skills` table
// by (userId, name) — enough surface for chatTurn.ts/skills.ts (get/
// listEnabled/bumpUse) and the CRUD routes, without PGlite. Shared by the
// prepareChatTurn unit tests and the real-HTTP wiring test so both exercise
// the exact same fake.
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";

export function userSkill(overrides: Partial<UserSkill> = {}): UserSkill {
  return {
    userId: "u1",
    name: "my-skill",
    description: "does a custom thing",
    body: "CUSTOM BODY",
    enabled: true,
    source: "manual",
    useCount: 0,
    lastUsedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function fakeUserSkillStore(initial: UserSkill[]): UserSkillStore & { skills: UserSkill[] } {
  const skills = initial.map((s) => ({ ...s }));
  const find = (userId: string, name: string) =>
    skills.find((s) => s.userId === userId && s.name === name);
  return {
    skills,
    async list(userId) {
      return skills.filter((s) => s.userId === userId);
    },
    async listEnabled(userId) {
      return skills.filter((s) => s.userId === userId && s.enabled);
    },
    async get(userId, name) {
      return find(userId, name) ?? null;
    },
    async create(input) {
      const created = userSkill({ ...input, createdAt: new Date(), updatedAt: new Date() });
      skills.push(created);
      return created;
    },
    async update(userId, name, patch) {
      const found = find(userId, name);
      if (!found) return null;
      if (patch.newName !== undefined) found.name = patch.newName;
      if (patch.description !== undefined) found.description = patch.description;
      if (patch.body !== undefined) found.body = patch.body;
      if (patch.enabled !== undefined) found.enabled = patch.enabled;
      found.updatedAt = new Date();
      return found;
    },
    async remove(userId, name) {
      const idx = skills.findIndex((s) => s.userId === userId && s.name === name);
      if (idx === -1) return false;
      skills.splice(idx, 1);
      return true;
    },
    async bumpUse(userId, name) {
      const found = find(userId, name);
      if (found) {
        found.useCount += 1;
        found.lastUsedAt = new Date();
      }
    },
    async count(userId) {
      return skills.filter((s) => s.userId === userId).length;
    },
    async close() {},
  };
}
