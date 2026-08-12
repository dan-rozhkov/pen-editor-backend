import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeConfig } from "./helpers.js";

// Mirrors test/app-memory-gate.test.ts's approach: mock the factories so
// "never constructed" is distinguishable from "constructed but unused".
const createMemoryStoreMock = vi.hoisted(() => vi.fn(() => null));
vi.mock("../src/ai/memory/store.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/ai/memory/store.js")>(
      "../src/ai/memory/store.js",
    );
  return { ...actual, createMemoryStore: createMemoryStoreMock };
});

const getSharedLearnedSkillStoreMock = vi.hoisted(() => vi.fn(() => null));
vi.mock("../src/ai/skills/learnedStore.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/ai/skills/learnedStore.js")>(
      "../src/ai/skills/learnedStore.js",
    );
  return { ...actual, getSharedLearnedSkillStore: getSharedLearnedSkillStoreMock };
});

const getSharedAuditDbMock = vi.hoisted(() => vi.fn(() => null));
vi.mock("../src/ai/selfimprove/auditDb.js", () => ({
  getSharedAuditDb: getSharedAuditDbMock,
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  createMemoryStoreMock.mockClear();
  getSharedLearnedSkillStoreMock.mockClear();
  getSharedAuditDbMock.mockClear();
});

describe("buildApp — self-authored-skills store gating", () => {
  it("does not construct learnedSkillStore/auditDb when SELF_SKILLS_ENABLED is off", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(
      makeConfig({ SELF_SKILLS_ENABLED: false, TRACE_DATABASE_URL: "postgres://unused" }),
      { logger: false, traceStore: null, showcaseStore: null },
    );
    expect(getSharedLearnedSkillStoreMock).not.toHaveBeenCalled();
    expect(getSharedAuditDbMock).not.toHaveBeenCalled();
  });

  it("constructs learnedSkillStore/auditDb when SELF_SKILLS_ENABLED is on", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(
      makeConfig({ SELF_SKILLS_ENABLED: true, TRACE_DATABASE_URL: "postgres://unused" }),
      { logger: false, traceStore: null, showcaseStore: null },
    );
    expect(getSharedLearnedSkillStoreMock).toHaveBeenCalledTimes(1);
    expect(getSharedAuditDbMock).toHaveBeenCalledTimes(1);
  });

  it("respects explicitly injected learnedSkillStore/auditDb options regardless of the flag", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(makeConfig({ SELF_SKILLS_ENABLED: true }), {
      logger: false,
      traceStore: null,
      showcaseStore: null,
      learnedSkillStore: null,
      auditDb: null,
    });
    expect(getSharedLearnedSkillStoreMock).not.toHaveBeenCalled();
    expect(getSharedAuditDbMock).not.toHaveBeenCalled();
  });

  it("still constructs the shared memory/counters store when only SELF_SKILLS_ENABLED is on (MEMORY_ENABLED off)", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(
      makeConfig({
        SELF_SKILLS_ENABLED: true,
        MEMORY_ENABLED: false,
        TRACE_DATABASE_URL: "postgres://unused",
      }),
      { logger: false, traceStore: null, showcaseStore: null },
    );
    // agent_review_state holds both counters in one row, so the skill
    // counter needs this store even with the memory feature itself off.
    expect(createMemoryStoreMock).toHaveBeenCalledTimes(1);
  });

  // Finding 4: neither learnedSkillStore nor auditDb had an onClose hook,
  // unlike traceStore/memoryStore/showcaseStore — buildApp() closing did
  // not close either pool. Inject fakes (rather than the real getShared*
  // singletons) so this only asserts the hook wiring, not the singleton's
  // own close-on-URL-change behavior (covered separately in
  // selfskills-store.test.ts / selfskills-auditdb.test.ts).
  it("closes learnedSkillStore and auditDb on app.close()", async () => {
    const { buildApp } = await import("../src/app.js");
    const learnedSkillStoreClose = vi.fn(async () => {});
    const auditDbEnd = vi.fn(async () => {});
    app = await buildApp(makeConfig({ SELF_SKILLS_ENABLED: true }), {
      logger: false,
      traceStore: null,
      showcaseStore: null,
      learnedSkillStore: {
        listActive: async () => [],
        get: async () => null,
        create: async () => {},
        replaceBody: async () => {},
        remove: async () => false,
        bumpUse: async () => {},
        bumpView: async () => {},
        close: learnedSkillStoreClose,
      },
      auditDb: {
        query: async () => ({ rows: [] }),
        end: auditDbEnd,
      },
    });
    await app.close();
    app = undefined;
    expect(learnedSkillStoreClose).toHaveBeenCalledTimes(1);
    expect(auditDbEnd).toHaveBeenCalledTimes(1);
  });
});
