/**
 * The rules `domain.register` must satisfy before any money moves — pure, so
 * every one of them is tested without a registrar.
 *
 * Owner decisions, 24 Sep 2026 (ResellerOS Todos.md §0A, decisions 21-24):
 *   - register AUTOMATICALLY after payment (21);
 *   - under the CUSTOMER's own details, so the checkout collects an address (22);
 *   - into a DMS account for that customer, created if needed (23);
 *   - with a spend limit: only a LIVE payment, only when what was paid covers
 *     ResellerClub's cost, and only while today's automatic registrations are
 *     under a daily count and rupee cap. Anything else waits for a person (24).
 *
 * A refusal here is a HOLD, not a failure: the caller keeps the paid request
 * queued for a human. Every hold message starts with HOLD_PREFIX so the caller
 * can tell "wait for a person" from "this broke" without parsing English.
 */

export const HOLD_PREFIX = "[held]";

export interface Registrant {
  firstName: string;
  lastName: string;
  email: string;
  /** Digits only, without the country code. */
  phone: string;
  /** Country calling code, digits only — "91" for India. */
  phoneCc: string;
  companyName?: string;
  address: {
    line1: string;
    city: string;
    state: string;
    /** ISO 3166-1 alpha-2, e.g. "IN". */
    country: string;
    zipcode: string;
  };
}

