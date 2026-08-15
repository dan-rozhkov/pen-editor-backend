// A short-lived, per-(store instance, userId) cache of a user's ENABLED
// custom skills — mirrors getLearnedCatalog in learnedStore.ts, but one
// level deeper: learned skills are global (one catalog per store), user
// skills are scoped per userId, so the cache needs a second key.
//
// Kept as its own module rather than folded into userStore.ts (already
// landed by another agent) so that file's ownership stays untouched.
import type { UserSkill, UserSkillStore } from "./userStore.js";

// Shorter than learned's 30s CATALOG_TTL_MS: a user editing/toggling their
// own skill in the (about-to-land) skills panel expects the next chat turn
// to reflect it reasonably promptly, and per-user reads are cheap (a single
// indexed WHERE user_id = $1), unlike the global learned catalog which is
// read on literally every turn regardless of who's asking.
const CATALOG_TTL_MS = 15_000;

// Keyed by STORE IDENTITY (WeakMap, not a Map — never pins a store or its
// cache entries alive past the store's own lifetime) with a per-userId Map
// nested inside, exactly the reasoning getLearnedCatalog's catalogCacheByStore
// comment gives for keying by object identity: a single shared cache slot
// would let a read through one store instance return rows actually read
// through a different one (production only ever has one store alive, but
// tests build several, sometimes against different databases).
const cacheByStore = new WeakMap<
  UserSkillStore,
  Map<string, { at: number; skills: UserSkill[] }>
>();

export async function getUserSkillCatalog(
  store: UserSkillStore,
  userId: string,
): Promise<UserSkill[]> {
  let byUser = cacheByStore.get(store);
  if (!byUser) {
    byUser = new Map();
    cacheByStore.set(store, byUser);
  }

  const cached = byUser.get(userId);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.skills;
  }

  try {
    const skills = await store.listEnabled(userId);
    byUser.set(userId, { at: Date.now(), skills });
    return skills;
  } catch (err) {
    // A user-skill read must never break a design turn: fall back to the
    // last known catalog for this user (still better than nothing), or to
    // none at all if this is the very first read — same degrade-not-fail
    // stance as getLearnedCatalog.
    console.error("[user-skills] catalog read failed:", (err as Error).message);
    return byUser.get(userId)?.skills ?? [];
  }
}

/** Clears one user's cached catalog for one store. Call after a write
 * (create/update/delete) through the routes layer, once it lands, so a
 * change is visible on the very next turn instead of waiting out the TTL —
 * same purpose as invalidateLearnedCatalog, scoped to the (store, userId)
 * pair that actually changed. */
export function invalidateUserSkillCatalog(store: UserSkillStore, userId: string): void {
  cacheByStore.get(store)?.delete(userId);
}
