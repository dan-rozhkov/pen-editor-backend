import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getMigrations } from "better-auth/db/migration";
import { useAuthApp } from "./authHarness.js";

const app = useAuthApp();

describe("016_auth.sql", () => {
  // The committed SQL is the schema (Better Auth never migrates at runtime).
  // getMigrations() is the library's own planner: given the REAL auth config
  // (every plugin) and the database as our migrations left it, it must have
  // nothing to create, add or index. A plugin added to src/auth/index.ts
  // without regenerating the migration fails here.
  it("leaves nothing for Better Auth to create, add or index", async () => {
    const plan = await getMigrations(app().app.auth!.options);
    expect(plan.toBeCreated.map((t) => t.table)).toEqual([]);
    expect(plan.toBeAdded.map((t) => `${t.table}: ${Object.keys(t.fields).join(",")}`)).toEqual([]);
    expect(plan.toBeAddedIndexes.map((i) => i.name)).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
  });

  it("creates the tables of exactly this plugin set", async () => {
    const { rows } = await app().pglite.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "user", "session", "account", "verification", // core + magicLink
        "jwks", // jwt
        "oauthClient", "oauthAccessToken", "oauthRefreshToken", "oauthConsent", // mcp / oauth-provider
        "oauthClientResource", "oauthResource", "oauthClientAssertion",
        "apikey", "rateLimit",
        "anon_claims",
      ]),
    );
  });

  it("is idempotent SQL, so a re-run at startup is harmless", () => {
    const sql = readFileSync(new URL("../src/analysis/migrations/016_auth.sql", import.meta.url), "utf8");
    expect(sql.match(/^CREATE TABLE (?!IF NOT EXISTS)/gim)).toBeNull();
    expect(sql.match(/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/gim)).toBeNull();
  });
});
