/**
 * `hosting.provision` — create a paid customer's hosting account on DirectAdmin.
 *
 * Owner decision, 24 Sep 2026: hosting bought on ResellerOS is provisioned by
 * THIS engine (DMS stays the only app that writes to DirectAdmin), into a DMS
 * account for the buyer, so the customer manages it from their DMS panel by SSO.
 *
 * ─── WHAT UNBLOCKED IT ───────────────────────────────────────────────────────
 * It was blocked because DMS's createUser sets a password it never returns: its
 * customers reach DirectAdmin by SSO from the DMS panel, so an account for a
 * buyer with no DMS user had no way in. Decision 23 (create the DMS account)
 * removes exactly that: the account is created or found first, the Hosting row
 * is attached to it, and SSO works from the panel.
 *
 * ─── RETRIES CANNOT CREATE A SECOND ACCOUNT ─────────────────────────────────
 * DMS's other provisioners pick a RANDOM username per attempt. Here a lost
 * response followed by a retry would then create a second account under a new
 * name. So candidates are DETERMINISTIC per domain (`daUsernameFor(domain, i)`)
 * and, before creating one, DirectAdmin is asked whether it already exists:
 *   exists, for this domain     → the earlier attempt landed: adopt it, done;
 *   exists, for another domain  → a genuine collision: try the next candidate;
 *   does not exist              → create it (the one irreversible-ish call).
 * The reconciler asks the same question.
 *
 * Live only behind its own gate, `ENGINE_HOSTING_PROVISION_LIVE=1`.
 */
import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";
import { attemptProviderWrite, brandTransport } from "./engine-attempt";
import { HOLD_PREFIX, isRegistrableName } from "./engine-register-policy";
import { ensureDmsUser, parseCustomer, type EngineCustomer } from "./engine-customer";

export const USERNAME_CANDIDATES = 3;

/**
 * DirectAdmin username for a domain, attempt `i`. Same shape as DMS's existing
 * usernames (5 letters from the domain + 5 hex = 10, DirectAdmin's default
 * limit) — but derived from the domain instead of random, so every retry asks
 * about the same account.
 */
export function daUsernameFor(domain: string, i: number): string {
  const prefix = domain.replace(/[^a-z0-9]/gi, "").toLowerCase().replace(/^[0-9]+/, "").slice(0, 5) || "user";
  const hex = crypto.createHash("sha256").update(`${domain.toLowerCase()}:${i}`).digest("hex").slice(0, 5);
  return `${prefix}${hex}`;
}

export interface ProvisionRequest {
  planId: string;
  months: 1 | 12;
  customer: EngineCustomer;
  paymentMode: "live" | "test";
  sourceRef: string;
}

export function parseProvision(payload: Record<string, unknown>): ProvisionRequest {
  const planId = typeof payload.planId === "string" ? payload.planId.trim() : "";
  if (!planId) throw new Error(`"planId" is required — the hosting plan to create (starter / standard / plus).`);
  const months = Number(payload.months);
  if (months !== 1 && months !== 12) throw new Error(`"months" must be 1 or 12. Received ${JSON.stringify(payload.months)}.`);
  const paymentMode = payload.paymentMode;
  if (paymentMode !== "live" && paymentMode !== "test") throw new Error(`"paymentMode" must be "live" or "test".`);
  const sourceRef = typeof payload.sourceRef === "string" ? payload.sourceRef.trim().slice(0, 80) : "";
  if (!sourceRef) throw new Error(`"sourceRef" (the paying side's order reference) is required.`);
  return { planId, months, customer: parseCustomer(payload.customer), paymentMode, sourceRef };
}

async function deps() {
  const [da, { DirectAdminService, DA_SERVER_IP }, plans, { default: Hosting }, { default: connectDB }, users, classify] = await Promise.all([
    import("@/lib/integrations/directadmin"),
    import("@/lib/directadmin"),
    import("@/lib/services/hosting-plans"),
    import("@/models/Hosting"),
    import("@/lib/mongodb"),
    import("@/lib/services/users"),
    import("@/lib/integrations/directadmin/classify"),
  ]);
  return { da, DirectAdminService, DA_SERVER_IP, plans, Hosting, connectDB, users, classify };
}
type Deps = Awaited<ReturnType<typeof deps>>;

type Slot =
  | { kind: "adopt"; username: string }
  | { kind: "create"; username: string }
  | { kind: "exhausted" }
  | { kind: "unknown"; reason: string };

/** Which candidate username this domain uses — READS only. */
async function findSlot(d: Deps, domain: string): Promise<Slot> {
  for (let i = 0; i < USERNAME_CANDIDATES; i++) {
    const username = daUsernameFor(domain, i);
    const cfg = await d.da.getUserConfig({ username });
    if (cfg.kind === "user_not_found") return { kind: "create", username };
    if (cfg.kind !== "found") return { kind: "unknown", reason: cfg.reason };
    const onDomain = String(cfg.config.domain ?? "").toLowerCase();
    if (onDomain === domain) return { kind: "adopt", username };
    // Someone else's account under this name: try the next deterministic one.
  }
  return { kind: "exhausted" };
}

