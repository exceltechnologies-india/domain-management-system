import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getBillingSubscriptions } from "@/lib/integrations/billing-customer";
import { resolveUserBillingCustomerId } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

// Domains and hosting have their own dedicated tabs — this list is for
// everything else Billing sells (Workspace, M365, future product lines),
// so a new product Billing starts offering never needs a new Customer
// Panel tab: it just shows up here automatically.
const EXCLUDED_VENDORS = new Set(["domain", "hosting"]);

// GET /api/user/services — customer-facing "My Services" list, generic
// across whatever products Billing has for this customer.
export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const billingCustomerId = await resolveUserBillingCustomerId(user);
    if (!billingCustomerId) {
      return NextResponse.json({ services: [] });
    }

    const subscriptions = await getBillingSubscriptions(billingCustomerId);
    const services = subscriptions
      .filter((s) => !EXCLUDED_VENDORS.has(s.vendor ?? ""))
      .map((s) => ({
        id: s.id,
        product: s.product,
        plan: s.plan,
        seats: s.seats,
        status: s.status,
        renewalDate: s.renewal_date,
        amount: s.amount,
        currency: s.currency,
      }));

    return NextResponse.json({ services });
  } catch (error) {
    serverLogger.error("Failed to fetch services:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
