import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Public health check used by Cloud Run's liveness/readiness probes.
// Must respond quickly with 200 — no auth, no DB round-trips.
export async function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    { status: 200 }
  );
}
