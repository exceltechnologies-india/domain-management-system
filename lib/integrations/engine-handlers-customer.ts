/**
 * customer.ensure — the customer's Customer Portal account, the moment they have paid
 * (Pawan, 7 Oct 2026: "We should see the login details of hosting/domain panel immediately.
 * Hosting can be assigned in background in meanwhile").
 *
 * Until then the account — and its "Your Customer Portal is ready" email with the one-time
 * password — was only made inside hosting.provision / domain.register, so the login arrived
 * when the provisioning cron next ran (every 15 min, 9–21 IST on the live site) or later.
 * ResellerOS now sends this from its payment webhook; provisioning, later, finds the same
 * account by email (ensureDmsUser) and sends no second email.
 *
 * Spends nothing and touches no provider: it only finds or creates a DMS user. Live behind its
 * own gate (ENGINE_CUSTOMER_ACCOUNT_LIVE, engine-mode.ts OWN_LIVE_GATES). Test mode reports what
 * a live run would do and creates nothing. The subject is the customer's email.
 */
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import { ensureDmsUser, parseCustomer } from "./engine-customer";

export const ensureCustomerCommand: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const customer = parseCustomer(ctx.payload.customer, "customer");
  const subject = ctx.subject.trim().toLowerCase();
  if (subject !== customer.email) {
    throw new Error(`The command is for ${subject} but the customer's email is ${customer.email}, so nothing was done.`);
  }

  if (ctx.mode === "test") {
    const users = await import("@/lib/services/users");
    const existing = await users.getUserByEmail(customer.email);
    return { result: { ok: true, dryRun: true, wouldCreate: !existing, email: customer.email } };
  }

  const { user, created } = await ensureDmsUser(customer);
  return { result: { ok: true, email: customer.email, userId: String(user._id), created, emailed: created } };
};
