/**
 * `domain.register` — Phase 9. Registering a domain cannot be undone.
 *
 * Owner decisions, 24 Sep 2026 (ResellerOS Todos.md §0A, 21-24): a domain paid
 * for on the ResellerOS site is registered AUTOMATICALLY, under the customer's
 * own details, into a DMS account for them, within a spend limit. The rules
 * live in `engine-register-policy.ts`; this file is the order they run in.
 *
 * ─── THE ORDER IS THE SAFETY ─────────────────────────────────────────────────
 *   1. validate the payload                       (throws → not_sent)
 *   2. is it ALREADY in our reseller account?     READ. For this customer → done,
 *                                                 no spend (the retry case). For
 *                                                 anybody else → refuse.
 *   3. ResellerClub's cost + today's usage        READ. The spend decision.
 *   test mode stops here and reports what live would do.
 *   4. spend decision                             a hold throws before any write
 *   5. DMS account, RC customer + contact         writes, but not money, and each
 *                                                 is found-or-created by email, so
 *                                                 a retry reuses them
 *   6. REGISTER                                   the one irreversible call,
 *                                                 wrapped so a lost response is
 *                                                 `sent_unknown` and HOLDS the claim
 *   7. record it on the customer's DMS account    a failure here is logged, never
 *                                                 thrown: the domain IS registered
 *
 * Live is gated separately from every other command: `ENGINE_DOMAIN_REGISTER_LIVE`
 * must be exactly "1" (engine-mode.ts). The paying side has its own gate too.
 */
import { serverLogger } from "@/lib/server-logger";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";
import { attemptProviderWrite, brandTransport } from "./engine-attempt";
import type { Transport } from "./transport";
import {
  HOLD_PREFIX,
  capsFromEnv,
  decideSpend,
  isRegistrableName,
  parseRegister,
  tldOf,
  type RegisterRequest,
} from "./engine-register-policy";
import { readDailyUsage } from "./engine-spend-usage";
import { ensureDmsUser } from "./engine-customer";

/** Lazy for the same reason as the other handlers: these modules throw at load without env. */
async function deps() {
  const [rcIntegrations, { ResellerClubAPI }, { PricingService }, classify, users, { default: Domain }, { default: connectDB }, domains] =
    await Promise.all([
      import("@/lib/integrations/resellerclub"),
      import("@/lib/resellerclub"),
      import("@/lib/pricing-service"),
      import("@/lib/integrations/resellerclub/classify"),
      import("@/lib/services/users"),
      import("@/models/Domain"),
      import("@/lib/mongodb"),
      import("@/lib/services/domains"),
    ]);
  return { rcIntegrations, ResellerClubAPI, PricingService, classify, users, Domain, connectDB, domains };
}
type Deps = Awaited<ReturnType<typeof deps>>;

interface Pricing { costRupees: number | null; customerRupees: number | null; stale: boolean }

/**
 * ResellerClub's 1-year COST (what ANUTECH pays) and customer price for a TLD.
 * Read from the raw price blocks, not `resellerPrice`, because that field falls
 * back to a 2-year figure under a 1-year label; and a stale cache is refused —
 * a cost check against an old price is not a check.
 */
