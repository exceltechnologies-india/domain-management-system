import { NextRequest, NextResponse } from "next/server";
import { authorizeBillingProvisionRequest } from "@/lib/integrations/billing-provision-auth";
import { unlinkUsersFromBillingCustomerId } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

export const dynamic = "force-dynamic";

const unlinkSchema = z.object({
  billingCustomerId: z.string().trim().min(1).max(50),
});

// Billing Panel -> Customer Panel: the linked Billing customer was deleted
// (only possible for a customer with no money history — see Billing's
// delete_customer RPC guard). Clears the stale reference; does NOT
// deactivate or touch the Customer Panel account itself — see
// unlinkUsersFromBillingCustomerId's docstring for why.
export async function POST(request: NextRequest) {
  if (!authorizeBillingProvisionRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const validation = await validatedBody(request, unlinkSchema);
  if (!validation.ok) return validation.response;

  try {
    const unlinked = await unlinkUsersFromBillingCustomerId(validation.data.billingCustomerId);
    serverLogger.info(
      `[billing-unlink] Unlinked ${unlinked} user(s) from deleted Billing customer ${validation.data.billingCustomerId}`
    );
    return NextResponse.json({ unlinked });
  } catch (error) {
    serverLogger.error("[billing-unlink] Failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
