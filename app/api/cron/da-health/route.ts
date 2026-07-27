import { NextRequest, NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { DirectAdminService } from "@/lib/directadmin";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/**
 * Read-only DirectAdmin reachability probe, authenticated by the cron secret
 * (`x-cron-secret`) so it can be checked from an operator machine WITHOUT an
 * admin session — the DA call still originates from Cloud Run's whitelisted
 * egress IP. Mirrors the System Health probe (`listPackages`) but callable via
 * curl. Non-mutating; safe to hit anytime.
 *
 *   curl -H "x-cron-secret: $CRON_SECRET" https://app.anutech.in/api/cron/da-health
 */
export async function GET(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const packages = await DirectAdminService.listPackages();
    return NextResponse.json({
      reachable: true,
      packageCount: packages.length,
      packages,
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[da-health] DirectAdmin probe failed", { message });
    return NextResponse.json(
      { reachable: false, error: message, latencyMs: Date.now() - startedAt },
      { status: 200 }, // 200 so the payload is easy to read; `reachable:false` is the signal
    );
  }
}