async function readPricing(d: Deps, tld: string): Promise<Pricing> {
  const payload = await d.PricingService.getDomainPricing();
  if (payload.stale) return { costRupees: null, customerRupees: null, stale: true };
  const detail = (await d.PricingService.getTLDPricing([tld]))[tld];
  const one = (block: unknown): number | null => {
    const v = (block as { addnewdomain?: Record<string, string> } | null)?.addnewdomain?.["1"];
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return { costRupees: one(detail?.reseller), customerRupees: one(detail?.customer), stale: false };
}

/** Is the domain already in OUR reseller account, and whose is it? */
async function ownership(d: Deps, domain: string, email: string): Promise<"ours_this_customer" | "ours_other_customer" | "not_ours" | "unknown"> {
  const order = await d.rcIntegrations.getDomainOrderId({ domainName: domain });
  if (order.kind === "not_found") return "not_ours";
  if (order.kind !== "found") return "unknown";
  const [details, customer] = await Promise.all([
    d.rcIntegrations.getDomainDetails({ domainName: domain }),
    d.ResellerClubAPI.getCustomerId(email),
  ]);
  if (details.kind !== "found" || customer.status !== "success" || !customer.customerId) return "unknown";
  const owner = Number((details.details as Record<string, unknown>).customerid);
  return owner === customer.customerId ? "ours_this_customer" : "ours_other_customer";
}

export const registerDomainCommand: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const req = parseRegister(ctx.payload);
  const domain = ctx.subject.trim().toLowerCase();
  if (!isRegistrableName(domain)) {
    throw new Error(`"${ctx.subject}" is not a single registrable domain name, so nothing was registered.`);
  }
  const tld = tldOf(domain);
  const d = await deps();

  // ── 2. Already ours? ──────────────────────────────────────────────────────
  const owned = await ownership(d, domain, req.registrant.email);
  if (owned === "ours_this_customer") {
    // The retry case: it landed before. Done, and nothing more is spent.
    return { result: { ok: true, domain, changed: false, alreadyRegistered: true, note: "Already registered to this customer in our ResellerClub account." } };
  }
  if (owned === "ours_other_customer") {
    throw new Error(`${HOLD_PREFIX} ${domain} is already registered in our ResellerClub account to a different customer. Nothing was registered — check the order by hand.`);
  }
  if (owned === "unknown") {
    throw new Error(`Could not confirm whether ${domain} is already in our ResellerClub account, so nothing was registered. Try again shortly.`);
  }

  // ── 3. Cost and today's usage ─────────────────────────────────────────────
  const pricing = await readPricing(d, tld);
  const usage = await readDailyUsage("domain.register", ctx.commandId, pricing.costRupees ?? 0);
  const caps = capsFromEnv(process.env);
  const spend = decideSpend({ paymentMode: req.paymentMode, costRupees: pricing.costRupees, coverRupees: req.coverRupees, usage, caps, domain });

  if (ctx.mode === "test") {
    const [avail, existingUser] = await Promise.all([
      d.ResellerClubAPI.searchDomainWithTlds(domain.slice(0, domain.indexOf(".")), [tld]),
      d.users.getUserByEmail(req.registrant.email),
    ]);
    const hit = avail.find((a) => a.domainName.toLowerCase() === domain);
    return {
      result: {
        ok: true,
        domain,
        dryRun: true,
        changed: false,
        available: hit ? hit.available : null,
        costRupees: pricing.costRupees,
        pricingStale: pricing.stale,
        usage,
        caps,
        wouldRegister: spend.ok && hit?.available === true,
        hold: spend.ok ? null : spend.hold,
        dmsAccount: existingUser ? "exists" : "would_be_created",
        note: "Test mode: everything above was READ and nothing was written or registered.",
      },
    };
  }

  // ── 4. Spend decision — a hold stops here, before any write ───────────────
  if (!spend.ok) throw new Error(spend.hold);

  // ── 5. DMS account + ResellerClub customer/contact (found or created) ─────
  const { user, created } = await ensureDmsUser(req.registrant);
  const rc = await d.ResellerClubAPI.getOrCreateCustomerAndContact({
    email: req.registrant.email,
    firstName: req.registrant.firstName,
    lastName: req.registrant.lastName,
    phone: req.registrant.phone,
    phoneCc: req.registrant.phoneCc,
    companyName: req.registrant.companyName,
    address: req.registrant.address,
  });
  if (rc.status !== "success" || !rc.customerId || !rc.contactId) {
    throw new Error(`ResellerClub would not create the owner record for ${domain} (${rc.error ?? "no reason given"}). Nothing was registered.`);
  }

  // ── 6. REGISTER — the irreversible call ───────────────────────────────────
  const raw = await attemptProviderWrite(() =>
    d.ResellerClubAPI.registerDomain({
      domainName: domain,
      years: 1,
      customerId: rc.customerId as number,
      adminContactId: rc.contactId,
      techContactId: rc.contactId,
      billingContactId: rc.contactId,
    })
  );
  const transport = (raw as { transport?: Transport }).transport;
  if (raw.status === "error" && transport === "sent_unknown") {
    throw brandTransport(new Error(`The registration of ${domain} was sent and no answer came back. It may have gone through — reconcile before anything else touches it.`), "sent_unknown");
  }
  const outcome = d.classify.classifyRegisterDomainResponse(raw);
  let orderId: string | undefined;
  switch (outcome.kind) {
    case "registered":
      orderId = outcome.orderId;
      break;
    case "registered_no_order_id": {
      const o = await d.rcIntegrations.getDomainOrderId({ domainName: domain });
      orderId = o.kind === "found" ? String(o.orderId) : undefined;
      break;
    }
    case "balance_pending":
    case "already_in_progress":
      /* ResellerClub took the order but has not completed it (usually the
         reseller balance). It may still complete, so this is NOT a failure a
         retry may repeat: hold the claim for a person. */
      throw brandTransport(
        new Error(`ResellerClub accepted ${domain} but did not complete it (${outcome.kind === "balance_pending" ? "reseller account balance too low" : "already in progress"}). Top up / check ResellerClub, then reconcile.`),
        "sent_unknown"
      );
    case "hard_failure":
      throw brandTransport(new Error(`ResellerClub refused to register ${domain}: ${outcome.reason}`), transport ?? "responded");
  }

  // ── 7. Record it on the customer's DMS account — never throw past here ────
  let recorded = false;
  try {
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await d.connectDB();
    await d.Domain.create({
      userId: user._id,
      domainName: domain,
      status: "pending",
      price: pricing.customerRupees ?? 0,
      currency: "INR",
      registrationPeriod: 1,
      orderId: `rsos:${req.sourceRef}`,
      resellerClubOrderId: orderId,
      dnsProvider: "resellerclub",
      registeredAt: new Date(),
      expiresAt,
      autoRenew: false,
      next_action_at: d.domains.reminderTriggerFor(expiresAt),
      last_reminder_sent: null,
    });
    recorded = true;
  } catch (err) {
    serverLogger.error(
      `[engine] ${domain} IS REGISTERED (order ${orderId ?? "unknown"}) but the DMS Domain row could not be written — ` +
        `add it to ${req.registrant.email}'s account by hand. Do NOT register it again.`,
      err
    );
  }

  serverLogger.warn(`[engine] REGISTERED ${domain} for ${req.registrant.email} — RC order ${orderId ?? "unknown"}, cost ₹${pricing.costRupees}`);
  return {
    result: {
      ok: true,
      domain,
      changed: true,
      orderId: orderId ?? null,
      costRupees: pricing.costRupees,
      customerId: rc.customerId,
      dmsUserCreated: created,
      recorded,
    },
  };
};

/**
 * Reconciler: is the domain in our reseller account, owned by this customer?
 * A pure read with a definite answer, which is why this command may have one.
 */
export const reconcileRegister: Reconciler = async (ctx): Promise<ReconcileVerdict> => {
  let req: RegisterRequest;
  try {
    req = parseRegister(ctx.request);
  } catch {
    return "unknown";
  }
  const d = await deps();
  const owned = await ownership(d, ctx.subject.trim().toLowerCase(), req.registrant.email);
  if (owned === "ours_this_customer") return "done";
  if (owned === "not_ours") return "not_done";
  // Registered to someone else, or unreadable: a person decides.
  return "unknown";
};
