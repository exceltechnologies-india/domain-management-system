import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import { redis } from "@/lib/redis";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 3000;

type CheckResult = { name: string; ok: boolean; latencyMs: number; error?: string };

async function withTimeout<T>(label: string, p: Promise<T>): Promise<CheckResult> {
  const started = Date.now();
  try {
    await Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS)
      ),
    ]);
    return { name: label, ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      name: label,
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pingMongo(): Promise<void> {
  await connectDB();
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error("mongo admin not available");
  await admin.ping();
}

async function pingRedis(): Promise<void> {
  // If REDIS_HOST is unset, lib/redis exports a null-shaped object; calling
  // .ping() on it throws synchronously. Treat that as a degraded check.
  const r = redis as { ping?: () => Promise<string> } | null;
  if (!r || typeof r.ping !== "function") {
    throw new Error("redis client not configured");
  }
  const reply = await r.ping();
  if (reply !== "PONG") throw new Error(`redis ping returned ${reply}`);
}

/**
 * Deep health check — probes every dependency Cloud Run's readiness gate
 * actually cares about (Mongo + Redis). Each probe is bounded at 3s and
 * returns its latency so a slow dep stands out from a dead one. Returns
 * 503 if any check fails; 200 only when all are healthy.
 *
 * The shallow `/api/health` route stays for liveness probes (no DB
 * round-trip, fast 200). Point readiness probes at this one.
 */
export async function GET() {
  const checks = await Promise.all([
    withTimeout("mongo", pingMongo()),
    withTimeout("redis", pingRedis()),
  ]);

  const allOk = checks.every((c) => c.ok);
  if (!allOk) {
    const failing = checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.error}`).join(", ");
    serverLogger.warn(`[health/deep] dependency check failed: ${failing}`);
  }

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
