/**
 * Tests for `app/api/health/route.ts` (slice 7gm, part 1). Cloud
 * Run's liveness/readiness probe target. The contract is
 * deliberately minimal — anything heavier (auth, DB round-trip)
 * would couple our liveness signal to whatever's slowest in the
 * stack and cause spurious restarts.
 *
 * Pins:
 *  - GET responds with 200 status (NOT 204, NOT 503)
 *  - Body shape: { status: 'ok', timestamp: <ISO string> }
 *  - timestamp is a parseable ISO 8601 string
 *  - No auth header required
 *  - No DB access (no mocks set up; if the handler reached the
 *    DB this test would crash)
 */
import { describe, it, expect } from "vitest";

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextResponse }));

import { vi } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health — Cloud Run liveness probe", () => {
  it("returns 200 with { status: 'ok' }", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("includes parseable ISO timestamp", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.timestamp).toEqual(expect.any(String));
    const parsed = new Date(body.timestamp);
    expect(parsed.toString()).not.toBe("Invalid Date");
  });

  it("no auth + no DB — handler runs to completion even without any setup", async () => {
    // No mocks for auth or DB. If the handler reached either, this would
    // crash. This test pins the "stays fast, no upstream deps" contract.
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
