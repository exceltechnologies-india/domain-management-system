import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { authorizeBillingProvisionRequest } from "@/lib/integrations/billing-provision-auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import {
  getUserByEmail,
  createUser,
  setUserBillingCustomerId,
} from "@/lib/services/users";
import { EmailService } from "@/lib/email";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import { Schemas } from "@/lib/validation";

export const dynamic = "force-dynamic";

const provisionSchema = z.object({
  email: Schemas.email,
  name: z.string().trim().min(1).max(200),
  billingCustomerId: z.string().trim().min(1).max(50),
});

/** "Rakesh Dummy" -> {firstName: "Rakesh", lastName: "Dummy"}; single-word or
 * company names fall back to a lastName placeholder since it's required. */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "." };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Billing Panel (ResellerOS) -> Customer Panel: provisions (or links) a
// Customer Panel account for a Billing customer, when a Billing admin
// explicitly opts in via the "Also create Customer Panel account" checkbox.
// Server-to-server, authenticated via BILLING_PROVISION_API_KEY — a write
// path, deliberately separate from the read-only BILLING_INTEGRATION_API_KEY
// integration. Idempotent by email: calling twice for the same person links
// rather than duplicating.
export async function POST(request: NextRequest) {
  if (!authorizeBillingProvisionRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimiters.billingProvision.isAllowed(request);
  if (!rl.allowed) {
    return rateLimitResponse(rl, { message: "Too many requests." });
  }

  const validation = await validatedBody(request, provisionSchema);
  if (!validation.ok) return validation.response;
  const { email, name, billingCustomerId } = validation.data;

  try {
    const existing = await getUserByEmail(email);
    if (existing) {
      await setUserBillingCustomerId(existing._id.toString(), billingCustomerId);
      serverLogger.info(
        `[billing-provision] Linked existing Customer Panel user ${email} to Billing ${billingCustomerId}`
      );
      // No setup email — they already have a password. Explicit false (not
      // omitted) so the caller can render a consistent message either way.
      return NextResponse.json({ created: false, linked: true, userId: existing._id.toString(), emailSent: false });
    }

    const { firstName, lastName } = splitName(name);
    const newUser = await createUser({
      email,
      password: randomBytes(32).toString("hex"), // unusable random password — set via email link below
      firstName,
      lastName,
      role: "user",
      isActive: true,
      isActivated: true,
      isGuest: true,
      profileCompleted: false,
      provider: "credentials",
      billingCustomerId,
    });
    serverLogger.info(
      `[billing-provision] Created Customer Panel user ${email} for Billing ${billingCustomerId}`
    );

    // Awaited (was fire-and-forget) — the caller (Billing) needs the real
    // outcome to tell the admin whether the customer actually got their
    // setup email, instead of assuming success just because the account
    // was created. A transient SMTP failure here used to be invisible:
    // this endpoint returned before the send even resolved, so Billing
    // always showed "setup email sent" regardless of what really happened.
    let emailSent = false;
    try {
      const setupToken = randomBytes(32).toString("hex");
      newUser.resetToken = setupToken;
      newUser.resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await newUser.save();
      emailSent = await EmailService.sendPasswordResetEmail(
        newUser.email,
        firstName,
        setupToken,
        true,
        "An account has been set up for you. To get started, choose a password using the button below:"
      );
      serverLogger.info(`[billing-provision] Setup email ${emailSent ? "sent" : "failed"} for ${email}`);
    } catch (err) {
      serverLogger.error("[billing-provision] Failed to send setup email:", err);
    }

    return NextResponse.json({ created: true, linked: true, userId: newUser._id.toString(), emailSent });
  } catch (error) {
    serverLogger.error("[billing-provision] Failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
