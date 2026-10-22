// The real BrowserConnector: CDP-connect to a Steel session with Playwright and
// drive it with the package's BrowserController. The implementation (lazy
// playwright-core import, API-key redaction of connect errors) lives in
// @sideform/browser-agent/adapters/playwright.
import { connectOverCdp as connectPackageOverCdp } from "@sideform/browser-agent/adapters/playwright";
import type { BrowserController } from "@sideform/browser-agent/controller";
import type { PageFixture } from "@sideform/browser-agent/fixture";
import type { BrowserConnector, CommandRunner } from "./cloudSessions.js";
import { originsArg, requiredTokenArg, tokenArg } from "./journalArgs.js";

/**
 * The page-fixture commands take the controller's `(fixture, opts)` shape, so the
 * runner adapts the HTTP `args` object. Mocks are allowed here: the cloud browser
 * is a disposable Steel session, not the user's profile. The fixture itself is
 * parsed by the controller (stage "validate").
 */
export function toCommandRunner(controller: BrowserController): CommandRunner {
  return {
    open: (args) => controller.open(args),
    act: (args) => controller.act(args),
    findImages: (args) => controller.findImages(args),
    read: (args) => controller.read(args),
    snapshot: () => controller.snapshot(),
    screenshot: (args) => controller.screenshot(args),
    capture: (args) => controller.capture(args),
    tabs: (args) => controller.tabs(args),
    perform: (args) => controller.perform(args),
    assert: (args) => controller.assert(args),
    applyFixture: async (args) => {
      const fixture = (args as { fixture?: unknown } | undefined)?.fixture;
      if (typeof fixture !== "object" || fixture === null || Array.isArray(fixture)) {
        return { ok: false, stage: "validate", error: "fixture must be an object" };
      }
      return (await controller.applyFixture(fixture as PageFixture, { allowNetworkMocks: true })) as Record<string, unknown>;
    },
    releaseFixture: async (args) => {
      const t = tokenArg(args);
      if ("error" in t) return { ok: false, error: t.error };
      // The package's controller resolves to { mockHits } when it released network mocks; the
      // client reports the rules that matched no request. Typed loosely until the package bump.
      const released = (await controller.releaseFixture(t.token)) as unknown;
      const mockHits = (released as { mockHits?: unknown } | undefined)?.mockHits;
      return { ok: true, ...(Array.isArray(mockHits) ? { mockHits } : {}) };
    },
    // The checkpoint journal. Over HTTP the registry (cloudSessions) maps its own
    // backend token to the controller's owner token and only calls these once a
    // session exists; stop/capture here require the token it passes.
    startJournal: async (args) => {
      const o = originsArg(args);
      if ("error" in o) return { ok: false, error: o.error };
      const token = controller.startJournal(o.origins === undefined ? undefined : { origins: o.origins });
      return { ok: true, token };
    },
    stopJournal: async (args) => {
      const t = requiredTokenArg(args);
      if ("error" in t) return { ok: false, error: t.error };
      return { ok: controller.stopJournal(t.token) };
    },
    clearActEmulation: async () => {
      await controller.clearActEmulation();
      return { ok: true };
    },
    // Read-only drain of the cloud browser's request log: { requests, dropped? }.
    requests: async () => (await controller.requests()) as unknown as Record<string, unknown>,
    captureCheckpoint: async (args) => {
      const t = requiredTokenArg(args);
      if ("error" in t) return { ok: false, error: t.error };
      return (await controller.captureCheckpoint(t.token)) as unknown as Record<string, unknown>;
    },
  };
}

export const connectOverCdp: BrowserConnector = async (cdpUrl) => {
  const connected = await connectPackageOverCdp(cdpUrl);
  return { ...connected, controller: toCommandRunner(connected.controller) };
};
