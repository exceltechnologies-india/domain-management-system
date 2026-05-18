import { NextRequest, NextResponse } from "next/server";
import { getUserByEmail } from "@/lib/services/users";
import { EmailService } from "@/lib/email";
import { rateLimiters } from "@/lib/rate-limit";
import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimiters.resendActivation.isAllowed(request);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const user = await getUserByEmail(email.toLowerCase());

    // Return the same response whether the user exists or not (prevents enumeration)
    if (!user || user.isActivated) {
      return NextResponse.json({
        message: "If that email has a pending activation, we've resent the link.",
      });
    }

    // Generate new activation token
    const activationToken = crypto.randomBytes(32).toString("hex");
    const activationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Update user with new activation token
    user.activationToken = activationToken;
    user.activationTokenExpiry = activationTokenExpiry;
    await user.save();

    // Send activation email
    const emailSent = await EmailService.sendActivationEmail(
      user.email,
      `${user.firstName} ${user.lastName}`,
      activationToken
    );

    if (!emailSent) {
      return NextResponse.json(
        { error: "Failed to send activation email" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: "If that email has a pending activation, we've resent the link.",
    });
  } catch (error) {
    serverLogger.error("Resend activation error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
