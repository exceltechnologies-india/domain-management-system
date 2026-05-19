import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { RazorpayService } from "@/lib/razorpay";
import {
  signGuestToken,
  verifyGuestToken,
  GuestRegistrantDetails,
} from "@/lib/guest-token";
import { InputValidator } from "@/lib/validation";
import { validateDomainPeriod } from "@/lib/tld-policies";
import { verifyDomainPrices } from "@/lib/services/payment/price-verifier";
import { isDisposableEmail } from "@/lib/disposable-emails";
import { getClientIp, hashIp } from "@/lib/trial-abuse";
import type { CartItem } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/guest/create-order
 *
 * Creates a Razorpay order for a guest checkout (no account required).
 * Restricted to domain-only carts. Real registrant details (name, phone,
 * address) are required up-front so we never send dummy values to
 * ResellerClub.
 *
 * Body: {
 *   email, cartItems: CartItem[], guestToken?: string,
 *   firstName, lastName, phone, addressLine1, city, state, zipcode
 * }
 *
 * If guestToken is provided and valid, its signed details are reused
 * verbatim (client-side body fields are ignored — prevents tampering between
 * the original consent and verify). Otherwise a new token is signed from
 * the supplied body fields and returned to the client.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      email,
      cartItems,
      guestToken: existingToken,
      deviceFingerprint,
    } = body;

    // ── Resolve email + registrant details ───────────────────────────────────
    let resolvedEmail: string | null = null;
    let registrantDetails: GuestRegistrantDetails | null = null;

    if (existingToken) {
      const payload = verifyGuestToken(existingToken);
      if (!payload) {
        return NextResponse.json(
          { error: "Guest session expired — please re-enter your details" },
          { status: 401 }
        );
      }
      // Trust signed details over any new body values — token is the consent record.
      resolvedEmail = payload.email;
      registrantDetails = {
        firstName: payload.firstName,
        lastName: payload.lastName,
        phone: payload.phone,
        addressLine1: payload.addressLine1,
        city: payload.city,
        state: payload.state,
        zipcode: payload.zipcode,
      };
    } else {
      // First-time submission — validate every field before signing a token.
      if (!email || typeof email !== "string") {
        return NextResponse.json({ error: "Email is required" }, { status: 400 });
      }
      const normalized = email.trim().toLowerCase();
      // validateEmail returns { isValid, errors } — not a boolean
      const emailCheck = InputValidator.validateEmail(normalized);
      if (!emailCheck.isValid) {
        return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
      }
      resolvedEmail = normalized;

      const required = ["firstName", "lastName", "phone", "addressLine1", "city", "state", "zipcode"] as const;
      const trimmed: Record<string, string> = {};
      for (const field of required) {
        const v = body[field];
        if (typeof v !== "string" || !v.trim()) {
          return NextResponse.json(
            { error: `Missing required field: ${field}` },
            { status: 400 }
          );
        }
        trimmed[field] = v.trim();
      }
      if (!/^\d{10}$/.test(trimmed.phone)) {
        return NextResponse.json(
          { error: "Phone must be a 10-digit number" },
          { status: 400 }
        );
      }
      if (!/^\d{6}$/.test(trimmed.zipcode)) {
        return NextResponse.json(
          { error: "PIN code must be a 6-digit number" },
          { status: 400 }
        );
      }
      if (trimmed.firstName.length > 50 || trimmed.lastName.length > 50) {
        return NextResponse.json(
          { error: "Name fields are too long" },
          { status: 400 }
        );
      }
      registrantDetails = {
        firstName: trimmed.firstName,
        lastName: trimmed.lastName,
        phone: trimmed.phone,
        addressLine1: trimmed.addressLine1,
        city: trimmed.city,
        state: trimmed.state,
        zipcode: trimmed.zipcode,
      };
    }

    // ── Validate cart ─────────────────────────────────────────────────────────
    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    // Free trials require login (1-per-user-lifetime check needs an account).
    if (cartItems.some((item: CartItem) => item.isTrial === true)) {
      return NextResponse.json(
        {
          error:
            "Free trials require an account. Please sign in or remove the trial item.",
        },
        { status: 400 }
      );
    }

    for (const item of cartItems) {
      if (!item.domainName || item.price === undefined || !item.currency) {
        return NextResponse.json(
          { error: "Invalid cart item data" },
          { status: 400 }
        );
      }
      // Period validation only applies to domains; hosting uses its own
      // period semantics (1 / 12 months) which the cart already constrains.
      if (!item.itemType || item.itemType === "domain") {
        const periodError = validateDomainPeriod(
          item.domainName,
          item.registrationPeriod || 1
        );
        if (periodError) {
          return NextResponse.json({ error: periodError }, { status: 400 });
        }
      }
    }

    // ── Anti-abuse: disposable-email block ───────────────────────────────────
    // WHOIS data needs a real reachable email, and DirectAdmin needs
    // somewhere to send hosting credentials. The IP/device throttle from
    // the trial-abuse stack is intentionally NOT reused here — paid guest
    // checkout would otherwise lock out anyone who tested the free trial
    // from the same network in the last 30 days. Payment is its own
    // friction. Log the signal so we can spot floods, but don't block.
    if (resolvedEmail && isDisposableEmail(resolvedEmail)) {
      return NextResponse.json(
        {
          error:
            "Disposable email addresses aren't accepted for domain registration or hosting. Please use a real email.",
          code: "DISPOSABLE_EMAIL",
        },
        { status: 400 }
      );
    }
    const clientIp = getClientIp(request);
    serverLogger.info(
      `[GuestCheckout] create-order ip=${hashIp(clientIp).slice(0, 12)} dev=${deviceFingerprint?.slice(0, 12) || "none"}`
    );

    // ── Live price verification ──────────────────────────────────────────
    // Same protection as the logged-in flow: never trust client-supplied
    // prices for the actual charge. Live-fetch RC pricing and refuse if
    // the totals don't agree within rounding tolerance.
    const priceCheck = await verifyDomainPrices(cartItems);
    if (!priceCheck.ok) {
      serverLogger.warn(
        `🛡️  [GuestCheckout] Price mismatch for ${resolvedEmail}: server=₹${priceCheck.serverTotal} client=₹${priceCheck.clientTotal} mismatched=${priceCheck.mismatchedDomains.join(",")}`
      );
      return NextResponse.json(
        {
          error: priceCheck.error,
          code: "PRICE_CHANGED",
          serverTotal: priceCheck.serverTotal,
          clientTotal: priceCheck.clientTotal,
          mismatchedDomains: priceCheck.mismatchedDomains,
        },
        { status: 409 }
      );
    }
    if (priceCheck.fellBackToClient) {
      serverLogger.warn(
        `[GuestCheckout] Live RC pricing unavailable — proceeding with client total ₹${priceCheck.clientTotal}`
      );
    }

    // ── Calculate total (server-verified) ────────────────────────────────────
    // `serverTotal` from the verifier is domain-only. Hosting items use prices
    // from our HostingPlan DB (not RC), so they're trusted as-is — add their
    // sum back in for a mixed cart.
    const hostingTotal = cartItems
      .filter((i: CartItem) => i.itemType === "hosting")
      .reduce(
        (sum: number, item: CartItem) =>
          sum + item.price * (item.registrationPeriod || 1),
        0
      );
    const totalAmount = priceCheck.fellBackToClient
      ? cartItems.reduce(
          (sum: number, item: CartItem) =>
            sum + item.price * (item.registrationPeriod || 1),
          0
        )
      : priceCheck.serverTotal + hostingTotal;

    if (totalAmount <= 0) {
      return NextResponse.json(
        { error: "Invalid order amount" },
        { status: 400 }
      );
    }

    // ── Create Razorpay order ─────────────────────────────────────────────────
    const shortTs = Date.now().toString().slice(-10);
    const rand = Math.random().toString(36).substring(2, 6);
    const receiptId = `gst_${shortTs}_${rand}`;

    const rzpOrder = await RazorpayService.createOrder(
      totalAmount,
      "INR",
      receiptId
    );

    serverLogger.info(
      `[GuestCheckout] Order created: ${rzpOrder.id} for ${resolvedEmail} — ₹${totalAmount}`
    );

    // ── Issue (or reuse) guest token ──────────────────────────────────────────
    const guestToken =
      existingToken ?? signGuestToken(resolvedEmail, registrantDetails);

    return NextResponse.json({
      success: true,
      razorpayOrderId: rzpOrder.id,
      amount: totalAmount,
      currency: "INR",
      guestToken,
      email: resolvedEmail,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[GuestCheckout] create-order error:", message);
    return NextResponse.json(
      { error: "Failed to create payment order" },
      { status: 500 }
    );
  }
}
