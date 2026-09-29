import { describe, expect, it, vi } from "vitest";
import { createSteelClient, SteelError } from "../src/services/steel.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(...responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  const client = createSteelClient({ apiKey: "k&y", baseUrl: "https://steel.test/", fetchImpl });
  return { client, fetchImpl };
}

describe("createSteelClient", () => {
  it("creates a session with the key header, timeout, viewport and a view-only live view", async () => {
    const { client, fetchImpl } = clientWith(
      jsonResponse(200, { id: "s1", debugUrl: "https://view/s1", websocketUrl: "wss://ws/s1", createdAt: "2026-09-29T10:00:00Z", timeout: 900000 }),
    );
    const session = await client.createSession({ timeoutMs: 900000, dimensions: { width: 1280, height: 800 } });

    expect(session).toEqual({
      id: "s1", liveViewUrl: "https://view/s1", websocketUrl: "wss://ws/s1",
      createdAt: "2026-09-29T10:00:00Z", timeoutMs: 900000,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://steel.test/v1/sessions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["steel-api-key"]).toBe("k&y");
    expect(JSON.parse(String(init?.body))).toEqual({
      timeout: 900000, dimensions: { width: 1280, height: 800 }, debugConfig: { interactive: false },
    });
  });

  it("defaults websocketUrl to an empty string when Steel omits it", async () => {
    const { client } = clientWith(jsonResponse(200, { id: "s1", debugUrl: "https://view/s1" }));
    await expect(client.createSession({ timeoutMs: 1, dimensions: { width: 1, height: 1 } })).resolves.toMatchObject({ websocketUrl: "" });
  });

  it("rejects a failed or incomplete create with a SteelError carrying the status", async () => {
    const { client } = clientWith(jsonResponse(402, {}), jsonResponse(200, { id: "s1" }));
    const opts = { timeoutMs: 1, dimensions: { width: 1, height: 1 } };
    await expect(client.createSession(opts)).rejects.toMatchObject({ name: "SteelError", status: 402 });
    await expect(client.createSession(opts)).rejects.toThrow("no id/debugUrl");
  });

  it("reads a session's status, and maps 404 to null", async () => {
    const { client, fetchImpl } = clientWith(
      jsonResponse(200, { id: "s1", status: "live", createdAt: "2026-09-29T10:00:00Z", timeout: 900000, debugUrl: "https://view/s1" }),
      jsonResponse(200, {}),
      jsonResponse(404, {}),
    );
    await expect(client.getSession("s 1")).resolves.toEqual({
      id: "s1", status: "live", createdAt: "2026-09-29T10:00:00Z", timeoutMs: 900000, liveViewUrl: "https://view/s1",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://steel.test/v1/sessions/s%201");
    await expect(client.getSession("s2")).resolves.toMatchObject({ id: "s2", status: "unknown" });
    await expect(client.getSession("gone")).resolves.toBeNull();
  });

  it("throws on a non-404 getSession failure", async () => {
    const { client } = clientWith(jsonResponse(500, {}));
    await expect(client.getSession("s1")).rejects.toBeInstanceOf(SteelError);
  });

  it("releases a session, treating 404 as already released", async () => {
    const { client, fetchImpl } = clientWith(jsonResponse(200, {}), jsonResponse(404, {}), jsonResponse(503, {}));
    await expect(client.releaseSession("s1")).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://steel.test/v1/sessions/s1/release");
    await expect(client.releaseSession("s1")).resolves.toBeUndefined();
    await expect(client.releaseSession("s1")).rejects.toMatchObject({ status: 503 });
  });

  it("builds a CDP URL with the key and session id encoded", () => {
    const { client } = clientWith();
    expect(client.cdpUrl("s/1")).toBe("wss://connect.steel.dev?apiKey=k%26y&sessionId=s%2F1");
  });
});
