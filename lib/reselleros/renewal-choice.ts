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
 * Matching (28 Sep 2026): ResellerOS now says what each quote renews (`renews`:
 * the subscription's vendor + domain). A service's Renew offers only the quotes
 * that renew THAT service — so the domain dialog no longer offers the hosting
 * renewal, and an unpaid new order is never offered as a renewal. A quote whose
 * `renews` is unknown (an older ResellerOS) is still offered, labelled by number
 * and amount, for the customer to pick by their renewal email; guessing it away
 * would hide a real bill (AGENTS.md §2). Since the same date the customer pays
 * inside the panel, which is why offering the wrong bill matters.
 */

export interface PendingQuote {
  id: string;
  /** Whole rupees. */
  amount: number;
  paymentUrl: string;
}

export interface RenewalService {
  type: "hosting" | "domain";
  /** The hosting account's domain, or the domain name. */
  name: string;
}

type Renews = Array<{ vendor: string; domain: string | null }> | null | undefined;

export type BillsForRenewal =
  | { state: "ok"; quotes: Array<{ id: string; amount: number; status: string; paymentUrl: string | null; renews?: Renews }> }
  | { state: "no_bills" }
  | { state: "unavailable"; message: string };

export type RenewalChoice =
  | { kind: "pay"; quotes: PendingQuote[] }
  | { kind: "none" }
  | { kind: "unavailable"; message: string };

/** Does this quote renew this service? null when ResellerOS did not say. */
function renewsService(renews: Renews, service: RenewalService): boolean | null {
  if (!Array.isArray(renews)) return null;
  const name = service.name.trim().toLowerCase();
  return renews.some((r) => r.vendor === service.type && (r.domain ?? "").trim().toLowerCase() === name);
}

export function renewalChoice(bills: BillsForRenewal, service?: RenewalService): RenewalChoice {
  if (bills.state === "unavailable") return { kind: "unavailable", message: bills.message };
  if (bills.state === "no_bills") return { kind: "none" };
  const quotes: PendingQuote[] = bills.quotes
    .filter((q) => q.status === "pending" && typeof q.paymentUrl === "string" && q.paymentUrl.length > 0)
    // Known to renew something else, or nothing: not this service's bill. Unknown: offered.
    .filter((q) => !service || renewsService(q.renews, service) !== false)
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
