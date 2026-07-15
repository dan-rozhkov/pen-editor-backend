import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, type QueryClient } from "../src/analysis/migrate.js";

function fakeClient(appliedNames: string[] = []) {
  const executed: Array<{ sql: string; params?: unknown[] }> = [];
  const client: QueryClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push({ sql, params });
      if (sql.includes("SELECT 1 FROM schema_migrations")) {
        return { rows: appliedNames.includes(params?.[0] as string) ? [1] : [] };
      }
      return { rows: [] };
    }),
  };
  return { client, executed };
}

async function makeMigrationsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migrations-"));
  await writeFile(join(dir, "002_second.sql"), "CREATE TABLE two (id int);");
  await writeFile(join(dir, "001_first.sql"), "CREATE TABLE one (id int);");
  return dir;
}

describe("migrate", () => {
  it("applies pending migrations in sorted order inside transactions", async () => {
    const { client, executed } = fakeClient();
    const applied = await migrate(client, await makeMigrationsDir());
    expect(applied).toEqual(["001_first.sql", "002_second.sql"]);
    const sqls = executed.map((e) => e.sql);
    expect(sqls.filter((s) => s === "BEGIN")).toHaveLength(2);
    expect(sqls.filter((s) => s === "COMMIT")).toHaveLength(2);
    expect(sqls.indexOf("CREATE TABLE one (id int);")).toBeLessThan(
      sqls.indexOf("CREATE TABLE two (id int);"),
    );
  });

  it("skips already-applied migrations", async () => {
    const { client } = fakeClient(["001_first.sql"]);
    const applied = await migrate(client, await makeMigrationsDir());
    expect(applied).toEqual(["002_second.sql"]);
  });

  it("rolls back and rethrows on failure", async () => {
    const dir = await makeMigrationsDir();
    const executed: string[] = [];
    const client: QueryClient = {
      query: vi.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.startsWith("CREATE TABLE one")) throw new Error("boom");
        return { rows: [] };
      }),
    };
    await expect(migrate(client, dir)).rejects.toThrow("boom");
    expect(executed).toContain("ROLLBACK");
  });
});
