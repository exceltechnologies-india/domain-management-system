/**
 * Tests for `app/api/health/deep/route.ts` (slice 7hj, part 1).
 * Cloud Run **readiness** probe target. Pings every dependency
 * the app actually needs (Mongo + Redis) with a 3s timeout each
 * and reports per-dep latency.
 *
 * Distinct from the shallow /api/health (slice 7gm) which stays
 * lightweight for liveness — readiness gates point HERE.
 *
 * Pins:
 *  - **All checks run in parallel via Promise.all** — total
 *    latency is max(deps), not sum
 *  - **3-second timeout per check** (CHECK_TIMEOUT_MS=3000) —
 *    bounded so a wedged dep can't stall the probe
 *  - **Mongo probe**: connectDB + admin().ping(); throws if no
 *    admin
 *  - **Redis probe**: when REDIS_HOST unset, lib/redis exports a
 *    null-shaped object → 'redis client not configured' error
 *    captured. PONG check: any other reply throws.
 *  - **Response shape**: `{ status, timestamp, checks }` where
 *    checks is an array of `{ name, ok, latencyMs, error? }`
 *  - **Status code semantics**:
 *      - ALL ok → 200 with status:'ok'
 *      - ANY fail → 503 with status:'degraded' (Cloud Run pulls
 *        traffic on 503)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const adminPing = vi.hoisted(() => vi.fn());
const mongooseMock = vi.hoisted(() => ({
  connection: {
    db: {
      admin: () => ({ ping: adminPing }),
    },
  },
}));
vi.mock("mongoose", () => ({
  default: mongooseMock,
}));

const redisPing = vi.hoisted(() => vi.fn());
// Use a let so we can swap redis between configured / null between tests
const redisRef = vi.hoisted(() => ({ current: { ping: redisPing } as unknown }));
vi.mock("@/lib/redis", () => ({
  get redis() {
    return redisRef.current;
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextResponse }));

import { GET } from "@/app/api/health/deep/route";

beforeEach(() => {
  connectDB.mockReset().mockResolvedValue(undefined);
  adminPing.mockReset().mockResolvedValue({ ok: 1 });
  redisPing.mockReset().mockResolvedValue("PONG");
  redisRef.current = { ping: redisPing };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Happy path — all green", () => {
  it("Mongo + Redis both healthy → 200 with status:'ok' + checks array", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.checks).toHaveLength(2);
    expect(body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(body.checks.map((c: { name: string }) => c.name).sort()).toEqual([
      "mongo",
      "redis",
    ]);
  });

  it("each check carries a latencyMs number", async () => {
    const body = await (await GET()).json();
    body.checks.forEach((c: { latencyMs: number }) => {
      expect(typeof c.latencyMs).toBe("number");
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Mongo probe", () => {
  it("connectDB throws → mongo check ok:false with error message; overall 503", async () => {
    connectDB.mockRejectedValueOnce(new Error("Mongo: connection refused"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    const mongoCheck = body.checks.find(
      (c: { name: string }) => c.name === "mongo"
    );
    expect(mongoCheck.ok).toBe(false);
    expect(mongoCheck.error).toContain("Mongo: connection refused");
  });

  it("admin().ping() throws → mongo check ok:false", async () => {
    adminPing.mockRejectedValueOnce(new Error("ping rejected"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    const mongoCheck = body.checks.find(
      (c: { name: string }) => c.name === "mongo"
    );
    expect(mongoCheck.ok).toBe(false);
  });
});

describe("Redis probe", () => {
  it("REDIS_HOST unset (null-shaped redis client) → 'redis client not configured' error; 503", async () => {
    redisRef.current = null;
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    const redisCheck = body.checks.find(
      (c: { name: string }) => c.name === "redis"
    );
    expect(redisCheck.ok).toBe(false);
    expect(redisCheck.error).toContain("redis client not configured");
  });

  it("redis object exists but ping is not a function → 'not configured' error", async () => {
    redisRef.current = { ping: undefined };
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    const redisCheck = body.checks.find(
      (c: { name: string }) => c.name === "redis"
    );
    expect(redisCheck.error).toContain("redis client not configured");
  });

  it("redis ping returns NOT 'PONG' → 'redis ping returned X' error", async () => {
    redisPing.mockResolvedValueOnce("WRONG_REPLY");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    const redisCheck = body.checks.find(
      (c: { name: string }) => c.name === "redis"
    );
    expect(redisCheck.ok).toBe(false);
    expect(redisCheck.error).toContain("redis ping returned WRONG_REPLY");
  });

  it("redis ping throws → ok:false with error message", async () => {
    redisPing.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    const redisCheck = body.checks.find(
      (c: { name: string }) => c.name === "redis"
    );
    expect(redisCheck.error).toContain("ECONNREFUSED");
  });
});

describe("503 on partial failure", () => {
  it("Mongo ok + Redis fail → 503 status:'degraded' (one bad dep kills the probe)", async () => {
    redisPing.mockRejectedValueOnce(new Error("redis down"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.find((c: { name: string }) => c.name === "mongo").ok).toBe(true);
    expect(body.checks.find((c: { name: string }) => c.name === "redis").ok).toBe(false);
  });

  it("Mongo fail + Redis ok → 503", async () => {
    connectDB.mockRejectedValueOnce(new Error("mongo down"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.find((c: { name: string }) => c.name === "mongo").ok).toBe(false);
    expect(body.checks.find((c: { name: string }) => c.name === "redis").ok).toBe(true);
  });

  it("BOTH fail → 503 with both error messages surfaced", async () => {
    connectDB.mockRejectedValueOnce(new Error("mongo gone"));
    redisPing.mockRejectedValueOnce(new Error("redis gone"));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.every((c: { ok: boolean }) => !c.ok)).toBe(true);
    expect(
      body.checks.find((c: { name: string }) => c.name === "mongo").error
    ).toContain("mongo gone");
    expect(
      body.checks.find((c: { name: string }) => c.name === "redis").error
    ).toContain("redis gone");
  });
});

describe("Per-dep 3s timeout", () => {
  it("a hanging Mongo probe is killed at 3s → ok:false with 'timed out after 3000ms' error", async () => {
    // Make connectDB hang forever
    connectDB.mockImplementationOnce(() => new Promise(() => {}));

    vi.useFakeTimers();
    const promise = GET();
    // Advance past the 3s timeout
    await vi.advanceTimersByTimeAsync(3001);
    const res = await promise;

    expect(res.status).toBe(503);
    const body = await res.json();
    const mongoCheck = body.checks.find(
      (c: { name: string }) => c.name === "mongo"
    );
    expect(mongoCheck.ok).toBe(false);
    expect(mongoCheck.error).toContain("timed out after 3000ms");
  });
});
