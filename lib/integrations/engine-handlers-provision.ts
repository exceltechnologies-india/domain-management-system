/**
 * `hosting.provision` — create a customer's hosting account on DirectAdmin: a paid sale, or a free Starter trial.
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
 *
 * ─── A FREE TRIAL IS THE SAME COMMAND (25 Sep 2026) ──────────────────────────
 * ResellerOS's hosting trial used to create its DirectAdmin account itself — a
 * second DirectAdmin writer. It now sends this command with `trial: true`, so
 * this engine stays the only writer. A trial is kept apart from a sale on
 * every axis a mistake could cross:
 *   - `trial: true` and `paymentMode: "trial"` come TOGETHER or not at all. A
 *     paid provision cannot claim to be a trial, and a trial is never read as a
 *     live payment (it never reaches the invariant-10 branch below).
 *   - Starter only (`isTrialPlan`, the owner's rule), refused before any read.
 *   - One trial per customer across both apps (`findPriorTrial` on email, phone
 *     and domain). An unreadable history refuses: an unanswered question is not
 *     "no earlier trial". The trial being provisioned is excluded by its exact
 *     ids — `trialRef` (ResellerOS's ExternalTrial.ref) and this command's own
 *     Hosting row — so it does not block itself on a first run or on a retry.
 *   - The row says what it is: `isTrial`, 15 days, `billingType: "manual"`,
 *     `autoRenew: false`, the first reminder 2 days before expiry (the same
 *     shape the (since deleted, 26 Sep 2026) manual-trial-provisioner wrote), and
 *     `orderId`/`paymentId` = `rsos-trial:<sourceRef>`. No money moved, so no
 *     Order is written — as for a paid provision, which writes none either.
 * Username choice, read-before-write adoption, the DMS account and its
 * set-your-password email, and the reconciler are exactly the paid path's.
 */
import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";
import { attemptProviderWrite, brandTransport } from "./engine-attempt";
import { HOLD_PREFIX, isRegistrableName } from "./engine-register-policy";
import { ensureDmsUser, parseCustomer, type EngineCustomer } from "./engine-customer";
import { isTrialPlan, TRIAL_PLAN_ID } from "@/lib/pricing/trial-plan";
import { alreadyTrialledMessage, findPriorTrial, type PriorTrial } from "@/lib/trials/trial-history";

/** Same as the former DMS manual-flow trial (deleted 26 Sep 2026: the panel trial now starts in ResellerOS). */
export const TRIAL_DAYS = 15;
export const TRIAL_FIRST_REMINDER_LEAD_DAYS = 2;

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

interface ProvisionBase {
  planId: string;
  customer: EngineCustomer;
  sourceRef: string;
}

export interface PaidProvisionRequest extends ProvisionBase {
  trial: false;
  months: 1 | 12;
  paymentMode: "live" | "test";
}

export interface TrialProvisionRequest extends ProvisionBase {
  trial: true;
  paymentMode: "trial";
  /** What the trial converts to at the end (Hosting.billingCycle). */
  cycle: "monthly" | "yearly";
  /** ResellerOS's ExternalTrial.ref for this same trial, so it does not block itself. */
  trialRef: string | null;
}

export type ProvisionRequest = PaidProvisionRequest | TrialProvisionRequest;

/** `rsos-trial:<sourceRef>` for a trial, `rsos:<sourceRef>` for a sale — on orderId and paymentId. */
export function provisionOrderRef(req: ProvisionRequest): string {
  return `${req.trial ? "rsos-trial" : "rsos"}:${req.sourceRef}`;
}

export function parseProvision(payload: Record<string, unknown>): ProvisionRequest {
  const planId = typeof payload.planId === "string" ? payload.planId.trim() : "";
  if (!planId) throw new Error(`"planId" is required — the hosting plan to create (starter / standard / plus).`);

  if (payload.trial !== undefined && typeof payload.trial !== "boolean") {
    throw new Error(`"trial" must be true or false (a JSON boolean). Received ${JSON.stringify(payload.trial)}. Nothing was created.`);
  }
  const trial = payload.trial === true;
  const paymentMode = payload.paymentMode;

  const sourceRef = typeof payload.sourceRef === "string" ? payload.sourceRef.trim().slice(0, 80) : "";
  if (!sourceRef) throw new Error(`"sourceRef" (the paying side's order reference) is required.`);

  if (!trial) {
    if (paymentMode === "trial") {
      throw new Error(
        `"paymentMode": "trial" is only valid with "trial": true. A paid provision cannot be recorded as a free trial. ` +
          `Send "paymentMode": "live" or "test" for a sale, or "trial": true for a Starter trial. Nothing was created.`,
      );
    }
    const months = Number(payload.months);
    if (months !== 1 && months !== 12) throw new Error(`"months" must be 1 or 12. Received ${JSON.stringify(payload.months)}.`);
    if (paymentMode !== "live" && paymentMode !== "test") throw new Error(`"paymentMode" must be "live" or "test".`);
    return { trial: false, planId, months, customer: parseCustomer(payload.customer), paymentMode, sourceRef };
  }

  if (paymentMode !== "trial") {
    throw new Error(
      `A free trial must send "paymentMode": "trial" (received ${JSON.stringify(paymentMode)}). A trial has no payment, ` +
        `so it is never treated as a live or test payment. Nothing was created.`,
    );
  }
  if (!isTrialPlan(planId)) {
    throw new Error(
      `The free trial is only on the Starter plan, and "${planId}" was asked for. Send "planId": "${TRIAL_PLAN_ID}", ` +
        `or provision ${planId} as a paid sale. Nothing was created.`,
    );
  }
  const rawCycle = payload.cycle;
  if (rawCycle !== undefined && rawCycle !== "monthly" && rawCycle !== "yearly") {
    throw new Error(`"cycle" must be "monthly" or "yearly" (what the trial converts to). Received ${JSON.stringify(rawCycle)}. Nothing was created.`);
  }
  if (payload.trialRef !== undefined && typeof payload.trialRef !== "string") {
    throw new Error(`"trialRef" must be a string (the ResellerOS trial record's ref). Nothing was created.`);
  }
  const trialRef = typeof payload.trialRef === "string" ? payload.trialRef.trim().slice(0, 80) || null : null;
  return {
    trial: true,
    planId,
    paymentMode: "trial",
    cycle: rawCycle === "monthly" ? "monthly" : "yearly",
    trialRef,
    customer: parseCustomer(payload.customer),
    sourceRef,
  };
}

