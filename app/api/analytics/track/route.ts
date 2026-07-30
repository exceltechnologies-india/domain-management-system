import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { AUTH_SECRET } from "@/lib/auth-secret";
import { recordActivity } from "@/lib/services/analytics";
import { sendMetaServerEvent } from "@/lib/meta-capi";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { validatedBody, z } from "@/lib/api-validation";

// Client-fireable journey events only. Server-side milestones (registration,
// purchase, domain_added, …) are recorded directly from their own flows and
// must NOT be settable from the public browser endpoint.
const CLIENT_ALLOWED = ["landing_page_visit", "view_content", "start_trial", "checkout_started"] as const;

// Which client activities get a deduplicated Meta CAPI twin, and under which
// standard event name. The map is the ONLY source of truth — a client cannot
// pick an arbitrary Meta event (e.g. Purchase); the activity determines the
// event name. `start_trial` is intentionally absent: the StartTrial conversion
// fires server-side only on actual provisioning (see lib/journey.ts).
const CAPI_EVENT: Partial<Record<(typeof CLIENT_ALLOWED)[number], "ViewContent" | "InitiateCheckout">> = {
  view_content: "ViewContent",
  checkout_started: "InitiateCheckout",
};

const schema = z.object({
  activity: z.enum(CLIENT_ALLOWED),
  anonId: z.string().max(64).optional(),
  // Optional dedup + attribution signals for the CAPI twin.
  eventId: z.string().max(128).optional(),
  metaEvent: z.string().max(40).optional(),
  fbp: z.string().max(128).optional(),
  fbc: z.string().max(256).optional(),
});

export async function POST(request: NextRequest) {
  // Cheapest rejection first: cap a single-IP flood before any JWT / DB / CAPI
  // work. Generous limit — a dropped beacon is a missed event, never broken UX.
  const rl = await rateLimiters.analyticsBeacon.isAllowed(request);
  if (!rl.allowed) {
    return rateLimitResponse(rl, { message: "Too many analytics events.", limit: 120 });
  }

  const validation = await validatedBody(request, schema);
  if (!validation.ok) return validation.response;

  // Best-effort: attach the user id if a session cookie is present.
  let userId: string | null = null;
  try {
    const token = await getToken({ req: request, secret: AUTH_SECRET });
    const id = (token?.id as string | undefined) ?? token?.sub ?? null;
    userId = id ? String(id) : null;
  } catch {
    userId = null;
  }

  await recordActivity({
    activity: validation.data.activity,
    userId,
    anonId: validation.data.anonId ?? null,
  });

  // Deduplicated server-side twin for mid-funnel Pixel events, so the event
  // still reaches Meta when the browser's /tr beacon is blocked (ad-blocker /
  // ITP). The shared eventId collapses browser + server into one on Meta's
  // side. Fire-and-forget; never blocks the beacon response.
  const capiEvent = CAPI_EVENT[validation.data.activity];
  if (capiEvent && validation.data.eventId) {
    const h = request.headers;
    const clientIp =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
    void sendMetaServerEvent({
      eventName: capiEvent,
      eventId: validation.data.eventId,
      eventSourceUrl: h.get("referer") ?? undefined,
      clientIp,
      userAgent: h.get("user-agent"),
      fbp: validation.data.fbp ?? null,
      fbc: validation.data.fbc ?? null,
    });
  }

  return NextResponse.json({ ok: true });
}
