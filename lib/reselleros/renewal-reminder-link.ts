/**
 * What a DMS renewal reminder email may say about paying — and it is never a
 * DMS price.
 *
 * Owner, 26 Sep 2026: "Point to the ResellerOS quote". DMS still sends the
 * reminder, because DMS knows the expiry date. But renewals are ResellerOS's,
 * so the only thing the email may link to is the customer's PENDING
 * ResellerOS renewal quote (`payment_url`), read server-side through the
 * step-3 bills module (lib/reselleros/bills.ts) with its matching rules —
 * including failing closed when ResellerOS's customer record does not carry
 * exactly this email.
 *
 *   pay        — exactly one pending quote with a Pay link: link straight to it.
 *   choose     — several pending quotes: ResellerOS's quotes carry no domain,
 *                so we cannot tell which one renews THIS service; link to the
 *                panel's Invoices page, which lists them all with Pay links.
 *                Guessing one would be a confident wrong answer about money.
 *   preparing  — ResellerOS has no pending quote (or no customer) yet: say the
 *                renewal bill is being prepared and will be emailed.
 *   unknown    — ResellerOS could not be read (down, key missing, record not
 *                confirmed): still send the reminder, with no price and no
 *                link, and say where the bill will come from.
 *
 * There is deliberately no branch that carries an amount. The quote's figure
 * is on the page the link opens; putting any number in the email would make
 * it a second price source (AGENTS.md §2) and could disagree with the quote.
 */
import { fetchCustomerBills, type FetchBillsOptions } from "./bills";

export type RenewalReminderLink =
  | { kind: "pay"; paymentUrl: string }
  | { kind: "choose"; count: number; invoicesUrl: string }
  | { kind: "preparing" }
  | { kind: "unknown" };

export async function resolveRenewalReminderLink(
  email: string,
  options: FetchBillsOptions & { panelBaseUrl?: string } = {},
): Promise<RenewalReminderLink> {
  let outcome;
  try {
    outcome = await fetchCustomerBills(email, options);
  } catch {
    return { kind: "unknown" };
  }
  if (outcome.kind === "no_bills") return { kind: "preparing" };
  if (outcome.kind !== "ok") return { kind: "unknown" };

  const pending = outcome.quotes.filter((q) => q.status === "pending" && q.paymentUrl);
  if (pending.length === 0) return { kind: "preparing" };
  if (pending.length === 1) return { kind: "pay", paymentUrl: pending[0].paymentUrl as string };

  const base = (options.panelBaseUrl ?? process.env.NEXTAUTH_URL ?? "").trim().replace(/\/+$/, "");
  // Without an absolute panel URL a link in an email is dead (AGENTS.md L91),
  // so say "several bills" with no link rather than a relative one.
  if (!/^https?:\/\//i.test(base)) return { kind: "unknown" };
  return { kind: "choose", count: pending.length, invoicesUrl: `${base}/dashboard/invoices` };
}
