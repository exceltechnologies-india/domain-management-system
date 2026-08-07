import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import { getUserById, setUserBillingCustomerId } from "@/lib/services/users";
import {
  lookupBillingCustomerByEmail,
  getBillingCustomerDetails,
} from "@/lib/integrations/billing-customer";

export const dynamic = "force-dynamic";

// GET - Read-only Billing Panel (ResellerOS) summary for a customer (admin only).
// Lazily matches by email on first call if no billingCustomerId is stored yet.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const user = await getUserById(id);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let billingCustomerId = user.billingCustomerId;
    if (!billingCustomerId) {
      const match = await lookupBillingCustomerByEmail(user.email);
      if (!match) {
        return NextResponse.json({ linked: false });
      }
      billingCustomerId = match.billing_customer_id;
      await setUserBillingCustomerId(id, billingCustomerId);
    }

    const details = await getBillingCustomerDetails(billingCustomerId);
    if (!details) {
      return NextResponse.json({ linked: false });
    }

    return NextResponse.json({ linked: true, ...details });
  } catch (error) {
    serverLogger.error("Get admin billing summary error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
