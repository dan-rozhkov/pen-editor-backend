import { describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import {
  applyStartupMigrations,
  type StartupMigrationsDeps,
} from "../src/startupMigrations.js";

function fakeDeps(overrides: Partial<StartupMigrationsDeps> = {}) {
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: vi.fn(), release }));
  const end = vi.fn(async () => {});
  const createPool = vi.fn(() => ({ connect, end }));
  const migrate = overrides.migrate ?? vi.fn(async () => [] as string[]);
  return {
    deps: { createPool, ...overrides, migrate } as StartupMigrationsDeps,
    createPool,
    connect,
    release,
    end,
    migrate,
  };
}

describe("applyStartupMigrations", () => {
  it("does nothing when TRACE_DATABASE_URL is not set", async () => {
    const { deps, createPool, migrate } = fakeDeps();
    const config = makeConfig({ TRACE_DATABASE_URL: undefined });

    await applyStartupMigrations(config, deps);

    expect(createPool).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("runs migrations against a pooled client when TRACE_DATABASE_URL is set", async () => {
    const { deps, createPool, connect, release, end, migrate } = fakeDeps({
      migrate: vi.fn(async () => ["004_showcase_pin.sql"]),
    });
    const config = makeConfig({
      TRACE_DATABASE_URL: "postgres://example/test",
    });

    await applyStartupMigrations(config, deps);

    expect(createPool).toHaveBeenCalledWith("postgres://example/test");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("swallows a migration failure instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, end } = fakeDeps({
      migrate: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const config = makeConfig({
      TRACE_DATABASE_URL: "postgres://example/test",
    });

    await expect(applyStartupMigrations(config, deps)).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("swallows a pool-connect failure instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const connect = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const end = vi.fn(async () => {});
    const createPool = vi.fn(() => ({ connect, end }));
    const migrate = vi.fn(async () => [] as string[]);
    const config = makeConfig({
      TRACE_DATABASE_URL: "postgres://example/test",
    });

    await expect(
      applyStartupMigrations(config, { createPool, migrate }),
    ).resolves.toBeUndefined();
    expect(migrate).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
