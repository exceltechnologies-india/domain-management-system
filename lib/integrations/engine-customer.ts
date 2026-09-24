/**
 * The DMS account an engine-sourced sale belongs to — found by email, or created.
 *
 * Owner decision 23 (24 Sep 2026): a buyer who paid on ResellerOS gets a DMS
 * account, because DMS is where a customer manages what they bought (DNS,
 * control-panel SSO, renewals view).
 *
 * HOW THE CUSTOMER GETS IN. The account is created with an unusable random
 * password and a "set your password" email is sent at once — the same thing
 * DMS's guest checkout does (app/api/payments/guest/verify). ResellerOS has no
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
  const { randomBytes } = await import("node:crypto");
  const user = await users.createUser({
    email: customer.email,
    // Unusable: never shown or stored anywhere else. The setup email below is the way in.
    password: randomBytes(32).toString("hex"),
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.phone,
    phoneCc: customer.phoneCc,
    companyName: customer.companyName,
    ...(customer.address ? { address: customer.address } : {}),
    isActivated: true,
    profileCompleted: Boolean(customer.address),
  });
  serverLogger.info(`[engine] created DMS account for ${customer.email}`);

  // "Set your password" — sent at creation, like guest checkout, so the customer
  // can always reach what they paid for whatever happens after this point.
  // Best-effort: a mail failure must not undo a sale.
  try {
    const setupToken = randomBytes(32).toString("hex");
    user.resetToken = setupToken;
    user.resetTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days: they did not ask for this mail
    await user.save();
    const { EmailService } = await import("@/lib/email");
    const name = `${customer.firstName} ${customer.lastName}`.trim() || "there";
    void EmailService.sendPasswordResetEmail(customer.email, name, setupToken, true).catch((err: unknown) =>
      serverLogger.error(`[engine] setup email failed for ${customer.email}:`, err)
    );
  } catch (err) {
    serverLogger.error(`[engine] could not prepare the setup email for ${customer.email}:`, err);
  }
  return { user, created: true };
}
