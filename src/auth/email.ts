import { Resend } from "resend";
import type { Config } from "../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type EmailSender = (message: EmailMessage) => Promise<void>;

// Resend when RESEND_API_KEY + EMAIL_FROM are set; otherwise the message is
// logged to stdout so local development can click the link from the terminal.
export function createEmailSender(
  config: Pick<Config, "RESEND_API_KEY" | "EMAIL_FROM">,
  log: (line: string) => void = console.log,
): EmailSender {
  const { RESEND_API_KEY, EMAIL_FROM } = config;
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    return async (message) => {
      log(`[auth] email not configured — would send to ${message.to}: ${message.subject}\n${message.text}`);
    };
  }
  const resend = new Resend(RESEND_API_KEY);
  return async (message) => {
    const { error } = await resend.emails.send({ from: EMAIL_FROM, ...message });
    if (error) throw new Error(`Resend rejected the email: ${error.message}`);
  };
}

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function linkEmail(to: string, subject: string, intro: string, action: string, url: string): EmailMessage {
  return {
    to,
    subject,
    text: `${intro}\n\n${action}: ${url}\n\nIf you did not ask for this, ignore this email.`,
    html:
      `<p>${escapeHtml(intro)}</p>` +
      `<p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p>` +
      `<p>If you did not ask for this, ignore this email.</p>`,
  };
}

export const verifyEmailMessage = (to: string, url: string): EmailMessage =>
  linkEmail(to, "Verify your Sideform email", "Confirm your email address to finish creating your Sideform account.", "Verify email", url);

export const magicLinkMessage = (to: string, url: string): EmailMessage =>
  linkEmail(to, "Your Sideform sign-in link", "Use this link to sign in to Sideform. It works once and expires soon.", "Sign in", url);

export const resetPasswordMessage = (to: string, url: string): EmailMessage =>
  linkEmail(to, "Reset your Sideform password", "Use this link to choose a new Sideform password.", "Reset password", url);
