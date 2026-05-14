import jwt from "jsonwebtoken";
import { AUTH_SECRET } from "@/lib/auth-secret";

const GUEST_TOKEN_TTL = 60 * 60; // 1 hour

export interface GuestRegistrantDetails {
  firstName: string;
  lastName: string;
  phone: string;        // 10-digit, no country code
  addressLine1: string;
  city: string;
  state: string;
  zipcode: string;      // 6-digit
}

export interface GuestTokenPayload extends GuestRegistrantDetails {
  email: string;
  purpose: "guest_checkout";
  iat?: number;
  exp?: number;
}

export function signGuestToken(
  email: string,
  details: GuestRegistrantDetails
): string {
  const payload: Omit<GuestTokenPayload, "iat" | "exp"> = {
    email,
    purpose: "guest_checkout",
    ...details,
  };
  return jwt.sign(payload, AUTH_SECRET, {
    expiresIn: GUEST_TOKEN_TTL,
    algorithm: "HS256",
  });
}

export function verifyGuestToken(token: string): GuestTokenPayload | null {
  try {
    const decoded = jwt.verify(token, AUTH_SECRET, {
      algorithms: ["HS256"],
    }) as GuestTokenPayload;
    if (decoded.purpose !== "guest_checkout") return null;
    return decoded;
  } catch {
    return null;
  }
}