export const provisionHostingCommand: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const req = parseProvision(ctx.payload);
  const domain = ctx.subject.trim().toLowerCase();
  if (!isRegistrableName(domain)) throw new Error(`"${ctx.subject}" is not a single domain name, so no account was created.`);

  const d = await deps();
  await d.connectDB();

  // The package comes from the catalogue, never the caller (same rule as change_plan).
  const plan = await d.plans.getPlanByPlanId(req.planId, { activeOnly: true });
  const pkg = (plan as { directAdminPackage?: string } | null)?.directAdminPackage || plan?.planId;
  if (!plan || !pkg) {
    throw new Error(`${HOLD_PREFIX} the hosting plan "${req.planId}" is not an active plan in DMS, so no account was created. Check the plan catalogue.`);
  }

  // Already done for this customer? (the retry case, and the cheapest check)
  const existingUser = await d.users.getUserByEmail(req.customer.email);
  if (existingUser) {
    const row = await d.Hosting.findOne({ userId: existingUser._id, domainName: domain });
    if (row?.directAdminUsername) {
      return { result: { ok: true, domain, changed: false, alreadyProvisioned: true, daUsername: row.directAdminUsername, hostingId: String(row._id) } };
    }
  }

  const slot = await findSlot(d, domain);
  if (slot.kind === "unknown") {
    throw new Error(`Could not ask DirectAdmin whether ${domain} already has an account (${slot.reason}), so nothing was created. Try again shortly.`);
  }
  if (slot.kind === "exhausted") {
    throw new Error(`${HOLD_PREFIX} all ${USERNAME_CANDIDATES} DirectAdmin usernames for ${domain} belong to other domains. Create this account by hand.`);
  }

  if (ctx.mode === "test") {
    return {
      result: {
        ok: true, domain, dryRun: true, changed: false,
        package: pkg, planName: plan.name, daUsername: slot.username,
        action: slot.kind === "adopt" ? "would_adopt_existing_account" : "would_create_account",
        dmsAccount: existingUser ? "exists" : "would_be_created",
        wouldProvision: req.paymentMode === "live",
        hold: req.paymentMode === "live" ? null : `${HOLD_PREFIX} test-mode payment`,
        note: "Test mode: DirectAdmin and DMS were READ and nothing was created.",
      },
    };
  }

  // Invariant 10: a test-mode payment never reaches a live command.
  if (req.paymentMode !== "live") {
    throw new Error(`${HOLD_PREFIX} ${domain} was paid through a TEST-mode Razorpay key, so no money settled. No account is created automatically at any setting.`);
  }

  // ── The customer's DMS account, and the Hosting row it owns ───────────────
  const { user, created } = await ensureDmsUser(req.customer);
  const now = new Date();
  const expiryDate = new Date(now);
  expiryDate.setMonth(expiryDate.getMonth() + req.months);
  let hosting = await d.Hosting.findOne({ userId: user._id, domainName: domain });
  if (!hosting) {
    hosting = await d.Hosting.create({
      userId: user._id,
      domainName: domain,
      planId: plan.planId,
      name: plan.name,
      serverPackage: pkg,
      status: "pending",
      startDate: now,
      expiryDate,
      orderId: `rsos:${req.sourceRef}`,
      paymentId: `rsos:${req.sourceRef}`,
      billingType: "manual",
    });
  }

  // ── DirectAdmin: adopt what an earlier attempt made, or create it ─────────
  if (slot.kind === "create") {
    try {
      await attemptProviderWrite(() =>
        d.DirectAdminService.createUser(slot.username, user.email, domain, pkg, d.DA_SERVER_IP)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;
      const kind = d.classify.classifyCreateUserError(message, status).kind;
      if (kind === "collision") {
        // Taken between our read and our write — nothing of OURS was created.
        throw brandTransport(new Error(`${HOLD_PREFIX} the DirectAdmin username for ${domain} was taken a moment ago by another account. Run again, or create it by hand.`), "responded");
      }
      // Branded by attemptProviderWrite (sent_unknown for a lost response) — re-throw as is.
      hosting.lastProvisionError = message.slice(0, 500);
      hosting.lastProvisionErrorAt = new Date();
      hosting.lastProvisionOutcome = kind === "unreachable" ? "da_unreachable" : "hard_failure";
      await hosting.save().catch(() => {});
      throw err;
    }
  }

  hosting.directAdminUsername = slot.username;
  hosting.status = "active";
  hosting.lastProvisionError = undefined;
  hosting.lastProvisionErrorAt = undefined;
  hosting.lastProvisionOutcome = undefined;
  let recorded = true;
  try {
    await hosting.save();
    if (!user.directAdminUsername) await d.users.setUserDirectAdminUsername(String(user._id), slot.username);
  } catch (err) {
    recorded = false;
    serverLogger.error(
      `[engine] ${domain} HAS a DirectAdmin account (${slot.username}) but the DMS Hosting row could not be marked active — fix it by hand. Do NOT create it again.`,
      err
    );
  }

  serverLogger.warn(`[engine] PROVISIONED hosting ${domain} as ${slot.username} (${pkg}) for ${user.email}`);
  return {
    result: {
      ok: true, domain, changed: slot.kind === "create", adopted: slot.kind === "adopt",
      daUsername: slot.username, package: pkg, hostingId: String(hosting._id),
      dmsUserCreated: created, recorded,
    },
  };
};

/** Reconciler: does a DirectAdmin account for this domain exist under one of its usernames? */
export const reconcileProvision: Reconciler = async (ctx): Promise<ReconcileVerdict> => {
  const domain = ctx.subject.trim().toLowerCase();
  const d = await deps();
  const slot = await findSlot(d, domain);
  if (slot.kind === "adopt") return "done";
  if (slot.kind === "create") return "not_done";
  return "unknown";
};
