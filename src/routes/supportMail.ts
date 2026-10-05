import type { FastifyInstance } from "fastify";
import { Resend, type EmailReceivedEvent } from "resend";
import { isSupportMailEnabled, parseEnvList, type Config } from "../config.js";
import { escapeHtml } from "../auth/email.js";

const FORWARD_FROM = "Sideform Support <noreply@sideform.pro>";
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SEEN_CAPACITY = 1000;

// "Name <a@b.c>" -> "a@b.c", lowercased.
const bareAddress = (value: string): string => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

// Insertion-ordered Set used as a small LRU of already-handled svix ids.
class SeenIds {
  private readonly ids = new Set<string>();
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > SEEN_CAPACITY) this.ids.delete(this.ids.values().next().value as string);
  }
  delete(id: string): void {
    this.ids.delete(id);
  }
}

type Attachment = NonNullable<Parameters<Resend["emails"]["send"]>[0]["attachments"]>[number];

// Downloads every attachment when the total fits the budget; otherwise
// returns just the names so the forward still says what was attached.
async function collectAttachments(
  resend: Resend,
  emailId: string,
  declared: { filename: string | null; size: number }[],
): Promise<{ files: Attachment[]; names: string[] }> {
  const names = declared.map((a) => a.filename ?? "(unnamed)");
  const total = declared.reduce((sum, a) => sum + a.size, 0);
  if (declared.length === 0 || total > MAX_ATTACHMENT_BYTES) return { files: [], names };
  const { data, error } = await resend.emails.receiving.attachments.list({ emailId });
  if (error || !data) return { files: [], names };
  const files: Attachment[] = [];
  for (const item of data.data) {
    const res = await fetch(item.download_url);
    if (!res.ok) return { files: [], names };
    files.push({ filename: item.filename, content: Buffer.from(await res.arrayBuffer()), contentType: item.content_type });
  }
  return { files, names: [] };
}

export async function supportMailRoutes(app: FastifyInstance, config: Config, injected?: Resend): Promise<void> {
  const enabled = isSupportMailEnabled(config);
  const resend = enabled ? (injected ?? new Resend(config.RESEND_API_KEY)) : null;
  // Reading inbound mail needs a full-access key; sending keeps the send-only one.
  const reader =
    enabled && !injected && config.RESEND_INBOUND_API_KEY ? new Resend(config.RESEND_INBOUND_API_KEY) : resend;
  const inboxes = new Set(parseEnvList(config.SUPPORT_INBOX_ADDRESSES).map((a) => a.toLowerCase()));
  const seen = new SeenIds();

  // Encapsulated so the raw-body parser applies to this route only: the
  // signature covers the exact bytes.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));

    scope.post(
      "/api/webhooks/resend",
      { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (request, reply) => {
        if (!resend) return reply.status(503).send({ error: "support_mail_disabled" });

        const id = request.headers["svix-id"];
        const timestamp = request.headers["svix-timestamp"];
        const signature = request.headers["svix-signature"];
        if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string" || typeof request.body !== "string") {
          return reply.status(401).send({ error: "invalid_signature" });
        }
        let event;
        try {
          event = resend.webhooks.verify({
            payload: request.body,
            headers: { id, timestamp, signature },
            webhookSecret: config.RESEND_WEBHOOK_SECRET as string,
          });
        } catch {
          return reply.status(401).send({ error: "invalid_signature" });
        }
        if (event.type !== "email.received") return { ok: true, ignored: "event" };
        if (seen.has(id)) return { ok: true, duplicate: true };

        const meta = (event as EmailReceivedEvent).data;
        const inbox = [...meta.to, ...meta.received_for].map(bareAddress).find((a) => inboxes.has(a));
        if (!inbox) return { ok: true, ignored: "recipient" };

        // Claim the id before the slow work so a concurrent retry cannot
        // forward twice; release it on failure so Resend's retry can.
        seen.add(id);
        try {
          const { data: mail, error } = await (reader ?? resend).emails.receiving.get(meta.email_id);
          if (error || !mail) throw new Error(`fetch inbound email failed: ${error?.message ?? "empty"}`);
          const { files, names } = await collectAttachments(reader ?? resend, meta.email_id, mail.attachments);

          const label = inbox.split("@")[0];
          const note = names.length > 0 ? `Attachments not forwarded: ${names.join(", ")}` : "";
          const header = `From: ${mail.from}\nTo: ${mail.to.join(", ")}\nDate: ${mail.created_at}`;
          const text = `${header}${note ? `\n${note}` : ""}\n\n${mail.text ?? ""}`;
          const html =
            `<div style="font-family:sans-serif;color:#555;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">` +
            `<div>From: ${escapeHtml(mail.from)}</div><div>To: ${escapeHtml(mail.to.join(", "))}</div>` +
            `<div>Date: ${escapeHtml(mail.created_at)}</div>${note ? `<div>${escapeHtml(note)}</div>` : ""}</div>` +
            (mail.html ?? `<pre>${escapeHtml(mail.text ?? "")}</pre>`);

          const sent = await resend.emails.send({
            from: FORWARD_FROM,
            to: config.SUPPORT_FORWARD_TO as string,
            replyTo: mail.from,
            subject: `[${label}] ${oneLine(mail.subject)}`,
            text,
            html,
            ...(files.length > 0 && { attachments: files }),
          });
          if (sent.error) throw new Error(`forward rejected: ${sent.error.message}`);
          request.log.info({ svixId: id, emailId: meta.email_id }, "support mail forwarded");
          return { ok: true };
        } catch (err) {
          seen.delete(id);
          request.log.error({ svixId: id, emailId: meta.email_id, err: err instanceof Error ? err.message : "unknown" }, "support mail forward failed");
          return reply.status(500).send({ error: "forward_failed" });
        }
      },
    );
  });
}
