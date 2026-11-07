import { SITE_URL } from "@/lib/config/site";
import { EMAIL_VERIFICATION_TTL_MS } from "./registration";
import type { EmailMessage } from "./email";

/**
 * The self-service signup surface: the verification link and the message that
 * carries it.
 *
 * The link points at the developer portal, which reads the token from the URL and
 * exchanges it for the account's first API key. The token is a bearer secret for
 * one action (verify this address), which is why the message never includes a
 * credential and the route never logs the link.
 */

/** The public origin to build absolute links from. */
export function publicOrigin(): string {
  const explicit = process.env.INTENT_PAY_PUBLIC_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return SITE_URL;
}

/** The verification link a developer clicks. */
export function verificationLink(token: string, origin = publicOrigin()): string {
  return `${origin.replace(/\/+$/, "")}/developer/verify?token=${encodeURIComponent(token)}`;
}

/** How long the link stays valid, in words (for the email copy). */
export function verificationWindowHours(): number {
  return Math.round(EMAIL_VERIFICATION_TTL_MS / (60 * 60 * 1000));
}

/** Compose the verification email. */
export function verificationEmail(input: { to: string; link: string }): EmailMessage {
  const hours = verificationWindowHours();
  const text = [
    "Confirm your Intent Pay developer account",
    "",
    "Open this link to verify your email address and receive your API key:",
    input.link,
    "",
    `The link expires in ${hours} hours and can be used once.`,
    "If you did not request this, you can ignore this message.",
    "",
    "Intent Pay — intent-based payments on Monad.",
  ].join("\n");
  const html = [
    `<p>Confirm your Intent Pay developer account.</p>`,
    `<p><a href="${input.link}">Verify your email and get your API key</a></p>`,
    `<p>The link expires in ${hours} hours and can be used once.</p>`,
    `<p>If you did not request this, you can ignore this message.</p>`,
  ].join("");
  return { to: input.to, subject: "Verify your Intent Pay developer account", text, html };
}
