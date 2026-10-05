import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Resend } from "resend";
import { startApp, type RunningApp } from "./chatHarness.js";
import { makeConfig } from "./helpers.js";

const SECRET = `whsec_${Buffer.from("support-mail-test-secret").toString("base64")}`;
const ON = makeConfig({
  RESEND_API_KEY: "re_test",
  RESEND_WEBHOOK_SECRET: SECRET,
  SUPPORT_FORWARD_TO: "owner@example.com",
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

function sign(id: string, timestamp: number, body: string): string {
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function eventBody(to: string[], attachments: unknown[] = []): string {
  return JSON.stringify({
    type: "email.received",
    created_at: "2026-10-05T10:00:00Z",
    data: { email_id: "em_1", created_at: "2026-10-05T10:00:00Z", from: "Ann <ann@x.com>", to, bcc: [], cc: [], received_for: to, message_id: "<m@x>", subject: "Help\nme", attachments },
  });
}

const mail = (attachments: unknown[] = []) => ({
  data: { from: "Ann <ann@x.com>", to: ["support@sideform.pro"], created_at: "2026-10-05T10:00:00Z", subject: "Help\nme", text: "hello", html: "<p>hello</p>", attachments },
  error: null,
});

let running: RunningApp | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function setup(config = ON) {
  const resend = new Resend("re_test");
  const get = vi.spyOn(resend.emails.receiving, "get").mockResolvedValue(mail() as never);
  const send = vi.spyOn(resend.emails, "send").mockResolvedValue({ data: { id: "out" }, error: null } as never);
  running = await startApp(config, { supportMailResend: resend });
  const post = (body: string, headers: Record<string, string> = {}, id = "msg_1", timestamp = nowSeconds()) =>
    fetch(`${running!.url}/api/webhooks/resend`, {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": sign(id, timestamp, body), ...headers },
      body,
    });
  return { get, send, post };
}

describe("POST /api/webhooks/resend", () => {
  it("forwards a signed message with reply_to and a labelled subject", async () => {
    const { send, post } = await setup();
    const res = await post(eventBody(["support@sideform.pro"]));
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: "owner@example.com",
      replyTo: "Ann <ann@x.com>",
      subject: "[support] Help me",
    });
    expect(send.mock.calls[0][0].text).toContain("hello");
  });

  it("labels privacy mail and lists attachments that exceed the size budget", async () => {
    const { get, send, post } = await setup();
    get.mockResolvedValue(mail([{ id: "a", filename: "big.pdf", size: 20 * 1024 * 1024, content_type: "application/pdf" }]) as never);
    await post(eventBody(["privacy@sideform.pro"], [{ id: "a" }]));
    const sent = send.mock.calls[0][0];
    expect(sent.subject).toBe("[privacy] Help me");
    expect(sent.text).toContain("big.pdf");
    expect(sent.attachments).toBeUndefined();
  });

  it.each([
    ["bad signature", { "svix-signature": "v1,AAAA" }, nowSeconds()],
    ["missing signature headers", { "svix-signature": "", "svix-id": "" }, nowSeconds()],
    ["stale timestamp", {}, nowSeconds() - 3600],
  ])("rejects %s with 401", async (_case, headers, timestamp) => {
    const { send, post } = await setup();
    const body = eventBody(["support@sideform.pro"]);
    const res = await post(body, headers, "msg_1", timestamp);
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards a replayed svix-id once", async () => {
    const { send, post } = await setup();
    const body = eventBody(["support@sideform.pro"]);
    await post(body);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignores mail for other recipients", async () => {
    const { get, send, post } = await setup();
    const res = await post(eventBody(["someone@sideform.pro"]));
    expect(res.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 503 when the feature is off", async () => {
    const { post } = await setup(makeConfig({ RESEND_API_KEY: "re_test" }));
    expect((await post(eventBody(["support@sideform.pro"]))).status).toBe(503);
  });
});
