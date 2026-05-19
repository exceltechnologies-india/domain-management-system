import {
  generateSecret as otpGenerateSecret,
  verifySync,
  generateURI,
} from "otplib";
import QRCode from "qrcode";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Anutech";

// Accept one TOTP step (30s) of skew on both sides to tolerate minor
// clock drift between server and client authenticator app.
const SKEW_TOLERANCE_S = 30;

export function generateTotpSecret(): string {
  return otpGenerateSecret();
}

export function verifyTotpCode(secret: string, token: string): boolean {
  try {
    const result = verifySync({
      secret,
      token: token.replace(/\s/g, ""),
      epochTolerance: SKEW_TOLERANCE_S,
    });
    return result?.valid === true;
  } catch {
    return false;
  }
}

export function getTotpUri(secret: string, email: string): string {
  return generateURI({ secret, label: email, issuer: APP_NAME });
}

export async function generateQrCodeDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    width: 200,
    margin: 2,
  });
}

export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const hex = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  });
}

export async function hashBackupCode(code: string): Promise<string> {
  return bcrypt.hash(code.replace(/-/g, "").toUpperCase(), 10);
}

export async function verifyBackupCode(
  code: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(code.replace(/-/g, "").toUpperCase(), hash);
}
