import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getUserById, setPendingTOTPSecret } from "@/lib/services/users";
import {
  generateTotpSecret,
  getTotpUri,
  generateQrCodeDataUrl,
} from "@/lib/totp";

export const dynamic = "force-dynamic";

/** GET — return current 2FA status for the authenticated user */
export async function GET(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUser = await getUserById(String(user._id));
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({ totpEnabled: dbUser.totpEnabled });
}

/**
 * POST — generate a new TOTP secret and QR code.
 * Stores the secret as `totpSecretPending` (not yet active) until confirmed via /confirm.
 */
export async function POST(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dbUser = await getUserById(String(user._id));
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (dbUser.totpEnabled) {
    return NextResponse.json(
      { error: "2FA is already enabled. Disable it before re-enrolling." },
      { status: 409 }
    );
  }

  const secret = generateTotpSecret();
  const uri = getTotpUri(secret, dbUser.email);
  const qrCodeDataUrl = await generateQrCodeDataUrl(uri);

  await setPendingTOTPSecret(String(dbUser._id), secret);

  return NextResponse.json({
    qrCodeDataUrl,
    manualKey: secret,
  });
}
