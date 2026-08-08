import { afterEach, describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";

// Regression for the finding that every ordinary test suite
// (chat-route.test.ts, chat-trace.test.ts, chat-route-policy.test.ts,
// models.test.ts, upload-route.test.ts, generateImage-route.test.ts,
// mcp-server.integration.test.ts, ...) clobbered a developer's real
// ~/.pen-editor/mcp.json: makeConfig() leaves MCP_AUTH_TOKEN unset, so every
// buildApp() ran in auto-token mode, and the old code published/removed the
// handshake file for *any* auto-token instance unconditionally. This test
// exercises exactly that pattern -- buildApp(makeConfig()) + listen({port:0}),
// no publishHandshake option, the same call every *-route.test.ts makes --
// and proves it now leaves the handshake file alone.
//
// This is deliberately layered on top of, not a replacement for, the global
// os.homedir() redirect in test/setup.ts: even in the buggy code, this test
// would still pass safely because setup.ts already points homedir() at a
// throwaway temp dir for the whole run. What this test actually proves is
// the *primary* fix -- BuildAppOptions.publishHandshake defaulting to false
// -- by asserting the file is absent, which fails if publishHandshake's
// default (or its wiring in src/app.ts) ever regresses back to "always
// publish in auto-token mode", independent of the setup.ts backstop.
describe("buildApp() without publishHandshake never touches the handshake file", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("does not create the handshake file on listen, and close does not error trying to remove it", async () => {
    const handshakePath = join(homedir(), ".pen-editor", "mcp.json");

    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), { logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    // Give the (correctly absent) publish hook a moment it would have
    // needed if it were wrongly wired up, so this isn't just a timing win.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(stat(handshakePath)).rejects.toMatchObject({ code: "ENOENT" });

    await app.close();
    app = undefined;
    await expect(stat(handshakePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still does not publish even when MCP_AUTH_TOKEN is set explicitly (not auto-token mode at all)", async () => {
    const handshakePath = join(homedir(), ".pen-editor", "mcp.json");

    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: "a-very-secret-token!" }), { logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    await expect(stat(handshakePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
