/**
 * /api/user/panel-order — buy hosting or a domain from inside the panel.
 *
 * Owner decision 30 (25 Sep 2026): ResellerOS creates every Razorpay order.
 * This route is the panel dialogs' only way to start a paid purchase:
 *
 *   POST — build the order from the SESSION's user (never from the body's
 *          identity), send it to ResellerOS (lib/reselleros/panel-order.ts),
 *          and hand the browser the Razorpay key + order id ResellerOS
 *          returned. When ResellerOS cannot be reached the purchase is refused.
 *          Nothing is written to this database on any path: no Order, no
 *          invoice, no pending payment. After the customer pays, ResellerOS's
 *          webhook records the payment and provisions through the engine.
 *   GET  — the billing details already on the account, to prefill the form.
 *
 * Status codes are chosen so the browser can never mistake a ResellerOS fault
 * for its own session expiring: ResellerOS refusing OUR key is a 503 here, not
 * a 401 — `lib/api-client.ts` treats a 401 as "signed out" and would log the
 * customer out for a configuration problem on our side.
 */
import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody } from "@/lib/api-validation";
import {
  createPanelOrder,
  panelOrderRefusalMessage,
} from "@/lib/reselleros/panel-order";
import {
  buildPanelOrderRequest,
  panelPurchaseSchema,
} from "@/lib/reselleros/panel-order-request";

export const dynamic = "force-dynamic";

const SIGN_IN = {
  error: "You're signed out, so the purchase wasn't started. Nothing was charged. Sign in and try again.",
  code: "UNAUTHORIZED",
} as const;

export async function GET(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) return secureJsonResponse(SIGN_IN, 401);
  const a = user.address;
  return secureJsonResponse({
    name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
    email: user.email,
    phoneOnFile: !!(user.phone && user.phone.replace(/\D/g, "").length >= 10),
    companyName: user.companyName ?? "",
    gstin: user.gstNumber ?? "",
    address: a
      ? { line1: a.line1 ?? "", city: a.city ?? "", state: a.state ?? "", zipcode: a.zipcode ?? "" }
      : null,
  });
}

export async function POST(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) return secureJsonResponse(SIGN_IN, 401);

  const validation = await validatedBody(request, panelPurchaseSchema);
  if (!validation.ok) return validation.response;

  const built = buildPanelOrderRequest(
    {
      id: String(user._id),
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
    },
    validation.data,
  );
  if (!built.ok) {
    return secureJsonResponse({ error: built.message, code: "PANEL_ORDER_INCOMPLETE", field: built.field }, 400);
  }

  // Never retried here: see the header of lib/reselleros/panel-order.ts.
  const outcome = await createPanelOrder(built.request);

  if (outcome.kind === "ok") {
    serverLogger.info(
      `[panel-order] ResellerOS order ${outcome.order.orderId} (quote ${outcome.order.quoteId ?? "?"}) for DMS user ${built.request.dmsUserId}`,
    );
    return secureJsonResponse({
      success: true,
      orderId: outcome.order.orderId,
      amount: outcome.order.amount,
      currency: outcome.order.currency,
      razorpayKeyId: outcome.order.razorpayKeyId,
      quoteId: outcome.order.quoteId ?? null,
      totalRupees: outcome.order.totalRupees ?? null,
      prefill: {
        name: built.request.fullName,
        email: built.request.email,
        contact: built.request.phone,
      },
    });
  }

  const message = panelOrderRefusalMessage(outcome);
  switch (outcome.kind) {
    case "refused":
      serverLogger.warn(`[panel-order] ResellerOS refused the order for DMS user ${built.request.dmsUserId}: ${outcome.message}`);
      return secureJsonResponse(
        {
          error: message,
          code: "PANEL_ORDER_REFUSED",
          ...(outcome.needAddress ? { needAddress: true } : {}),
          ...(outcome.needDomain ? { needDomain: true } : {}),
        },
        400,
      );
    case "not_configured":
      serverLogger.error(`[panel-order] not configured — set ${outcome.missing.join(" and ")} on DMS. Purchase refused.`);
      return secureJsonResponse({ error: message, code: "PANEL_ORDER_NOT_CONFIGURED" }, 503);
    case "config":
      serverLogger.error(
        `[panel-order] ResellerOS refused DMS's panel key or has no payments set up (HTTP ${outcome.status}: ${outcome.detail}). ` +
          "ACTION: check DMS_PANEL_API_KEY is the same on both apps and Razorpay is configured in ResellerOS.",
      );
      return secureJsonResponse({ error: message, code: "PANEL_ORDER_UNAVAILABLE" }, 503);
    case "unreachable":
      serverLogger.error(
        `[panel-order] ResellerOS gave no usable answer for DMS user ${built.request.dmsUserId} (${outcome.detail}); ` +
          `mayHaveCreated=${outcome.mayHaveCreated}. Purchase refused, not retried.`,
      );
      return secureJsonResponse(
        { error: message, code: "RESELLEROS_UNREACHABLE", mayHaveCreated: outcome.mayHaveCreated },
        503,
      );
  }
}
