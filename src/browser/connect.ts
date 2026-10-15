// The real BrowserConnector: CDP-connect to a Steel session with Playwright and
// drive it with the package's BrowserController. The implementation (lazy
// playwright-core import, API-key redaction of connect errors) lives in
// @sideform/browser-agent/adapters/playwright.
import { connectOverCdp as connectPackageOverCdp } from "@sideform/browser-agent/adapters/playwright";
import type { BrowserController } from "@sideform/browser-agent/controller";
import type { PageFixture } from "@sideform/browser-agent/fixture";
import type { BrowserConnector, CommandRunner } from "./cloudSessions.js";

const MAX_TOKEN_LENGTH = 512;

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
    applyFixture: async (args) => {
      const fixture = (args as { fixture?: unknown } | undefined)?.fixture;
      if (typeof fixture !== "object" || fixture === null || Array.isArray(fixture)) {
        return { ok: false, stage: "validate", error: "fixture must be an object" };
      }
      return (await controller.applyFixture(fixture as PageFixture, { allowNetworkMocks: true })) as Record<string, unknown>;
    },
    releaseFixture: async (args) => {
      const token = (args as { token?: unknown } | undefined)?.token;
      if (token !== undefined && (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH)) {
        return { ok: false, error: "token must be a string of at most 512 characters" };
      }
      await controller.releaseFixture(token);
      return { ok: true };
    },
  };
}

export const connectOverCdp: BrowserConnector = async (cdpUrl) => {
  const connected = await connectPackageOverCdp(cdpUrl);
  return { ...connected, controller: toCommandRunner(connected.controller) };
};
