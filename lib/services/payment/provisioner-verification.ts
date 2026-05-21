/**
 * Post-loop verification + PendingDomain materialization. Extracted from
 * the H2 decomposition of `provisionCartItems`.
 *
 * After every cart item has run through its per-item provisioner the
 * orchestrator hands the accumulated orderDomains to this module, which:
 *   1. Calls DomainVerificationService for non-hosting items so we can
 *      catch the "RC said success but the registry still shows available"
 *      case (typical of silently-failed registrations).
 *   2. Walks every orderDomain and collects PendingDomain rows for the
 *      failures + unverified-successes. The orchestrator never mutates
 *      orderDomain.status itself — this module does, then bulk-upserts.
 */
import { DomainVerificationService } from "@/lib/domain-verification";
import { serverLogger } from "@/lib/server-logger";
import Domain from "@/models/Domain";
import PendingDomain from "@/models/PendingDomain";

import type { IUser } from "@/models/User";
import type { OrderDomain } from "./provisioner";

export interface VerificationContext {
  user: IUser;
  orderId: string;
  /** Nameservers the cron / admin retry path uses if it has to re-attempt
   * registration. Currently always `undefined` — we leave it on the input
   * so the contract matches what `PendingDomain` rows historically carried. */
  nameServers?: string[];
  customerResult: { customerId: number; contactId: number };
}

/**
 * Mutates `orderDomains` in place to flip silently-failed "registered" rows
 * back to "pending", then bulk-upserts PendingDomain audit rows for every
 * pending / failed non-hosting item.
 */
export async function runDomainVerificationPhase(
  orderDomains: OrderDomain[],
  ctx: VerificationContext
): Promise<void> {
  serverLogger.info(
    "🔍 [PAYMENT-VERIFY] Starting verification for real domains..."
  );

  const domainsToVerify = orderDomains
    .filter((d) => d.itemType !== "hosting")
    .map((d) => d.domainName);

  const verificationResults =
    domainsToVerify.length > 0
      ? await DomainVerificationService.verifyMultipleDomains(domainsToVerify)
      : [];

  const pendingDomainsToCreate: Record<string, unknown>[] = [];

  // 1. Every failed / pending non-hosting domain becomes a PendingDomain.
  //    "failed" rows were previously invisible to admin — they now show up
  //    in the Pending Domains dashboard with the failure reason.
  for (const orderDomain of orderDomains) {
    if (
      (orderDomain.status === "pending" || orderDomain.status === "failed") &&
      orderDomain.itemType !== "hosting"
    ) {
      serverLogger.info(
        `📝 [PAYMENT-VERIFY] Creating pending domain record (status=${orderDomain.status}) for: ${orderDomain.domainName}`
      );
      pendingDomainsToCreate.push(
        buildPendingDomainPayload(orderDomain, ctx, {
          status: orderDomain.status === "failed" ? "failed" : "pending",
          reason:
            orderDomain.error ||
            (orderDomain.status === "failed"
              ? "Domain registration failed - requires manual processing"
              : "Domain registration pending - requires manual processing"),
          verificationAttempts: 0,
        })
      );
    }
  }

  // 2. For every "registered" row that the verifier flags as still-available,
  //    flip the order row to pending, clean up the optimistic Domain insert,
  //    and queue a PendingDomain row.
  for (const verificationResult of verificationResults) {
    const orderDomain = orderDomains.find(
      (d) =>
        d.domainName === verificationResult.domainName &&
        d.itemType === "domain"
    );

    if (
      orderDomain &&
      orderDomain.status === "registered" &&
      orderDomain.itemType !== "hosting" &&
      DomainVerificationService.isPendingRegistration(verificationResult)
    ) {
      serverLogger.warn(
        `⚠️ [PAYMENT-VERIFY] Domain still available after registration: ${verificationResult.domainName}`
      );

      orderDomain.status = "pending";

      try {
        await Domain.deleteOne({
          domainName: verificationResult.domainName,
          orderId: ctx.orderId,
        });
        serverLogger.info(
          `🧹 [PAYMENT-VERIFY] Cleaned up premature Domain record for: ${verificationResult.domainName}`
        );
      } catch (cleanupError) {
        serverLogger.error(
          `❌ [PAYMENT-VERIFY] Failed to cleanup Domain record for ${verificationResult.domainName}:`,
          cleanupError
        );
      }

      pendingDomainsToCreate.push(
        buildPendingDomainPayload(orderDomain, ctx, {
          status: "pending",
          reason:
            verificationResult.reason ||
            "Domain still available - registration likely failed due to insufficient funds",
          verificationAttempts: 1,
        })
      );
    } else if (
      orderDomain &&
      orderDomain.status === "registered" &&
      verificationResult.registrationStatus === "success"
    ) {
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Domain verification successful: ${verificationResult.domainName}`
      );
    }
  }

  if (pendingDomainsToCreate.length === 0) return;

  serverLogger.info(
    `📝 [PAYMENT-VERIFY] Creating/updating ${pendingDomainsToCreate.length} pending domain records for admin management`
  );
  try {
    // Scope the upsert filter to (domainName, userId). Keying on domainName
    // alone meant a second user failing on the same name would silently
    // overwrite the first user's PendingDomain row — including the
    // `userId` field, which is how the admin dashboard surfaces who owns
    // the failed registration.
    const bulkOps = pendingDomainsToCreate.map((domain) => ({
      updateOne: {
        filter: {
          domainName: domain.domainName,
          userId: domain.userId,
        },
        update: { $set: domain },
        upsert: true,
      },
    }));

    const result = await PendingDomain.bulkWrite(bulkOps);
    serverLogger.info(
      `✅ [PAYMENT-VERIFY] Successfully processed ${
        result.upsertedCount + result.modifiedCount
      } pending domain records (${result.upsertedCount} new, ${
        result.modifiedCount
      } updated)`
    );
  } catch (error) {
    serverLogger.error(
      "❌ [PAYMENT-VERIFY] Failed to create pending domain records:",
      error
    );
  }
}

/** Build the PendingDomain payload shape that the verifier upserts. */
function buildPendingDomainPayload(
  orderDomain: OrderDomain,
  ctx: VerificationContext,
  fields: { status: string; reason: string; verificationAttempts: number }
): Record<string, unknown> {
  return {
    domainName: orderDomain.domainName,
    price: orderDomain.price,
    currency: orderDomain.currency,
    registrationPeriod: orderDomain.registrationPeriod,
    userId: ctx.user._id?.toString() || "",
    orderId: ctx.orderId,
    customerId: orderDomain.resellerClubCustomerId,
    contactId: orderDomain.resellerClubContactId,
    resellerClubOrderId: orderDomain.resellerClubOrderId,
    nameServers: ctx.nameServers,
    adminContactId: ctx.customerResult.contactId,
    techContactId: ctx.customerResult.contactId,
    billingContactId: ctx.customerResult.contactId,
    status: fields.status,
    reason: fields.reason,
    verificationAttempts: fields.verificationAttempts,
    lastVerifiedAt: new Date(),
  };
}
