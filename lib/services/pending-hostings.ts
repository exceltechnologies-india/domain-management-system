/**
 * PendingHosting service.
 *
 * Companion to lib/services/pending-domains.ts — PendingHosting tracks the
 * half-state between "checkout completed for a hosting plan" and "DirectAdmin
 * user is live". Rows are written when the provisioner trips, and admin tools
 * read / retry / delete them.
 *
 * The bulk-delete and cron-sweep call sites are kept here even though they're
 * one-offs — they share the model import surface with the rest, and
 * centralising them is the whole point of the service layer.
 */
import connectDB from "@/lib/mongodb";
import PendingHosting from "@/models/PendingHosting";
import type { IPendingHosting } from "@/models/PendingHosting";

interface CreatePendingHostingInput {
  userId: unknown;
  domain: string;
  package: string;
  daUsername: string;
  error: string;
  status?: "failed" | "pending";
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Look up a single pending-hosting by `_id`. Returns the hydrated Mongoose
 * doc (callers in the retry flow mutate + `.save()` the `error` field).
 */
export async function getPendingHostingById(
  id: string
): Promise<IPendingHosting | null> {
  await connectDB();
  return PendingHosting.findById(id);
}

/**
 * Admin pending-hostings index — every row, owning-user populated with the
 * `name`/`email` admin tables expect, newest-first.
 */
export async function listPendingHostingsForAdmin(): Promise<IPendingHosting[]> {
  await connectDB();
  return PendingHosting.find({})
    .populate("userId", "name email")
    .sort({ createdAt: -1 });
}

/**
 * Counts by status — used by the system-health and ops dashboards.
 */
export async function countPendingHostingsByStatus(
  status: "failed" | "pending"
): Promise<number> {
  await connectDB();
  return PendingHosting.countDocuments({ status });
}

/**
 * Cron-sweeper read: stuck rows older than `cutoff`. Lean projection of the
 * fields the alerting flow needs — domain, status, createdAt, error, userId.
 */
export async function listStuckPendingHostings(
  cutoff: Date
): Promise<
  Array<{
    _id: unknown;
    domain: string;
    status: string;
    createdAt: Date;
    error?: string;
    userId: unknown;
  }>
> {
  await connectDB();
  return PendingHosting.find({
    status: { $in: ["pending", "failed"] },
    createdAt: { $lt: cutoff },
  })
    .select("domain status createdAt error userId")
    .lean<
      Array<{
        _id: unknown;
        domain: string;
        status: string;
        createdAt: Date;
        error?: string;
        userId: unknown;
      }>
    >();
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Persist a failed/pending hosting provision so the admin retry flow can
 * pick it up. Used by the post-payment provisioner and the admin manual-
 * provision route when DirectAdmin returns an error.
 */
export async function createPendingHosting(
  input: CreatePendingHostingInput
): Promise<IPendingHosting> {
  await connectDB();
  return PendingHosting.create({
    userId: input.userId,
    domain: input.domain,
    package: input.package,
    daUsername: input.daUsername,
    error: input.error,
    status: input.status ?? "failed",
  });
}

/**
 * Delete by `_id`. Used by admin "dismiss" + the retry flow on success.
 * Returns the deleted document, or null if not found.
 */
export async function deletePendingHostingById(
  id: string
): Promise<IPendingHosting | null> {
  await connectDB();
  return PendingHosting.findByIdAndDelete(id);
}

/**
 * Bulk delete by DA username — used when an admin permanently removes a
 * hosting account and wants to clear the matching pending-row at the same
 * time. Matches on either `username` (legacy field) or `daUsername`.
 */
export async function deletePendingHostingsByUsername(
  username: string
): Promise<number> {
  await connectDB();
  const result = await PendingHosting.deleteMany({
    $or: [{ username }, { daUsername: username }],
  });
  return result.deletedCount ?? 0;
}

/**
 * Auto-retry-eligible rows: `status: "pending"` indicates a deferred
 * provision (typically DA was unreachable at checkout-time, so the
 * provisioner soft-failed via the path added 2026-05-19). The
 * check-unprovisioned cron drains these via {@link provisionPendingHosting}
 * once DA connectivity is restored. `status: "failed"` rows stay manual —
 * they were rejected by DA for a logical reason (duplicate user, bad
 * package, etc.) and need an admin to inspect.
 */
export async function listDeferredPendingHostings(): Promise<IPendingHosting[]> {
  await connectDB();
  return PendingHosting.find({ status: "pending" })
    .sort({ createdAt: 1 })
    .limit(50); // cap per-cron-tick to keep DA load + cron runtime predictable
}

/**
 * Result of a single retry attempt. The cron aggregates these to report
 * per-tick stats.
 */
export interface PendingHostingRetryResult {
  domain: string;
  ok: boolean;
  error?: string;
  /** True when the entry was dropped (user already has hosting, etc.) */
  dropped?: boolean;
}

/**
 * Re-attempt the deferred provision for a single PendingHosting row.
 *
 * Shared by the admin "Retry" button and the auto-retry cron. The full
 * 6-step provisioning flow lives here so both call sites stay in sync:
 *   1. Resolve user; if already provisioned elsewhere, drop the row.
 *   2. DA `createUser` (the actual retry — fails the whole call when DA is
 *      still unreachable or returns a real error).
 *   3. Best-effort DA `updateDNSNameservers` to the ResellerClub nameservers.
 *   4. Stamp the user's `directAdminUsername` + `hostingCreatedAt` /
 *      `hostingExpiresAt`.
 *   5. Create the `Hosting` row that the post-payment provisioner would
 *      normally have written.
 *   6. Delete the PendingHosting row + send the "your hosting is live" email.
 *
 * On failure the function returns `{ ok: false, error }` and bumps the
 * PendingHosting row's `error` field so the next sweep / admin view shows
 * the latest reason.
 */
export async function provisionPendingHosting(
  pending: IPendingHosting
): Promise<PendingHostingRetryResult> {
  await connectDB();
  const { domain, package: packageName, daUsername, userId } = pending;

  // Imports are local to keep this service's load-time dependency on
  // DA / mail / Hosting model out of cold-start when callers only want
  // the lighter read/write helpers above.
  const { getUserById } = await import("@/lib/services/users");
  const { DirectAdminService } = await import("@/lib/directadmin");
  const { EmailService } = await import("@/lib/email");
  const { serverLogger } = await import("@/lib/server-logger");
  const Hosting = (await import("@/models/Hosting")).default;

  const user = await getUserById(String(userId));
  if (!user) {
    return { domain, ok: false, error: "User not found" };
  }

  if (user.directAdminUsername) {
    // User already has hosting (manually provisioned or via a sibling
    // PendingHosting row picked up earlier). Drop this row — keeping it
    // would block future retries from the same sweep and cause a misleading
    // "ALREADY_HAS_HOSTING" admin-side error.
    await PendingHosting.findByIdAndDelete(pending._id);
    return { domain, ok: true, dropped: true };
  }

  try {
    await DirectAdminService.createUser(daUsername, user.email, domain, packageName);
  } catch (daError: unknown) {
    const daMessage = daError instanceof Error ? daError.message : "DA retry failed";
    pending.error = daMessage;
    await pending.save();
    return { domain, ok: false, error: daMessage };
  }

  // DNS nameservers (best-effort — log but don't fail the whole retry)
  try {
    await DirectAdminService.updateDNSNameservers(
      daUsername,
      domain,
      DirectAdminService.NAMESERVERS
    );
  } catch (dnsError: unknown) {
    const dnsMessage = dnsError instanceof Error ? dnsError.message : String(dnsError);
    serverLogger.warn(`[PendingHostingRetry] DNS update failed for ${domain}: ${dnsMessage}`);
  }

  // Stamp user
  user.directAdminUsername = daUsername;
  user.hostingCreatedAt = new Date();
  user.hostingExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await user.save();

  // Create the Hosting row (the post-payment provisioner would have done this).
  const startDate = new Date();
  const expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  try {
    await Hosting.create({
      userId,
      domainName: domain,
      planId: packageName,
      name: packageName,
      serverPackage: packageName,
      status: "active",
      startDate,
      expiryDate,
      next_action_at: new Date(expiryDate.getTime() - 15 * 24 * 60 * 60 * 1000),
      directAdminUsername: daUsername,
      orderId: `retry_${Date.now()}`,
      autoRenew: false,
      billingType: "manual",
      isTrial: false,
      nameservers: DirectAdminService.NAMESERVERS,
    });
  } catch (hostingErr: unknown) {
    const hostingMessage = hostingErr instanceof Error ? hostingErr.message : String(hostingErr);
    serverLogger.error(`[PendingHostingRetry] Hosting record creation failed for ${domain}: ${hostingMessage}`);
    // Don't fail the whole retry — DA account exists, user fields are set.
  }

  // Done — drop the PendingHosting row + notify the user.
  await PendingHosting.findByIdAndDelete(pending._id);

  try {
    await EmailService.sendHostingProvisionedEmail(
      user.email,
      user.firstName || "User",
      {
        domainName: domain,
        packageName,
        serverIp: process.env.DIRECTADMIN_IP || "136.115.64.54",
        nameservers: DirectAdminService.NAMESERVERS,
      }
    );
  } catch (emailError: unknown) {
    const emailMessage = emailError instanceof Error ? emailError.message : String(emailError);
    serverLogger.warn(`[PendingHostingRetry] Notification email failed for ${user.email}: ${emailMessage}`);
  }

  return { domain, ok: true };
}
