#!/usr/bin/env node
// Smoke test of the local bundle: copies dist-local/ to an empty temp dir (no
// node_modules anywhere above it), starts it with plain `node`, waits for the
// READY line, then runs GET /api/models and a browser-mode chat against a
// local mock OpenAI-compatible provider. Exit 0 = ok, 1 = failed.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockProvider } from "./lib/mockOpenAiProvider.mjs";

const TOKEN = "smoke-token";
const MODEL_TEXT = "hello from the mock provider";
const source = fileURLToPath(new URL("../dist-local", import.meta.url));

const tmp = await mkdtemp(join(tmpdir(), "sideform-local-smoke-"));
const mock = await startMockProvider(MODEL_TEXT);
let child;
let failure;

const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok: ${what}`);
};

try {
  await cp(source, join(tmp, "dist-local"), { recursive: true });
  const dataDir = join(tmp, "data");
  child = spawn(process.execPath, [join(tmp, "dist-local", "server.mjs")], {
    cwd: tmp,
    // Inherited tokens must be ignored: put a bogus OpenRouter key in on purpose.
    env: {
      PATH: process.env.PATH,
      SIDEFORM_LOCAL: "1",
      PORT: "0",
      SIDEFORM_LOCAL_TOKEN: TOKEN,
      SIDEFORM_LOCAL_DATA_DIR: dataDir,
      OPENROUTER_API_KEY: "sk-should-be-ignored",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (d) => (output += d));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no READY line in 20s\n${output}`)), 20_000);
    child.stdout.on("data", (d) => {
      output += d;
      const match = /SIDEFORM_LOCAL_READY port=(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code})\n${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const authed = { "x-sideform-local-token": TOKEN };

  // The bundle refuses to start without a token (fail closed).
  const tokenless = spawn(process.execPath, [join(tmp, "dist-local", "server.mjs")], {
    cwd: tmp,
    env: { PATH: process.env.PATH, SIDEFORM_LOCAL: "1", PORT: "0" },
    stdio: "ignore",
  });
  const tokenlessCode = await new Promise((resolve) => tokenless.on("exit", resolve));
  check(tokenlessCode === 1, "the bundle refuses to start without SIDEFORM_LOCAL_TOKEN");

  // DNS-rebinding defence: a foreign Host header is 403 even with a valid token.
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/models", headers: { ...authed, host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  check(foreignHost === 403, "a foreign Host header is 403");

  const noToken = await fetch(`${base}/api/models`);
  check(noToken.status === 401, "request without the token is 401");

  const models = await (await fetch(`${base}/api/models`, { headers: authed })).json();
  check(
    JSON.stringify(models) ===
      JSON.stringify({ models: [], default: null, visionFallback: false, imageOps: { removeBackground: false, vectorize: false } }),
    "GET /api/models has no server models",
  );

  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { ...authed, "content-type": "application/json", "x-byok-base-url": mock.baseUrl, "x-byok-key": "sk-mock" },
    body: JSON.stringify({
      model: "byok/mock-model",
      agentMode: "browser",
      clientCapabilities: { desktopBrowser: true, browser: "desktop" },
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    }),
  });
  const body = await chat.text();
  check(chat.status === 200, "POST /api/chat with a byok model answers 200");
  check(body.includes(MODEL_TEXT), "the chat streams the mock provider's text");
  check(mock.requests.some((r) => r.url === "/v1/chat/completions" && r.authorization === "Bearer sk-mock"), "the mock provider got the user's key");

  const refused = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { ...authed, "content-type": "application/json" },
    body: JSON.stringify({ agentMode: "browser", messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
  });
  check(refused.status === 400 && (await refused.json()).error === "provider_required", "chat without a byok model is provider_required");
  console.log("smoke:local passed");
} catch (err) {
  failure = err;
  console.error(err instanceof Error ? err.message : err);
} finally {
  if (child && child.exitCode === null) {
    child.removeAllListeners("exit");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  await mock.close();
  await rm(tmp, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
