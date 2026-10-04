import { describe, expect, it } from "vitest";
import { startApp } from "./chatHarness.js";
import { makeConfig } from "./helpers.js";
import { fakeUserSkillStore, userSkill } from "./userSkillFakes.js";
import { useAuthApp } from "./authHarness.js";

const ANON = "11111111-1111-4111-8111-111111111111";
const OTHER_ANON = "22222222-2222-4222-8222-222222222222";

// GET /api/user-skills is the probe: it returns exactly the rows of whichever
// id resolveActor handed to the store.
const skills = fakeUserSkillStore([
  userSkill({ userId: ANON, name: "anon-skill" }),
  userSkill({ userId: OTHER_ANON, name: "other-anon-skill" }),
]);
const app = useAuthApp({}, { userSkillStore: skills });

const names = async (res: Response): Promise<string[]> =>
  ((await res.json()).skills as Array<{ name: string }>).map((s) => s.name);

describe("resolveActor", () => {
  it("anonymous caller: the plausible body/query userId is the actor", async () => {
    const res = await fetch(`${app().url}/api/user-skills?userId=${ANON}`);
    expect(await names(res)).toEqual(["anon-skill"]);
  });

  it("no session and no plausible userId is a 400, as before accounts", async () => {
    for (const query of ["", "?userId=test", "?userId=1"]) {
      const res = await fetch(`${app().url}/api/user-skills${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
  });

  it("a session beats the body userId: the account's own id is used", async () => {
    const cookie = await app().signUp("actor@example.test");
    const me = await (await app().fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } })).json();
    skills.skills.push(userSkill({ userId: me.user.id, name: "account-skill" }));

    const res = await fetch(`${app().url}/api/user-skills?userId=${ANON}`, { headers: { Cookie: cookie } });
    expect(await names(res)).toEqual(["account-skill"]);
  });

  it("a signed-in caller with no userId at all still works", async () => {
    const cookie = await app().signUp("actor2@example.test");
    const res = await fetch(`${app().url}/api/user-skills`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await names(res)).toEqual([]);
  });

  it("a garbage cookie falls back to the anonymous rules", async () => {
    const res = await fetch(`${app().url}/api/user-skills?userId=${OTHER_ANON}`, {
      headers: { Cookie: "better-auth.session_token=not-a-real-token" },
    });
    expect(await names(res)).toEqual(["other-anon-skill"]);
  });
});

describe("resolveActor with accounts off", () => {
  it("keeps the old behaviour untouched", async () => {
    const running = await startApp(makeConfig(), { userSkillStore: skills });
    try {
      const res = await fetch(`${running.url}/api/user-skills?userId=${ANON}`, { headers: { Cookie: "better-auth.session_token=x" } });
      expect(await names(res)).toEqual(["anon-skill"]);
    } finally {
      await running.close();
    }
  });
});
