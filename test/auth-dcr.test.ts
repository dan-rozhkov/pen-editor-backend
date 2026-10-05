import { describe, expect, it } from "vitest";
import { defaultLoopbackClientToNative, patchRegistrationBody } from "../src/auth/dcr.js";
import { useAuthApp } from "./authHarness.js";

const app = useAuthApp();
const reg = (redirect_uris: string[], extra: Record<string, unknown> = {}) => ({
  client_name: "x",
  redirect_uris,
  token_endpoint_auth_method: "none",
  ...extra,
});

describe("defaultLoopbackClientToNative", () => {
  it.each(["http://localhost:53682/callback", "http://127.0.0.1:1/cb", "http://[::1]:9/x"])(
    "marks a loopback-only client native: %s",
    (uri) => {
      expect(defaultLoopbackClientToNative(reg([uri]))).toMatchObject({ application_type: "native" });
    },
  );

  it("leaves mixed, https, non-loopback and explicit types alone", () => {
    for (const body of [
      reg(["http://localhost:1/cb", "https://app.example/cb"]),
      reg(["https://localhost/cb"]),
      reg(["http://example.com/cb"]),
      reg(["http://localhost:1/cb"], { application_type: "web" }),
      reg([]),
    ]) {
      expect(defaultLoopbackClientToNative(body)).toBe(body);
    }
    expect(defaultLoopbackClientToNative("nope")).toBe("nope");
  });

  it("patchRegistrationBody ignores invalid JSON", () => {
    const raw = Buffer.from("{oops");
    expect(patchRegistrationBody(raw)).toBe(raw);
  });
});

describe("POST /api/auth/oauth2/register", () => {
  it("registers a localhost client that omits application_type", async () => {
    const res = await app().fetchAuth("/api/auth/oauth2/register", {
      method: "POST",
      body: JSON.stringify(reg(["http://localhost:53682/callback"])),
    });
    expect(res.status).toBeLessThan(300);
    expect(await res.json()).toMatchObject({ client_id: expect.any(String) });
  });

  it("still rejects a web client with a non-loopback http redirect", async () => {
    const res = await app().fetchAuth("/api/auth/oauth2/register", {
      method: "POST",
      body: JSON.stringify(reg(["http://example.com/cb"])),
    });
    expect(res.status).toBe(400);
  });
});
