/**
 * Tokens-flow DirectAdmin provisioning cron service (Phase 2E).
 *
 * After Phase 2C creates a Hosting row in `status='pending'` with an
 * empty `directAdminUsername`, this module's cron picks it up and
 * creates the actual DA user account. On success the Hosting flips
 * to `status='active'` and the customer's trial is usable.
 *
 * This intentionally does NOT share code with the existing
 * `provisioner-hosting.ts` — that function operates on a cart item
 * inside the verify/webhook orchestration path with its own state.
 * Phase 2E operates on a Hosting record loaded from MongoDB by the
 * cron. Sharing helpers would require extracting them from the
 * existing function's tight-coupling to the orchestrator; for ~80
 * lines of duplication, that's not worth the refactor surface.
 *
 * Architecture (matches docs/razorpay-tokens-migration.md §3.4 + §3.5):
 *  1. Cron calls `findPendingTokensFlowHostings()` — Hostings whose
 *     status='pending' AND razorpayTokenId is set (= Tokens-flow
 *     trial) AND directAdminUsername is empty (= DA not yet
 *     provisioned).
 *  2. For each, calls `provisionTokensFlowHosting()`:
 *     - Looks up the user
 *     - Generates 3 username candidates from the domain
 *     - Calls `createUser` (the DA helper)
 *     - On 'created': sets Hosting.directAdminUsername + flips
 *       status='active'; sets User.directAdminUsername if not set;
 *       sends welcome email (fire-and-forget; logged but doesn't
 *       block status flip)
 *     - On 'da_unreachable' / 'username_collision_exhausted' /
 *       'hard_failure': leaves status='pending'; logs; returns the
 *       outcome so the cron can summarize
 *
 * NOT in scope here (Phase 2F+):
 *  - DA suspend on abandoned MIT attempts
 *  - PendingHosting fallback (the existing provisioner uses
 *    PendingHosting for failed DA creates; this cron just leaves
 *    status='pending' and retries next run — simpler)
 */
import crypto from "crypto";
import type { HydratedDocument } from "mongoose";
import Hosting, { type IHosting } from "@/models/Hosting";
import { DirectAdminService, DA_SERVER_IP } from "@/lib/directadmin";
import { createUser as daCreateUser } from "@/lib/integrations/directadmin";
import { EmailService } from "@/lib/email";
import { getUserById, setUserDirectAdminUsername } from "@/lib/services/users";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";

const MAX_USERNAME_ATTEMPTS = 3;

export interface ProvisionResult {
  hostingId: string;
  domainName: string;
  outcome: "activated" | "skipped" | "da_unreachable" | "collision_exhausted" | "hard_failure";
  daUsername?: string;
  reason?: string;
}

/** Short, unique-enough DA username from the domain prefix. */
function generateDaUsername(domainPrefix: string): string {
  const prefix = domainPrefix.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 5) || "user";
  const suffix = crypto.randomBytes(4).toString("hex").slice(0, 5);
  return `${prefix}${suffix}`;
}

/**
 * Find Hostings whose DA account hasn't been created yet. Flow-agnostic:
 * picks up Tokens-flow AND Manual-flow trials (both share the same
 * `status='pending' + directAdminUsername=empty` shape at DA-await
 * time). The `razorpayTokenId` filter that used to be here was removed
 * on 2026-07-02 when Manual-flow trials became a first-class signup
 * path — Manual-flow Hostings have no razorpayTokenId so the old
 * filter caused them to be silently ignored by the cron, leaving them
 * in `status='pending'` forever. See TASKS.md
 * MANUAL-FLOW-TRIAL-VERIFIED-END-TO-END → Gap B for the incident.
 *
 * Name kept as `findPendingTokensFlowHostings` to avoid an import-site
 * churn across the cron script + tests; the docstring is the source of
 * truth for behavior. A future refactor can rename to
 * `findPendingHostingsAwaitingDa` once the ecosystem cleanup value
 * outweighs the diff-size cost.
 */
