/**
 * The customer email pattern — the same one ResellerOS uses (Pawan, 3 Oct 2026: "email design
 * and pattern for both ResellerOS and DMS should be identical; tone down DMS to match").
 *
 * ResellerOS writes its customer emails as plain sentences: "Hi <first name>,", what happened,
 * the one link that matters, how to get help, and a sign-off — no banners, gradients or emoji.
 * DMS is a backend service for ResellerOS now, so a customer must not be able to tell which of
 * the two sent an email: same sender name, same voice, same plain look.
 *
 * `plainEmailHtml` renders that text for mail clients that prefer HTML without restyling it:
 * the words and line breaks exactly as the text part, links clickable, nothing added.
 */

/** The name the customer knows us by — the From name both apps send as. */
export function brandName(): string {
  return process.env.FROM_NAME?.trim().replace(/^"(.*)"$/, "$1") || "Anutech Digital";
}

/** The Customer Portal's sign-in page (this app, which the customer knows as the portal). */
export function portalLoginUrl(): string {
  return `${(process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "")}/login`;
}

/** "Ada Lovelace" → "Ada"; empty → "there". */
export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "there";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The plain text as HTML: same words and line breaks, links clickable, no styling added. */
export function plainEmailHtml(text: string): string {
  const linked = escapeHtml(text)
    .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)
    .replace(/(^|[\s(])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_m, pre: string, e: string) => `${pre}<a href="mailto:${e}">${e}</a>`);
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #111111; white-space: pre-wrap;">${linked}</div>`;
}
