import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import {
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
} from "@/lib/totp";

export const dynamic = "force-dynamic";

/**
 * POST — verify the first TOTP code against the pending secret.
 * On success: activates 2FA, generates backup codes, clears pending secret.
 * Returns the plaintext backup codes (shown once, never stored in plaintext).
 */
export async function POST(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { code } = body;
  if (!code || typeof code !== "string") {
    return NextResponse.json(
      { error: "Authenticator code is required" },
      { status: 400 }
    );
  }

  await connectDB();
  const dbUser = await User.findById(user._id).select(
    "+totpSecretPending totpEnabled"
  );
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (dbUser.totpEnabled) {
    return NextResponse.json(
      { error: "2FA is already enabled" },
      { status: 409 }
    );
  }

  if (!dbUser.totpSecretPending) {
    return NextResponse.json(
      { error: "No pending 2FA setup found. Please start setup again." },
      { status: 400 }
    );
  }

  const isValid = verifyTotpCode(dbUser.totpSecretPending, code);
  if (!isValid) {
    return NextResponse.json(
      { error: "Invalid code. Please check your authenticator app and try again." },
      { status: 422 }
    );
  }

  const plaintextCodes = generateBackupCodes(8);
  const hashedCodes = await Promise.all(plaintextCodes.map(hashBackupCode));

  await User.updateOne(
    { _id: dbUser._id },
    {
      $set: {
        totpEnabled: true,
        totpSecret: dbUser.totpSecretPending,
        totpBackupCodes: hashedCodes,
      },
      $unset: { totpSecretPending: "" },
    }
  );

  return NextResponse.json({
    success: true,
    backupCodes: plaintextCodes,
  });
}