export async function findPendingTokensFlowHostings(opts: {
  limit?: number;
} = {}): Promise<HydratedDocument<IHosting>[]> {
  // Establish the Mongoose connection before firing the query. Without
  // this, HTTP-worker invocations against a cold Cloud Run instance
  // (Cloud Scheduler wakes the container from zero) hit
  // `MongooseError: Operation hostings.find() buffering timed out
  // after 10000ms` because Mongoose buffers queries while waiting for
  // a connection that the caller never established. The CLI cron
  // establishes the connection in its `main()`; the HTTP worker did
  // not — and this service module used to assume the caller had done
  // it. Adding `connectDB()` here fixes both paths (idempotent, so no
  // harm when the CLI has already connected).
  await connectDB();
  return Hosting.find({
    status: "pending",
    $or: [
      { directAdminUsername: "" },
      { directAdminUsername: { $exists: false } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(opts.limit ?? 100)
    .exec();
}

/**
 * Create the DA user for one Hosting. Idempotent in practice: if the
 * Hosting's `directAdminUsername` is already non-empty (a concurrent
 * cron run already provisioned it), early-return 'skipped'.
 */
export async function provisionTokensFlowHosting(
  hosting: HydratedDocument<IHosting>
): Promise<ProvisionResult> {
  // Defensive — same reason as findPendingTokensFlowHostings.
  // provisionTokensFlowHosting is often called after the finder (which
  // now establishes the connection), but the one-off script
  // scripts/provision-one-hosting.js loads a Hosting doc directly via
  // Hosting.findById and could call this function on a cold container.
  // connectDB is idempotent, so pairing it here is free insurance.
  await connectDB();
  const hostingId = String(hosting._id);
  const baseResult: Pick<ProvisionResult, "hostingId" | "domainName"> = {
    hostingId,
    domainName: hosting.domainName,
  };

  if (hosting.directAdminUsername) {
    return {
      ...baseResult,
      outcome: "skipped",
      reason: `already has directAdminUsername=${hosting.directAdminUsername}`,
    };
  }

  // Load the user (for the email + directAdminUsername sync)
  const user = await getUserById(String(hosting.userId));
  if (!user) {
    return {
      ...baseResult,
      outcome: "hard_failure",
      reason: `user ${hosting.userId} not found`,
    };
  }

  const packageName = hosting.serverPackage || hosting.planId;
  const usernameCandidates = Array.from({ length: MAX_USERNAME_ATTEMPTS }, () =>
    generateDaUsername(hosting.domainName)
  );

  serverLogger.info(
    `🔄 [TOKENS-DA-PROVISIONER] Creating DA user for ${hosting.domainName} (package=${packageName}, ip=${DA_SERVER_IP}, candidates=${usernameCandidates.join(",")})`
  );

  const daOutcome = await daCreateUser({
    email: user.email,
    domain: hosting.domainName,
    packageName,
    ip: DA_SERVER_IP,
    usernameCandidates,
  });

  if (daOutcome.kind === "username_collision_exhausted") {
    serverLogger.error(
      `❌ [TOKENS-DA-PROVISIONER] Username collisions exhausted for ${hosting.domainName} after ${MAX_USERNAME_ATTEMPTS} attempts`
    );
    return {
      ...baseResult,
      outcome: "collision_exhausted",
      reason: `${MAX_USERNAME_ATTEMPTS} collisions in a row`,
    };
  }
  if (daOutcome.kind === "da_unreachable") {
    serverLogger.warn(
      `⚠️ [TOKENS-DA-PROVISIONER] DA unreachable for ${hosting.domainName}: ${daOutcome.reason} — leaving Hosting status='pending' for next cron run`
    );
    return {
      ...baseResult,
      outcome: "da_unreachable",
      reason: daOutcome.reason,
    };
  }
  if (daOutcome.kind === "hard_failure") {
    serverLogger.error(
      `❌ [TOKENS-DA-PROVISIONER] Hard failure for ${hosting.domainName}: ${daOutcome.reason}`
    );
    return {
      ...baseResult,
      outcome: "hard_failure",
      reason: daOutcome.reason,
    };
  }

  // Success: persist
  const daUsername = daOutcome.username;
  hosting.directAdminUsername = daUsername;
  hosting.status = "active";
  await hosting.save();

  // Mirror onto User if not already set
  if (!user.directAdminUsername) {
    try {
      await setUserDirectAdminUsername(String(user._id), daUsername);
    } catch (e) {
      serverLogger.warn(
        `[TOKENS-DA-PROVISIONER] Failed to mirror directAdminUsername onto User ${user._id}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // Welcome email — fire and forget; failure must NOT block the status flip
  let planName = packageName;
  try {
    const plan = await getPlanByPlanId(hosting.planId);
    if (plan?.name) planName = plan.name;
  } catch (e) {
    serverLogger.warn(
      `[TOKENS-DA-PROVISIONER] Could not look up plan name for email: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  // Derive the welcome-email mandateMode from the Hosting record so
  // Manual-flow trials get the "manual day-15 payment reminder" tone +
  // Tokens-flow trials get the "hard 1-attempt suspension policy" tone.
  // Was previously hardcoded to 'tokens'; that gave Manual-flow customers
  // messaging that didn't match their signup path (they'll never
  // experience an MIT charge). Signal precedence: razorpayTokenId set
  // → Tokens flow; else billingType='manual' → Manual flow; else fall
  // back to 'subscriptions' for legacy pre-Tokens signups.
  const emailMandateMode: "tokens" | "manual" | "subscriptions" = hosting.razorpayTokenId
    ? "tokens"
    : hosting.billingType === "manual"
      ? "manual"
      : "subscriptions";
  try {
    await EmailService.sendHostingProvisionedEmail(
      user.email,
      user.firstName || "User",
      {
        domainName: hosting.domainName,
        packageName,
        planName,
        serverIp: DA_SERVER_IP,
        nameservers: DirectAdminService.NAMESERVERS,
        mandateMode: emailMandateMode,
        // Trial signals — pipe hosting.isTrial + expiryDate through so
        // the email template can render trial-specific copy (header
        // gradient, banner, day-15 explainer, CTA text) instead of the
        // generic "provisioned" language. Both fields already live on
        // the Hosting record from createManualFlowTrialHosting +
        // createTokensFlowTrialHosting, so no schema change needed.
        isTrial: hosting.isTrial === true,
        trialEndsAt: hosting.expiryDate,
      }
    );
    serverLogger.info(
      `✉️ [TOKENS-DA-PROVISIONER] Welcome email sent to ${user.email} for ${hosting.domainName}`
    );
  } catch (emailErr) {
    const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
    serverLogger.error(
      `❌ [TOKENS-DA-PROVISIONER] Welcome email failed for ${user.email} / ${hosting.domainName}: ${msg}`
    );
  }

  // WhatsApp welcome — alongside the email, when the customer has a
  // WhatsApp number on file + hasn't opted out. Self-gating (no-op when
  // WhatsApp disabled/unconfigured) + best-effort: a failure never blocks
  // the status flip. Uses the "hosting provisioned" template.
  try {
    if (user.whatsappNumber && user.whatsappOptOut !== true) {
      const { WhatsAppService } = await import("@/lib/whatsapp");
      await WhatsAppService.sendServiceProvisioned(user.whatsappNumber, {
        domainName: hosting.domainName,
        planName,
      });
    }
  } catch (waErr) {
    serverLogger.warn(
      `[TOKENS-DA-PROVISIONER] Welcome WhatsApp failed for ${hosting.domainName}: ${waErr instanceof Error ? waErr.message : String(waErr)}`
    );
  }

  serverLogger.info(
    `✅ [TOKENS-DA-PROVISIONER] Provisioned ${hosting.domainName}: daUsername=${daUsername} status=active`
  );
  return {
    ...baseResult,
    outcome: "activated",
    daUsername,
  };
}
