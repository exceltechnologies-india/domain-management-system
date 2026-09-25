/**
 * What a Renew button offers, now that renewals are ResellerOS's.
 *
 * Owner decisions, 24-25 Sep 2026: "Renewals subscription will be handled by
 * ResellerOS. Period. Our DMS will only fetch that renewal bill from
 * ResellerOS and show it." DMS no longer raises a renewal order, takes a
 * renewal payment, or prices a renewal. A Renew button therefore sends the
 * customer to the PENDING ResellerOS quote — ResellerOS emails one before
 * expiry — and, when there is none, says so and how to get help.
 *
 * Matching: ResellerOS's quotes API carries no domain or product on a quote,
 * so a quote cannot be tied to one service with certainty. Every pending
 * quote with a Pay link is offered, labelled by its number and amount, and
 * the customer picks the one their renewal email names. Guessing one would be
 * a confident wrong answer about money (AGENTS.md §2).
 */

export interface PendingQuote {
  id: string;
  /** Whole rupees. */
  amount: number;
  paymentUrl: string;
}

export type BillsForRenewal =
  | { state: "ok"; quotes: Array<{ id: string; amount: number; status: string; paymentUrl: string | null }> }
  | { state: "no_bills" }
  | { state: "unavailable"; message: string };

export type RenewalChoice =
  | { kind: "pay"; quotes: PendingQuote[] }
  | { kind: "none" }
  | { kind: "unavailable"; message: string };

export function renewalChoice(bills: BillsForRenewal): RenewalChoice {
  if (bills.state === "unavailable") return { kind: "unavailable", message: bills.message };
  if (bills.state === "no_bills") return { kind: "none" };
  const quotes: PendingQuote[] = bills.quotes
    .filter((q) => q.status === "pending" && typeof q.paymentUrl === "string" && q.paymentUrl.length > 0)
    .map((q) => ({ id: q.id, amount: q.amount, paymentUrl: q.paymentUrl as string }));
  return quotes.length > 0 ? { kind: "pay", quotes } : { kind: "none" };
}

/** §7 copy for "there is no renewal quote to pay yet". */
export function noRenewalQuoteMessage(serviceName: string, support: string): string {
  return (
    `There's no renewal bill for ${serviceName} to pay yet. ` +
    "Renewals are billed by our billing system, which emails you a renewal bill with a Pay link before your service expires. " +
    `If it's close to expiry and you haven't received one, email ${support} and we'll send it.`
  );
}
