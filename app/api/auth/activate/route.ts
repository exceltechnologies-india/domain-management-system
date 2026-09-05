import { NextRequest, NextResponse } from "next/server";
import { findUserByActivationToken } from "@/lib/services/users";
import { AuthService } from "@/lib/auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import { recordActivity } from "@/lib/services/analytics";

const activateSchema = z.object({
  token: z.string().trim().min(1, "Activation token is required").max(256),
});

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

/**
 * A repeat hit on a link whose account is already active. Answers 200 with the
 * same shape as a fresh activation (minus the JWT — nothing needs minting for
 * an account that is already live), so `app/activate/page.tsx` takes its
 * success path and sends the customer to sign in, instead of rendering a
 * failure for a state that is entirely correct.
 */
function alreadyActivated(user: {
  _id?: unknown;
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  isActivated?: boolean;
  profileCompleted?: boolean;
  provider?: string;
}) {
  return NextResponse.json({
    message: "Your account is already activated — please sign in to continue.",
    alreadyActivated: true,
    user: {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isActivated: true,
      profileCompleted: user.profileCompleted,
      provider: user.provider,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimiters.activation.isAllowed(request);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit, {
        limit: 10,
        message: "Too many activation attempts. Please try again later.",
      });
    }

    const validation = await validatedBody(request, activateSchema);
    if (!validation.ok) return validation.response;
    const { token } = validation.data;

    // Find user with the activation token
    const user = await findUserByActivationToken(token);

    if (!user) {
      // Check if token exists but is expired
      const expiredUser = await findUserByActivationToken(token, { onlyExpired: true });

      if (expiredUser) {
        // An ALREADY-ACTIVATED account whose window has since lapsed is not an
        // error — the customer just came back to a link they already used.
        // Telling them their link "expired" would send them to request a new
        // one for an account that is already fine.
        if (expiredUser.isActivated) return alreadyActivated(expiredUser);
        return NextResponse.json({ error: "Token expired" }, { status: 400 });
      }

      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    // Already activated → 200, not an error. See alreadyActivated() for why.
    if (user.isActivated) {
      return alreadyActivated(user);
    }

    // Activate the user.
    //
    // The token is deliberately NOT cleared. Clearing it made every repeat
    // hit on a perfectly good link unidentifiable: findUserByActivationToken
    // matches on `activationToken`, so once the field was erased the lookup
    // returned null and the handler fell through to "Invalid token" — the red
    // "Invalid Activation Link … Register Again" screen, shown to a customer
    // whose account had just activated successfully. It also made the
    // `isActivated` guard above dead code, despite its comment claiming it
    // caught repeat hits.
    //
    // That is not a rare edge case: email providers and corporate security
    // scanners routinely PREFETCH links in messages, which consumes the
    // activation before the human ever clicks. The customer's own click then
    // failed and told them to register again.
    //
    // Retaining the token is safe: `isActivated` above short-circuits before
    // any mutation, so a replayed token can only ever read. Expiry is left
    // untouched too, so the expired-lookup path can still recognise the row.
    user.isActivated = true;
    await user.save();

    // Mid-journey analytics milestone (fire-and-forget; never blocks activation).
    // Reached only on the genuine first activation — the `isActivated` guard
    // above returns early on repeat hits.
    void recordActivity({ activity: "email_verified", userId: user._id });

    // Generate JWT token for immediate login
    const jwtToken = AuthService.generateToken({
      userId: user._id?.toString() || "",
      email: user.email,
      role: user.role,
    });

    return NextResponse.json({
      message:
        "Account activated successfully! You can now access your dashboard.",
      token: jwtToken,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActivated: user.isActivated,
        profileCompleted: user.profileCompleted,
        provider: user.provider, // Include provider info for password detection
        // Include complete profile data to prevent data loss
        phone: user.phone,
        phoneCc: user.phoneCc,
        companyName: user.companyName,
        address: user.address,
      },
    });
  } catch (error) {
    serverLogger.error("Activation error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
