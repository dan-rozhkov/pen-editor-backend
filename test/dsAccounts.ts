// Shared by the /api/ds HTTP suites: a verified account with a session cookie
// and an API key, created through the real Better Auth routes.
import type { AuthHarness } from "./authHarness.js";

export interface Account {
  cookie: string;
  userId: string;
  apiKey: string;
}

let seq = 0;

export async function createAccount(app: AuthHarness, tag: string): Promise<Account> {
  const email = `${tag}${++seq}@example.test`;
  const cookie = await app.signUp(email);
  const session = (await (await app.fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } })).json()) as { user: { id: string } };
  const key = (await (
    await app.fetchAuth("/api/auth/api-key/create", { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ name: "ci" }) })
  ).json()) as { key: string };
  return { cookie, userId: session.user.id, apiKey: key.key };
}

export const as = (a: Account) => ({ cookie: a.cookie });
export const json = async <T>(res: Response) => (await res.json()) as T;

/** POST to a Better Auth organization route as the holder of `cookie`. */
export const orgPostOn = (app: AuthHarness, cookie: string, path: string, body: unknown) =>
  app.fetchAuth(`/api/auth/organization/${path}`, { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(body) });
