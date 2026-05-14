import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { verifyTotpCode, verifyBackupCode } from "@/lib/totp";

export const dynamic = "force-dynamic";

/**
 * POST — disable 2FA for the authenticated admin.
 * Requires a valid current TOTP code (or backup code) + current password.
 */
export async function POST(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { code, password } = body;
  if (!code || !password) {
    return NextResponse.json(
      { error: "Authenticator code and password are required" },
      { status: 400 }
    );
  }

  await connectDB();
  const dbUser = await User.findById(user._id).select(
    "+totpSecret +totpBackupCodes totpEnabled"
  );
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (!dbUser.totpEnabled) {
    return NextResponse.json(
      { error: "2FA is not enabled" },
      { status: 400 }
    );
  }

  // Verify password first
  const isPasswordValid = await dbUser.comparePassword(password);
  if (!isPasswordValid) {
    return NextResponse.json(
      { error: "Incorrect password" },
      { status: 422 }
    );
  }

  // Verify TOTP or backup code
  const isValidTotp =
    dbUser.totpSecret && verifyTotpCode(dbUser.totpSecret, code);

  if (!isValidTotp) {
    let validBackup = false;
    if (dbUser.totpBackupCodes?.length) {
      for (const hash of dbUser.totpBackupCodes) {
        if (await verifyBackupCode(code, hash)) {
          validBackup = true;
          break;
        }
      }
    }
    if (!validBackup) {
      return NextResponse.json(
        { error: "Invalid authenticator code" },
        { status: 422 }
      );
    }
  }

  await User.updateOne(
    { _id: dbUser._id },
    {
      $set: { totpEnabled: false },
      $unset: { totpSecret: "", totpSecretPending: "", totpBackupCodes: "" },
    }
  );

  return NextResponse.json({ success: true });
}
