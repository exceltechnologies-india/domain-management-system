/**
 * WhatsApp opt-out state — driven by inbound "STOP"/"START" messages
 * received on the WhatsApp webhook.
 *
 * Honoring an opt-out is a Meta policy requirement (and basic courtesy):
 * a customer who replies STOP must stop receiving messages. We flip
 * `User.whatsappOptOut` and every WhatsApp send site checks it.
 */
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { serverLogger } from "@/lib/server-logger";

/**
 * Normalise any inbound number form to its last 10 digits for matching.
 * Meta delivers E.164-ish "919876543210"; we store 10-digit "9876543210".
 * Stripping to the last 10 digits reconciles both. Digits-only, so the
 * value is safe to interpolate into a RegExp (no metacharacters).
 */
function last10(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Flip the WhatsApp opt-out flag for whichever user(s) own `fromNumber`
 * (matched on whatsappNumber OR phone ending in the same 10 digits).
 * Returns the count of updated users. No-throw: logs + returns 0 on error
 * so the webhook handler stays best-effort.
 */
export async function setWhatsAppOptOut(
  fromNumber: string,
  optOut: boolean
): Promise<number> {
  const tail = last10(fromNumber);
  if (tail.length < 10) {
    serverLogger.warn(`[WhatsApp opt-out] Ignoring un-matchable number: ${fromNumber}`);
    return 0;
  }
  try {
    await connectDB();
    const tailRegex = new RegExp(`${tail}$`);
    const result = await User.updateMany(
      { $or: [{ whatsappNumber: tailRegex }, { phone: tailRegex }] },
      { $set: { whatsappOptOut: optOut } }
    );
    const n = result.modifiedCount ?? 0;
    serverLogger.info(
      `[WhatsApp opt-out] ${optOut ? "OPT-OUT" : "OPT-IN"} for …${tail} → ${n} user(s) updated`
    );
    return n;
  } catch (e) {
    serverLogger.error(
      `[WhatsApp opt-out] Failed to set opt-out for …${tail}:`,
      e instanceof Error ? e.message : String(e)
    );
    return 0;
  }
}

// Inbound-keyword classification. Case-insensitive, trimmed.
const STOP_KEYWORDS = new Set(["stop", "unsubscribe", "stop all", "cancel", "end", "quit", "optout", "opt out"]);
const START_KEYWORDS = new Set(["start", "unstop", "subscribe", "resume", "optin", "opt in"]);

/** Returns 'stop' | 'start' | null for an inbound message body. */
export function classifyOptKeyword(text: string): "stop" | "start" | null {
  const t = text.trim().toLowerCase();
  if (STOP_KEYWORDS.has(t)) return "stop";
  if (START_KEYWORDS.has(t)) return "start";
  return null;
}
