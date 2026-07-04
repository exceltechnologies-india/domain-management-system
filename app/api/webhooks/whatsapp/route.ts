import { NextRequest } from "next/server";
import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";
import { setWhatsAppOptOut, classifyOptKeyword } from "@/lib/services/whatsapp-optout";

export const dynamic = "force-dynamic";

/**
 * WhatsApp Cloud API webhook (Meta).
 *
 * TWO responsibilities:
 *   1. GET  — the one-time verification handshake Meta fires when you
 *      register the callback URL. Echo `hub.challenge` iff
 *      `hub.verify_token` matches WHATSAPP_WEBHOOK_VERIFY_TOKEN.
 *   2. POST — event delivery. Two event kinds we care about:
 *      - message STATUS updates (sent/delivered/read/failed) → logged for
 *        observability (foundation for a future delivery-audit surface).
 *      - inbound MESSAGES → scanned for STOP/START keywords to honor
 *        opt-out/opt-in (Meta policy requirement).
 *
 * Secrets (env / Secret Manager only, consistent with WHATSAPP_API_TOKEN):
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN — a string you choose; entered in both
 *     the Meta dashboard + env. Gates the GET handshake.
 *   WHATSAPP_APP_SECRET — Meta app secret; used to HMAC-verify POST bodies
 *     via the X-Hub-Signature-256 header.
 */

/** Timing-safe string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ─── GET: verification handshake ────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge") ?? "";
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token && safeEqual(token, expected)) {
    serverLogger.info("[WhatsApp webhook] Verification handshake succeeded");
    // Meta expects the raw challenge string echoed back, 200.
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  serverLogger.warn("[WhatsApp webhook] Verification handshake failed (bad mode/token)");
  return new Response("Forbidden", { status: 403 });
}

// ─── POST: event delivery ───────────────────────────────────────────────────

/** Verify Meta's X-Hub-Signature-256 HMAC over the raw body. */
function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header) return false;
  // Header form: "sha256=<hex>"
  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header, expected);
}

interface WaStatus {
  id?: string;
  status?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string }>;
}
interface WaMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
}
interface WaChangeValue {
  statuses?: WaStatus[];
  messages?: WaMessage[];
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  // If we can't verify (no app secret configured), don't process — but
  // return 200 so Meta doesn't hammer retries against an un-provisioned
  // webhook. Logged so the operator sees the gap.
  if (!appSecret) {
    serverLogger.warn(
      "[WhatsApp webhook] WHATSAPP_APP_SECRET not set — cannot verify signature; skipping event processing"
    );
    return new Response(JSON.stringify({ status: "ignored_unconfigured" }), { status: 200 });
  }

  // Signature verification — reject forgeries.
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature, appSecret)) {
    serverLogger.error("[WhatsApp webhook] Invalid X-Hub-Signature-256 — rejecting");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Malformed JSON — ack so Meta stops retrying; nothing to process.
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }

  try {
    const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: WaChangeValue }> }> }).entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        // Delivery-status updates — log for observability. (A persisted
        // delivery-audit collection is a clean future add; logging now
        // gives Cloud Logging visibility + a hook for Integration Health.)
        for (const st of value.statuses ?? []) {
          if (st.status === "failed") {
            serverLogger.error(
              `[WhatsApp webhook] Message ${st.id} FAILED to ${st.recipient_id}: ${JSON.stringify(st.errors ?? [])}`,
              { service: "whatsapp" }
            );
          } else {
            serverLogger.info(
              `[WhatsApp webhook] Message ${st.id} status=${st.status} to ${st.recipient_id}`,
              { service: "whatsapp" }
            );
          }
        }

        // Inbound messages — honor STOP / START opt-out keywords.
        for (const msg of value.messages ?? []) {
          const body = msg.text?.body;
          const from = msg.from;
          if (!body || !from) continue;
          const keyword = classifyOptKeyword(body);
          if (keyword === "stop") {
            await setWhatsAppOptOut(from, true);
          } else if (keyword === "start") {
            await setWhatsAppOptOut(from, false);
          } else {
            // Non-keyword inbound reply — logged; no auto-action. (Future:
            // route to support / surface in an inbox.)
            serverLogger.info(
              `[WhatsApp webhook] Inbound message from ${from} (no opt keyword)`,
              { service: "whatsapp" }
            );
          }
        }
      }
    }
  } catch (e) {
    // Never let a processing error turn into a non-200 (Meta would retry
    // the whole batch). Log + ack.
    serverLogger.error(
      "[WhatsApp webhook] Event processing error:",
      e instanceof Error ? e.message : String(e)
    );
  }

  return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
}
