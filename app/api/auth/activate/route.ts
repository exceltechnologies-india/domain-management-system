import { NextRequest, NextResponse } from "next/server";
import { findUserByActivationToken } from "@/lib/services/users";
import { AuthService } from "@/lib/auth";
import { rateLimiters } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimiters.activation.isAllowed(request);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many activation attempts. Please try again later." },
        { status: 429 }
      );
    }

    const { token } = await request.json();

    if (!token) {
      return NextResponse.json(
        { error: "Activation token is required" },
        { status: 400 }
      );
    }

    // Find user with the activation token
    const user = await findUserByActivationToken(token);

    if (!user) {
      // Check if token exists but is expired
      const expiredUser = await findUserByActivationToken(token, { onlyExpired: true });

      if (expiredUser) {
        return NextResponse.json({ error: "Token expired" }, { status: 400 });
      }

      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    // Check if user is already activated
    if (user.isActivated) {
      return NextResponse.json(
        { error: "Account is already activated" },
        { status: 400 }
      );
    }

    // Activate the user
    user.isActivated = true;
    user.activationToken = undefined;
    user.activationTokenExpiry = undefined;
    await user.save();

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
