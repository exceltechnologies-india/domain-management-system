/**
 * GET /api/integrations/engine/health — can ResellerOS talk to this engine, and
 * what is wired up behind it?
 *
 * ─── WHY THIS IS THE FIRST ENDPOINT ──────────────────────────────────────────
 * ResellerOS renders a page that links into this app. When that page is broken
 * the useful question is never "is it broken" but "which half". This answers it
 * in one call, before any feature endpoint is involved: a 401 means the key is
 * wrong, a timeout means the URL or the network is wrong, and a 200 with
 * `directadmin: false` means this app is reachable but cannot do hosting work —
 * three failures that otherwise look identical from the other side.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT RETURN ────────────────────────────────────
 * Booleans, never values. `resellerclub: true` says a credential is present; it
 * does not say which, and it cannot be worked backwards into one. The temptation
 * when debugging is to echo the configured URL or the first characters of a key
 * "just to check" — don't. This response crosses a network boundary and lands in
 * the other app's logs.
 *
 * It also does NOT call ResellerClub or DirectAdmin to prove they answer. That
 * would make a health check cost money-adjacent upstream quota and turn a
 * monitoring loop into a traffic generator against a third party that rate-limits
 * us. `configured` here means "this app has what it needs to try", which is the
 * question ResellerOS actually has. Whether the upstream is itself healthy is
 * what `app/api/admin/integration-health` already answers, interactively, for a
 * human who asked.
 */
import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import { authorizeEngineReadRequest } from "@/lib/integrations/engine-auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/** True when every named env var is present and non-empty. */
function allConfigured(...names: string[]): boolean {
  return names.every((n) => (process.env[n] ?? "").trim().length > 0);
}

export async function GET(request: NextRequest) {
  if (!authorizeEngineReadRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimiters.engineRead.isAllowed(request);
  if (!rl.allowed) {
    return rateLimitResponse(rl, { message: "Too many requests." });
  }

  // The database is the one dependency worth actually touching: it is ours, it
  // is free to ping, and every other endpoint on this surface is useless
  // without it. A failure here is reported as `database: false` with HTTP 200
  // rather than a 5xx — the engine IS reachable, which is precisely the
  // distinction this endpoint exists to draw, and a caller that gets a 503
  // cannot tell it apart from being unable to reach us at all.
  let database = false;
  try {
    await connectDB();
    database = mongoose.connection.readyState === 1;
  } catch (err) {
    serverLogger.warn("[engine-api] health: database unreachable", err);
  }

  return NextResponse.json({
    ok: true,
    service: "dms-engine",
    // Bump when the contract changes in a way ResellerOS must notice. Additive
    // fields do not need a bump; a removed or re-typed field does.
    contractVersion: 1,
    database,
    capabilities: {
      // "Has the credentials to try", not "the upstream answered" — see header.
      resellerclub: allConfigured(
        "RESELLERCLUB_API_URL",
        "RESELLERCLUB_ID",
        "RESELLERCLUB_SECRET"
      ),
      directadmin: allConfigured(
        "DIRECTADMIN_URL",
        "DIRECTADMIN_ADMIN_USER",
        "DIRECTADMIN_API_KEY"
      ),
    },
    // Where ResellerOS should send a human who clicks through. Read from env so
    // a local engine links to localhost and a deployed one links to itself,
    // instead of ResellerOS hardcoding a host it cannot verify.
    panelUrls: {
      admin: `${(process.env.APP_URL ?? "").replace(/\/+$/, "")}/admin`,
      customer: `${(process.env.APP_URL ?? "").replace(/\/+$/, "")}/dashboard`,
    },
  });
}
