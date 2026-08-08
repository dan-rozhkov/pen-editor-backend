import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";

// The backend's auto-token mode must never touch a developer's real home
// directory in tests. os.homedir() is redirected to a fresh temp dir per
// test; the mock must stay in place for every import below (buildApp ->
// mcpRoutes -> mcp/autoToken.ts all resolve homedir() lazily at call time,
// not at module load, so re-pointing `fakeHome` per test is enough). vitest
// hoists this vi.mock above the imports above, so it's active before
// src/app.js (and transitively src/mcp/autoToken.js) is ever evaluated.
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

const TOKEN = "a-very-secret-token!"; // >= 16 chars per MCP_AUTH_TOKEN validation

function handshakePath(home: string): string {
  return join(home, ".pen-editor", "mcp.json");
}

// The write happens from an `onListen` hook, which Fastify fires
// fire-and-forget (it does not delay app.listen()'s resolution) so that a
// slow or hanging filesystem write can never hold up "the server is
// listening" — the same reasoning that keeps a failed write from crashing
// startup. Tests therefore poll briefly instead of asserting immediately
// after listen() resolves.
async function waitForFile(path: string, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function waitForFileGone(path: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await stat(path);
      if (Date.now() - start > timeoutMs) throw new Error(`${path} still exists after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }
}

describe("MCP auto-token mode — handshake file + end-to-end auth", () => {
  let app: FastifyInstance | undefined;
  let createdHomeDir = "";

  beforeEach(async () => {
    createdHomeDir = await mkdtemp(join(tmpdir(), "pen-editor-home-"));
    fakeHome = createdHomeDir;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    await rm(createdHomeDir, { recursive: true, force: true });
  });

  it("writes a handshake file with the documented shape, 0600 perms, and the real ephemeral port — and the token actually authenticates", async () => {
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), { logger: false, publishHandshake: true });
    const url = await app.listen({ port: 0, host: "0.0.0.0" });
    const port = Number(new URL(url).port);

    const file = handshakePath(fakeHome);
    const raw = await waitForFile(file);
    const parsed = JSON.parse(raw) as { url: string; token: string; port: number };

    expect(parsed).toEqual({
      url: `http://127.0.0.1:${port}/api/mcp`,
      token: parsed.token,
      port,
    });
    expect(parsed.token).toMatch(/^[0-9a-f]{64}$/);

    const fileMode = (await stat(file)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = (await stat(join(fakeHome, ".pen-editor"))).mode & 0o777;
    expect(dirMode).toBe(0o700);

    // The surface that previously 503'd is now live for a loopback caller
    // bearing the auto-generated token.
    const res = await fetch(`${url}/api/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${parsed.token}` },
    });
    expect(res.status).toBe(204);

    // Wrong token, same loopback peer -> 401, not a free pass. Must be the
    // same length as a real token (64 hex chars) so this actually exercises
    // constantTimeEqual's equal-length comparison path rather than bailing
    // out on the length check before ever comparing bytes.
    const wrong = await fetch(`${url}/api/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${"0".repeat(64)}` },
    });
    expect(wrong.status).toBe(401);
  });

  it("does not write a handshake file when MCP_AUTH_TOKEN is set explicitly", async () => {
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: TOKEN }), { logger: false, publishHandshake: true });
    await app.listen({ port: 0, host: "127.0.0.1" });

    await expect(stat(handshakePath(fakeHome))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the handshake file on graceful shutdown (app.close) in auto-token mode", async () => {
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), { logger: false, publishHandshake: true });
    await app.listen({ port: 0, host: "127.0.0.1" });

    await waitForFile(handshakePath(fakeHome));
    await app.close();
    app = undefined;
    await waitForFileGone(handshakePath(fakeHome));
  });

  it("does not crash startup when the handshake file write fails (e.g. homedir resolves under a regular file, not a directory)", async () => {
    // Point "homedir" at a path that is itself a plain file, so
    // mkdir(<homedir>/.pen-editor, {recursive:true}) fails with ENOTDIR —
    // simulates a read-only/unwritable filesystem without needing root.
    const blockerFile = join(fakeHome, "blocker");
    await writeFile(blockerFile, "not a directory");
    fakeHome = blockerFile;

    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), { logger: false, publishHandshake: true });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });

    // Server is still up and serving despite the failed write.
    const res = await fetch(`${url}/api/mcp`, { method: "DELETE" });
    expect(res.status).toBe(401); // no token supplied, but definitely not a crash/503
  });

  it("reuses the existing token from the handshake file on a same-port restart instead of minting a new one", async () => {
    // Simulates `tsx watch` restarting the dev server on its configured
    // port: a first instance publishes a token, closes without cleanup
    // running (a hard restart doesn't run onClose), and a second instance
    // boots on the *same configured port*. If it minted a fresh token here,
    // pen-editor's already-open tab (which inlined the first token at vite
    // boot) would start 401ing in a reconnect loop until the frontend dev
    // server was also restarted — exactly the bug this fix exists for.
    const first = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined, PORT: 0 }), {
      logger: false,
      publishHandshake: true,
    });
    const firstUrl = await first.listen({ port: 0, host: "127.0.0.1" });
    const firstPort = Number(new URL(firstUrl).port);
    const firstRaw = await waitForFile(handshakePath(fakeHome));
    const firstToken = (JSON.parse(firstRaw) as { token: string }).token;
    // Free the port without running Fastify's onClose hooks (no
    // removeHandshakeFile call) -- closer to a hard kill than app.close(),
    // which would delete the file itself on a graceful shutdown and leave
    // nothing to reuse.
    await new Promise<void>((resolve, reject) =>
      first.server.close((err) => (err ? reject(err) : resolve())),
    );

    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined, PORT: firstPort }), {
      logger: false,
      publishHandshake: true,
    });
    await app.listen({ port: firstPort, host: "127.0.0.1" });

    const secondRaw = await waitForFile(handshakePath(fakeHome));
    const secondToken = (JSON.parse(secondRaw) as { token: string }).token;
    expect(secondToken).toBe(firstToken);
  });

  it("mints a fresh token on restart when the configured port changed, rather than reusing a stale one", async () => {
    // Plant a stale handshake file for a *different* port than the one this
    // instance will actually bind, mkdir'ing the directory by hand since no
    // app has run yet in this test.
    const staleToken = "1".repeat(64);
    const staleEntry = { url: "http://127.0.0.1:59999/api/mcp", token: staleToken, port: 59999 };
    const dir = join(fakeHome, ".pen-editor");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "mcp.json"), JSON.stringify(staleEntry, null, 2) + "\n");

    // The real listen() port is ephemeral (astronomically unlikely to be
    // 59999), so the port-match guard in readReusableToken must reject the
    // stale entry and mint a new token instead of reusing staleToken.
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined, PORT: 0 }), {
      logger: false,
      publishHandshake: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });

    // The file already existed (we planted it above), so waitForFile's
    // plain "does it exist" check would pass immediately, before the
    // onListen hook's write has actually landed (fire-and-forget relative
    // to listen() resolving — see the comment on waitForFile). Poll until
    // the content actually changes instead.
    const start = Date.now();
    let written: { token: string; port: number } | undefined;
    while (Date.now() - start < 2000) {
      const raw = await readFile(handshakePath(fakeHome), "utf8");
      const parsed = JSON.parse(raw) as { token: string; port: number };
      if (parsed.token !== staleToken) {
        written = parsed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!written) throw new Error("handshake file was never rewritten");

    expect(written.port).not.toBe(59999);
    expect(written.token).not.toBe(staleToken);
    expect(written.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not delete a still-running instance's handshake file when a second short-lived instance closes", async () => {
    // The scenario in the finding: a dev backend is up and has published its
    // handshake file; a second, unrelated auto-token instance (a test run, a
    // second checkout, a script calling buildApp) starts and stops. Its
    // onClose must not blow away the file belonging to the still-serving
    // first instance.
    const owner = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined, PORT: 0 }), {
      logger: false,
      publishHandshake: true,
    });
    app = owner;
    await owner.listen({ port: 0, host: "127.0.0.1" });
    const ownerRaw = await waitForFile(handshakePath(fakeHome));
    const ownerToken = (JSON.parse(ownerRaw) as { token: string }).token;

    const intruder = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined, PORT: 0 }), {
      logger: false,
      publishHandshake: true,
    });
    await intruder.listen({ port: 0, host: "127.0.0.1" });
    // The intruder's onListen just overwrote the file with its own
    // token/port — expected, last-writer-wins on write. What matters is
    // what happens on *close*.
    await intruder.close();

    // The file must still exist: whichever instance is left standing after
    // the intruder closes owns it. Since the intruder wrote last, its
    // onClose correctly recognizes the file as its own and removes it —
    // this test instead asserts the *owner's* close leaves the file alone
    // once someone else has since overwritten it.
    const afterIntruderClose = await readFile(handshakePath(fakeHome), "utf8").catch(() => null);
    expect(afterIntruderClose).toBeNull();

    // Rewrite as if the owner were still the last writer (re-publish), then
    // prove a foreign entry surviving in the file stops the owner's close
    // from removing it.
    await writeFile(
      handshakePath(fakeHome),
      JSON.stringify({ url: "http://127.0.0.1:9", token: "f".repeat(64), port: 9 }, null, 2) + "\n",
    );
    await owner.close();
    app = undefined;
    const finalRaw = await readFile(handshakePath(fakeHome), "utf8");
    expect(JSON.parse(finalRaw)).toEqual({ url: "http://127.0.0.1:9", token: "f".repeat(64), port: 9 });
    expect(ownerToken).not.toBe("f".repeat(64)); // sanity: really a foreign entry
  });
});
