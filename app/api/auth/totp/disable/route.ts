import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import {
  disableTOTPForUser,
  getUserWithTOTPSecrets,
} from "@/lib/services/users";
import { verifyTotpCode, verifyBackupCode } from "@/lib/totp";
import { validatedBody, z } from "@/lib/api-validation";

const totpDisableSchema = z.object({
  // Allow TOTP (6 digits) or backup code (longer alphanumeric). The
  // route verifies against both shapes downstream.
  code: z.string().trim().min(6).max(64),
  password: z.string().min(1, "Password is required").max(256),
});

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

  const validation = await validatedBody(request, totpDisableSchema);
  if (!validation.ok) return validation.response;
  const { code, password } = validation.data;

  const dbUser = await getUserWithTOTPSecrets(String(user._id));
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

  await disableTOTPForUser(String(dbUser._id));

  return NextResponse.json({ success: true });
}