/**
 * Refuses when this customer has had a free trial in either app. Throws; never
 * reads a question it could not answer as "no earlier trial".
 */
async function assertNoPriorTrial(req: TrialProvisionRequest, domain: string): Promise<void> {
  let prior: PriorTrial;
  try {
    prior = await findPriorTrial(
      { email: req.customer.email, phone: req.customer.phone, domain },
      { externalRef: req.trialRef ?? undefined, hostingOrderId: provisionOrderRef(req) },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read the free-trial history for ${domain} (${reason.slice(0, 200)}), so no trial account was created — ` +
        `a trial is only started once we know it is this customer's first. Try again shortly.`,
    );
  }
  if (prior.found) {
    throw new Error(`No trial account was created for ${domain}: ${alreadyTrialledMessage(prior)}`);
  }
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

  // One free trial per customer, across both apps — after the retry check above
  // (a finished trial is answered as done, not refused as a second trial).
  if (req.trial) await assertNoPriorTrial(req, domain);

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
        trial: req.trial,
        ...(req.trial ? { cycle: req.cycle, trialDays: TRIAL_DAYS } : {}),
        wouldProvision: req.trial || req.paymentMode === "live",
        hold: req.trial || req.paymentMode === "live" ? null : `${HOLD_PREFIX} test-mode payment`,
        note: "Test mode: DirectAdmin and DMS were READ and nothing was created.",
      },
    };
  }

  // Invariant 10: a test-mode payment never reaches a live command. A trial has
  // no payment at all; parseProvision guarantees its paymentMode is "trial".
  if (!req.trial && req.paymentMode !== "live") {
    throw new Error(`${HOLD_PREFIX} ${domain} was paid through a TEST-mode Razorpay key, so no money settled. No account is created automatically at any setting.`);
  }

  // ── The customer's DMS account, and the Hosting row it owns ───────────────
  const { user, created } = await ensureDmsUser(req.customer);
  const now = new Date();
  const expiryDate = new Date(now);
  if (req.trial) expiryDate.setDate(expiryDate.getDate() + TRIAL_DAYS);
  else expiryDate.setMonth(expiryDate.getMonth() + req.months);
  const orderRef = provisionOrderRef(req);
  let hosting = await d.Hosting.findOne({ userId: user._id, domainName: domain });
  if (!hosting) {
    const reminderAt = new Date(expiryDate);
    reminderAt.setDate(reminderAt.getDate() - TRIAL_FIRST_REMINDER_LEAD_DAYS);
    hosting = await d.Hosting.create({
      userId: user._id,
      domainName: domain,
      planId: plan.planId,
      name: plan.name,
      serverPackage: pkg,
      status: "pending",
      startDate: now,
      expiryDate,
      orderId: orderRef,
      paymentId: orderRef,
      billingType: "manual",
      ...(req.trial
        ? { isTrial: true, billingCycle: req.cycle, autoRenew: false, next_action_at: reminderAt, last_reminder_sent: null }
        : {}),
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

  serverLogger.warn(`[engine] PROVISIONED ${req.trial ? "TRIAL " : ""}hosting ${domain} as ${slot.username} (${pkg}) for ${user.email}`);
  return {
    result: {
      ok: true, domain, changed: slot.kind === "create", adopted: slot.kind === "adopt",
      daUsername: slot.username, package: pkg, hostingId: String(hosting._id),
      dmsUserCreated: created, recorded,
      trial: req.trial,
      ...(req.trial ? { cycle: req.cycle, amount: 0, expiryDate: expiryDate.toISOString() } : {}),
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
