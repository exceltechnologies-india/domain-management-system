/**
 * /api/user/renewal-order — pay a ResellerOS renewal bill from inside the panel.
 *
 * POST { quoteId } — the quote is one the Renew dialog listed (from /api/user/billing). The
 * identity sent to ResellerOS is the SESSION's (email + account id), never the body's, and
 * ResellerOS matches that email exactly to the quote's customer before opening a Razorpay
 * order (lib/reselleros/renewal-order.ts). Nothing is written to this database.
 *
 * As with /api/user/panel-order, ResellerOS refusing OUR key is a 503 here, never a 401,
 * because lib/api-client.ts reads a 401 as "signed out".
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody } from "@/lib/api-validation";
import { createRenewalOrder, renewalOrderRefusalMessage } from "@/lib/reselleros/renewal-order";

export const dynamic = "force-dynamic";

const schema = z.object({ quoteId: z.string().trim().regex(/^[A-Za-z0-9-]{3,64}$/) });

export async function POST(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) {
    return secureJsonResponse(
      { error: "You're signed out, so the renewal payment wasn't started. Nothing was charged. Sign in and try again.", code: "UNAUTHORIZED" },
      401,
    );
  }
  const validation = await validatedBody(request, schema);
  if (!validation.ok) return validation.response;

  const dmsUserId = String(user._id);
  const outcome = await createRenewalOrder({ quoteId: validation.data.quoteId, email: user.email, dmsUserId });

  if (outcome.kind === "ok") {
    serverLogger.info(`[renewal-order] ResellerOS order ${outcome.order.orderId} for renewal ${outcome.order.quoteId}, DMS user ${dmsUserId}`);
    return secureJsonResponse({
      success: true,
      orderId: outcome.order.orderId,
      amount: outcome.order.amount,
      currency: outcome.order.currency,
      razorpayKeyId: outcome.order.razorpayKeyId,
      quoteId: outcome.order.quoteId,
      prefill: { name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(), email: user.email, contact: user.phone ?? "" },
    });
  }

  const message = renewalOrderRefusalMessage(outcome);
  switch (outcome.kind) {
    case "refused":
      serverLogger.warn(`[renewal-order] ResellerOS refused renewal ${validation.data.quoteId} for DMS user ${dmsUserId} (HTTP ${outcome.status}): ${outcome.message}`);
      return secureJsonResponse({ error: message, code: "RENEWAL_ORDER_REFUSED" }, outcome.status === 409 ? 409 : 400);
    case "not_configured":
      serverLogger.error(`[renewal-order] not configured — set ${outcome.missing.join(" and ")} on DMS.`);
      return secureJsonResponse({ error: message, code: "RENEWAL_ORDER_NOT_CONFIGURED" }, 503);
    case "config":
      serverLogger.error(
        `[renewal-order] ResellerOS answered HTTP ${outcome.status} (${outcome.detail}). ` +
          "ACTION: check DMS_PANEL_API_KEY matches on both apps and Razorpay is configured in ResellerOS.",
      );
      return secureJsonResponse({ error: message, code: "RENEWAL_ORDER_UNAVAILABLE" }, 503);
    case "unreachable":
      serverLogger.error(`[renewal-order] ResellerOS gave no usable answer for DMS user ${dmsUserId}: ${outcome.detail}`);
      return secureJsonResponse({ error: message, code: "RESELLEROS_UNREACHABLE" }, 503);
  }
}