export interface RegisterRequest {
  years: 1;
  registrant: Registrant;
  /**
   * Rupees the customer paid, before GST, that this registration may draw on —
   * the whole order's taxable value, because a domain bundled FREE with yearly
   * hosting is paid for by the hosting line, not by a line of its own.
   */
  coverRupees: number;
  /** From the Razorpay key prefix on the paying side. Only "live" may register. */
  paymentMode: "live" | "test";
  /** The paying side's reference (ResellerOS quote id), recorded on the Domain row. */
  sourceRef: string;
}

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate the payload. Throws with a sentence naming the first thing wrong. */
export function parseRegister(payload: Record<string, unknown>): RegisterRequest {
  const years = Number(payload.years ?? 1);
  if (years !== 1) {
    throw new Error(`"years" must be 1 — automatic registration is for one year only. Received ${JSON.stringify(payload.years)}.`);
  }

  const r = (payload.registrant ?? {}) as Record<string, unknown>;
  const a = (r.address ?? {}) as Record<string, unknown>;
  const registrant: Registrant = {
    firstName: str(r.firstName, 60),
    lastName: str(r.lastName, 60),
    email: str(r.email, 200).toLowerCase(),
    phone: str(r.phone, 20).replace(/\D/g, ""),
    phoneCc: str(r.phoneCc, 5).replace(/\D/g, "") || "91",
    companyName: str(r.companyName, 200) || undefined,
    address: {
      line1: str(a.line1, 200),
      city: str(a.city, 80),
      state: str(a.state, 80),
      country: str(a.country, 2).toUpperCase() || "IN",
      zipcode: str(a.zipcode, 12),
    },
  };

  const missing: string[] = [];
  if (!registrant.firstName) missing.push("first name");
  if (!registrant.lastName) missing.push("last name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registrant.email)) missing.push("a valid email");
  if (registrant.phone.length < 7) missing.push("a phone number");
  if (!registrant.address.line1) missing.push("address line");
  if (!registrant.address.city) missing.push("city");
  if (!registrant.address.state) missing.push("state");
  if (!/^[A-Z]{2}$/.test(registrant.address.country)) missing.push("country code");
  if (!registrant.address.zipcode) missing.push("PIN / postcode");
  if (missing.length) {
    throw new Error(
      `The registrant details are incomplete (${missing.join(", ")}). ResellerClub will not create ` +
        `the owner record a domain is registered to without them, so nothing was registered.`
    );
  }

  const coverRupees = Number(payload.coverRupees);
  if (!Number.isFinite(coverRupees) || coverRupees < 0) {
    throw new Error(`"coverRupees" must be the rupees paid before GST. Received ${JSON.stringify(payload.coverRupees)}.`);
  }

  const paymentMode = payload.paymentMode;
  if (paymentMode !== "live" && paymentMode !== "test") {
    throw new Error(`"paymentMode" must be "live" or "test" — the paying side's Razorpay key mode.`);
  }

  const sourceRef = str(payload.sourceRef, 80);
  if (!sourceRef) throw new Error(`"sourceRef" (the paying side's order reference) is required.`);

  return { years: 1, registrant, coverRupees, paymentMode, sourceRef };
}

/** A domain this command may register: one label + a TLD, nothing else. */
export function isRegistrableName(d: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(d);
}

/** The TLD part of a registrable name: "acme.co.in" → "co.in". */
export function tldOf(d: string): string {
  return d.slice(d.indexOf(".") + 1);
}

export interface DailyUsage {
  /** Automatic registrations in the last 24 hours, not counting this one. */
  count: number;
  /** Their ResellerClub cost in rupees. */
  rupees: number;
}

export interface Caps {
  maxPerDay: number;
  maxRupeesPerDay: number;
}

/**
 * The daily cap, from env with conservative defaults. Unset or unparseable
 * values fall back to the default rather than to "no limit" — a missing limit
 * must never read as unlimited spending.
 */
export function capsFromEnv(env: Record<string, string | undefined>): Caps {
  const n = (v: string | undefined, dflt: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : dflt;
  };
  return {
    maxPerDay: n(env.ENGINE_DOMAIN_REGISTER_MAX_PER_DAY, 5),
    maxRupeesPerDay: n(env.ENGINE_DOMAIN_REGISTER_MAX_RUPEES_PER_DAY, 10_000),
  };
}

export type SpendDecision = { ok: true } | { ok: false; hold: string };

/**
 * May this registration spend `costRupees`? Checked in the order a person would
 * want the reason: the payment first, then this order's cover, then the day.
 */
export function decideSpend(input: {
  paymentMode: "live" | "test";
  costRupees: number | null;
  coverRupees: number;
  usage: DailyUsage;
  caps: Caps;
  domain: string;
}): SpendDecision {
  const hold = (why: string): SpendDecision => ({ ok: false, hold: `${HOLD_PREFIX} ${why}` });

  if (input.paymentMode !== "live") {
    return hold(
      `${input.domain} was paid through a TEST-mode Razorpay key, so no money settled. It is not ` +
        `registered automatically at any setting.`
    );
  }
  if (input.costRupees === null || !(input.costRupees > 0)) {
    return hold(
      `ResellerClub's cost for ${input.domain} could not be read, so it cannot be checked against ` +
        `what was paid. Register it by hand after checking the price.`
    );
  }
  if (input.coverRupees < input.costRupees) {
    return hold(
      `${input.domain} costs ₹${input.costRupees} at ResellerClub but only ₹${input.coverRupees} was ` +
        `paid (before GST). Check the order before registering it by hand.`
    );
  }
  if (input.usage.count + 1 > input.caps.maxPerDay) {
    return hold(
      `the daily limit of ${input.caps.maxPerDay} automatic registrations is reached ` +
        `(${input.usage.count} in the last 24 hours). Release it by hand, or raise ` +
        `ENGINE_DOMAIN_REGISTER_MAX_PER_DAY.`
    );
  }
  if (input.usage.rupees + input.costRupees > input.caps.maxRupeesPerDay) {
    return hold(
      `the daily spend limit of ₹${input.caps.maxRupeesPerDay} would be passed ` +
        `(₹${input.usage.rupees} spent in the last 24 hours + ₹${input.costRupees}). Release it by ` +
        `hand, or raise ENGINE_DOMAIN_REGISTER_MAX_RUPEES_PER_DAY.`
    );
  }
  return { ok: true };
}
