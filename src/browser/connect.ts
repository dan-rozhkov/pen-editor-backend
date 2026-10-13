// The real BrowserConnector: CDP-connect to a Steel session with Playwright and
// drive it with the package's BrowserController. The implementation (lazy
// playwright-core import, API-key redaction of connect errors) lives in
// @sideform/browser-agent/adapters/playwright.
import { connectOverCdp as connectPackageOverCdp } from "@sideform/browser-agent/adapters/playwright";
import type { BrowserConnector } from "./cloudSessions.js";

export const connectOverCdp: BrowserConnector = connectPackageOverCdp;
