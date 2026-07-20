/**
 * Meta Conversions API (server events).
 *
 * Sends server-side events (CompleteRegistration, Purchase) to the same Meta
 * dataset as the browser Pixel. PII is SHA-256 hashed per Meta's spec; the
 * `event_id` matches the browser event where one exists so Meta deduplicates
 * (SRS §5). No-ops safely when the token / pixel id is missing or tracking is
 * disabled, and never throws into the caller's flow.
 *
 * Token: process.env.META_CAPI_ACCESS_TOKEN (Google Secret Manager).
 * Dataset/Pixel id: from the admin tracking config (getTrackingConfig).
 */

import crypto from "crypto";
import { getTrackingConfig } from "@/lib/services/tracking";
import { serverLogger } from "@/lib/server-logger";

const GRAPH_VERSION = "v19.0";

function sha256(value?: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function normalizePhone(value?: string | null): string | undefined {
  if (!value) return undefined;
  const digits = String(value).replace(/[^0-9]/g, "");
  return digits || undefined;
}

export interface ServerEventArgs {
  eventName: "CompleteRegistration" | "Purchase";
  /** Deterministic id (e.g. reg_<userId>, purchase_<orderId>) for dedup. */
  eventId: string;
  user?: { email?: string | null; phone?: string | null };
  customData?: Record<string, unknown>;
  eventSourceUrl?: string;
  clientIp?: string | null;
  userAgent?: string | null;
  fbclid?: string | null;
}

export async function sendMetaServerEvent(args: ServerEventArgs): Promise<void> {
  try {
    const token = process.env.META_CAPI_ACCESS_TOKEN;
    const cfg = await getTrackingConfig();
    const pixelId = cfg.metaPixelId;

    // No-op when not configured — never a hard error in the primary flow.
    if (!token || !pixelId || !cfg.enabled) return;

    const user_data: Record<string, unknown> = {};
    const em = sha256(args.user?.email);
    if (em) user_data.em = [em];
    const ph = sha256(normalizePhone(args.user?.phone));
    if (ph) user_data.ph = [ph];
    if (args.clientIp) user_data.client_ip_address = args.clientIp;
    if (args.userAgent) user_data.client_user_agent = args.userAgent;
    if (args.fbclid) user_data.fbc = `fb.1.${Date.now()}.${args.fbclid}`;

    const payload = {
      data: [
        {
          event_name: args.eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: args.eventId,
          action_source: "website",
          ...(args.eventSourceUrl ? { event_source_url: args.eventSourceUrl } : {}),
          user_data,
          custom_data: args.customData || {},
        },
      ],
    };

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      serverLogger.error(`[meta-capi] ${args.eventName} failed: ${res.status} ${text.slice(0, 300)}`);
    }
  } catch (error) {
    serverLogger.error("[meta-capi] send failed", error);
  }
}
