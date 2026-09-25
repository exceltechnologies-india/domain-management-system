/**
 * GET /api/user/billing — the signed-in customer's ResellerOS bills.
 *
 * DMS issues no bills (owner decision, 24 Sep 2026); the Invoices page shows
 * ResellerOS's: paid orders and pending renewals (quotes, with a Pay link) and
 * GST tax invoices. The ResellerOS API key stays on the server; the browser
 * only ever sees the per-document links ResellerOS signs for this customer.
 *
 * The answer is always 200 with an explicit `state`, so the page can say
 * exactly what happened instead of guessing from a status code:
 *   ok           — quotes + invoices
 *   no_bills     — ResellerOS has no customer with this email (yet)
 *   unavailable  — could not be read; the message says so and says what to do
 *
 * A read failure is NEVER returned as an empty list (AGENTS.md §2).
 */
import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { billsUnavailableMessage, fetchCustomerBills } from "@/lib/reselleros/bills";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) return secureJsonResponse({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);

  const outcome = await fetchCustomerBills(user.email);
  switch (outcome.kind) {
    case "ok":
      return secureJsonResponse({ state: "ok", quotes: outcome.quotes, invoices: outcome.invoices });
    case "no_bills":
      return secureJsonResponse({ state: "no_bills" });
    case "not_configured":
      serverLogger.error(
        `[billing] ResellerOS bills cannot be read: set ${outcome.missing.join(" and ")} on DMS.`,
      );
      return secureJsonResponse({ state: "unavailable", message: billsUnavailableMessage(outcome) });
    case "unavailable":
      serverLogger.error(`[billing] ResellerOS bills unreadable for user ${String(user._id)}: ${outcome.detail}`);
      return secureJsonResponse({ state: "unavailable", message: billsUnavailableMessage(outcome) });
    case "not_confirmed":
      serverLogger.warn(`[billing] bills not shown for user ${String(user._id)}: ${outcome.detail}`);
      return secureJsonResponse({ state: "unavailable", message: billsUnavailableMessage(outcome) });
  }
}
