/**
 * The DMS account an engine-sourced sale belongs to — found by email, or created.
 *
 * Owner decision 23 (24 Sep 2026): a buyer who paid on ResellerOS gets a DMS
 * account, because DMS is where a customer manages what they bought (DNS,
 * control-panel SSO, renewals view).
 *
 * HOW THE CUSTOMER GETS IN (since 7 Oct 2026). The account is created with a
 * one-time password, which is emailed at once ("Your Customer Portal is ready");
 * the first sign-in goes to /choose-password (mustChangePassword) before anything
 * else. Until then it was an unusable random password plus a "set your password"
 * link, as DMS's guest checkout did (removed 25 Sep 2026). ResellerOS has no
 * customer portal (AGENTS.md §0), so there is no hand-off for a customer to
 * start: this email is their way in. (A first draft said "they arrive by the
 * engine-sso hand-off"; that is how STAFF reach a customer's panel, not how a
 * customer reaches their own.)
 *
 * Shared by `domain.register` and `hosting.provision` so both find the SAME
 * account for the same email: two creators with slightly different rules is how
 * one customer ends up with two logins.
 */
import { serverLogger } from "@/lib/server-logger";

export interface EngineCustomer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  phoneCc: string;
  companyName?: string;
  address?: { line1: string; city: string; state: string; country: string; zipcode: string };
}

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate the customer block of an engine payload. Throws naming what is missing. */
export function parseCustomer(raw: unknown, what = "customer"): EngineCustomer {
  const r = (raw ?? {}) as Record<string, unknown>;
  const c: EngineCustomer = {
    firstName: str(r.firstName, 60),
    lastName: str(r.lastName, 60),
    email: str(r.email, 200).toLowerCase(),
    phone: str(r.phone, 20).replace(/\D/g, ""),
    phoneCc: str(r.phoneCc, 5).replace(/\D/g, "") || "91",
    companyName: str(r.companyName, 200) || undefined,
  };
  const missing: string[] = [];
  if (!c.firstName) missing.push("first name");
  if (!c.lastName) missing.push("last name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) missing.push("a valid email");
  if (missing.length) throw new Error(`The ${what} details are incomplete (${missing.join(", ")}), so nothing was done.`);
  return c;
}

export async function ensureDmsUser(customer: EngineCustomer) {
  const users = await import("@/lib/services/users");
  const existing = await users.getUserByEmail(customer.email);
  if (existing) return { user: existing, created: false };
  /* A one-time password the customer can sign in with straight away (7 Oct 2026, Pawan); the
     portal makes them choose their own at the first sign-in (mustChangePassword). It replaced a
     "set your password" link, which made a new customer jump through a reset page first. */
  const { generateTempPassword } = await import("@/lib/auth/temp-password");
  const tempPassword = generateTempPassword();
  const user = await users.createUser({
    email: customer.email,
    password: tempPassword,
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    phoneCc: customer.phoneCc,
    companyName: customer.companyName,
    ...(customer.address ? { address: customer.address } : {}),
    isActivated: true,
    profileCompleted: Boolean(customer.address),
    mustChangePassword: true,
  });
  serverLogger.info(`[engine] created DMS account for ${customer.email}`);

  // "Your Customer Portal is ready" with the one-time password — sent at creation, so the
  // customer can always reach what they paid for whatever happens after this point.
  // Best-effort: a mail failure must not undo a sale ("Forgot password" still works).
  try {
    const { EmailService } = await import("@/lib/email");
    const name = `${customer.firstName} ${customer.lastName}`.trim() || "there";
    void EmailService.sendAccountCreatedEmail(customer.email, name, tempPassword).catch((err: unknown) =>
      serverLogger.error(`[engine] portal-ready email failed for ${customer.email}:`, err)
    );
  } catch (err) {
    serverLogger.error(`[engine] could not send the portal-ready email for ${customer.email}:`, err);
  }
  return { user, created: true };
}
