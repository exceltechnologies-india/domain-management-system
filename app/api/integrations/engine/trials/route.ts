/**
 * /api/integrations/engine/trials — the shared "one free trial per customer" record.
 *
 * GET  (read key)    ?email=&phone=&domain= → has this customer had a trial in
 *                    EITHER app? ResellerOS asks this before starting one.
 * POST (command key) { ref, email, phone?, domain?, planId?, cycle? } → record a
 *                    trial ResellerOS started, so DMS's own trial gates see it.
 *                    Idempotent on `ref` (the ResellerOS lead id).
 *
 * See lib/trials/trial-history.ts for what "the same customer" means.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeEngineCommandRequest, authorizeEngineReadRequest } from "@/lib/integrations/engine-auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { findPriorTrial, recordExternalTrial } from "@/lib/trials/trial-history";
import { serverLogger } from "@/lib/server-logger";
import { z } from "@/lib/api-validation";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!authorizeEngineReadRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = await rateLimiters.engineRead.isAllowed(request);
  if (!rl.allowed) return rateLimitResponse(rl, { message: "Too many requests." });

  const q = request.nextUrl.searchParams;
  const keys = { email: q.get("email"), phone: q.get("phone"), domain: q.get("domain") };
  if (!keys.email && !keys.phone && !keys.domain) {
    return NextResponse.json({ error: "Give at least one of email, phone or domain.", code: "VALIDATION_ERROR" }, { status: 400 });
  }
  try {
    const prior = await findPriorTrial(keys);
    return NextResponse.json(
      prior.found
        ? { trialled: true, where: prior.where, startedAt: prior.startedAt ? prior.startedAt.toISOString() : null }
        : { trialled: false },
    );
  } catch (err) {
    // A 5xx, never `trialled:false`: the caller must refuse the trial when the
    // question could not be answered.
    serverLogger.error("[engine-api] trial history lookup failed", err);
    return NextResponse.json({ error: "Could not read trial history." }, { status: 500 });
  }
}

const recordSchema = z.object({
  ref: z.string().trim().min(3).max(64),
  email: z.string().trim().email().max(254),
  phone: z.string().max(30).optional(),
  domain: z.string().max(253).optional(),
  planId: z.string().max(40).optional(),
  cycle: z.enum(["monthly", "yearly"]).optional(),
});

export async function POST(request: NextRequest) {
  if (!authorizeEngineCommandRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid trial record.", code: "VALIDATION_ERROR" }, { status: 400 });
  }
  try {
    const r = await recordExternalTrial(parsed.data);
    return NextResponse.json({ recorded: true, created: r.created });
  } catch (err) {
    serverLogger.error(`[engine-api] recording trial ${parsed.data.ref} failed`, err);
    return NextResponse.json({ error: "Could not record the trial." }, { status: 500 });
  }
}
