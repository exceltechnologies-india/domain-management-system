/**
 * Tests for `app/api/admin/hosting/packages/defaults/route.ts` (slice 7i0, part 1).
 *
 * Admin "bootstrap the default hosting packages" endpoint. Creates
 * the starter/standard/plus plans in both DirectAdmin AND the local
 * HostingPlan collection.
 *
 * Threat model:
 *  - **Non-idempotent re-run blow-up**: a refactor that drops the
 *    "already exists in DB" skip would create duplicate HostingPlan
 *    rows on every admin re-click. Pinned.
 *  - **DA-DB drift on partial failure**: if a refactor skips the
 *    DA "already exists" recovery branch and rethrows, the DB
 *    create never fires — but a previous successful DA call may
 *    have left the package server-side. Pinned: DA "already exists"
 *    → proceed to DB sync (NOT rethrow).
 *  - **Mass-bootstrap failure presented as success**: a refactor
 *    that returned 200 even when ALL packages failed would silently
 *    leave the system unconfigured. Pinned: 500 when no successes
 *    + errors present.
 *
 * Other pins:
 *  - Admin gate → 403 FORBIDDEN
 *  - quotaMB ≤ 0 → "unlimited" string for DA; 0 for DB schema
 *  - DA error other than "already exists" → rethrown, counted as
 *    error for that plan (NOT total failure)
 *  - Per-plan try/catch isolation: one plan blow-up doesn't kill
 *    others
 *  - 3-outcome dispatch: total-fail → 500; mixed → 200 with
 *    "with some errors" message; clean → 200 with "complete" message
 *  - Outer catch → 500 DEFAULT_PACKAGES_FAILED
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const createPackage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { createPackage },
}));

const findOne = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: { findOne, create },
}));

vi.mock("@/lib/mongoose", () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

const HOSTING_PLANS = vi.hoisted(() => ({
  starter: {
    serverPackage: "Starter",
    name: "Starter Plan",
    description: "Entry-level hosting",
    price: 99,
    currency: "INR",
    features: ["1 website", "5 GB storage"],
    quotaMB: 5120,
    bandwidthMB: 51200,
  },
  standard: {
    serverPackage: "Standard",
    name: "Standard Plan",
    description: "Mid-tier hosting",
    price: 299,
    currency: "INR",
    features: ["5 websites", "20 GB storage"],
    quotaMB: 20480,
    bandwidthMB: 204800,
  },
  unlimited_plan: {
    serverPackage: "Unlimited",
    name: "Unlimited Plan",
    description: "Unlimited everything",
    price: 999,
    currency: "INR",
    features: ["Unlimited"],
    quotaMB: -1, // sentinel for unlimited
    bandwidthMB: 0,
  },
}));
vi.mock("@/config/hosting-plans", () => ({ HOSTING_PLANS }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/hosting/packages/defaults/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/hosting/packages/defaults",
    { method: "POST" }
  );
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  createPackage.mockReset().mockResolvedValue(undefined);
  findOne.mockReset();
  create.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 403 FORBIDDEN; NO DA / DB work", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(createPackage).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("Idempotency — skip-if-exists", () => {
  it("plan already in DB → skipped; NO createPackage; NO create", async () => {
    findOne.mockResolvedValue({ planId: "exists" });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toHaveLength(3);
    expect(
      body.data.results.every((r: { status: string }) => r.status === "skipped")
    ).toBe(true);
    expect(createPackage).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("Quota/bandwidth boundary normalisation (≤0 → unlimited)", () => {
  beforeEach(() => {
    findOne.mockResolvedValue(null);
    create.mockImplementation(async (data) => data);
  });

  it("quotaMB=5120 (positive) → '5120' string for DA + 5120 int for DB", async () => {
    await POST(makeReq());
    const starterCall = createPackage.mock.calls.find(
      (c) => c[0] === "Starter"
    );
    expect(starterCall![1]).toEqual(
      expect.objectContaining({
        quota: "5120",
        bandwidth: "51200",
      })
    );
    const starterCreate = create.mock.calls.find(
      (c) => c[0].planId === "Starter"
    );
    expect(starterCreate![0].quota).toBe(5120);
    expect(starterCreate![0].bandwidth).toBe(51200);
  });

  it("quotaMB=-1 → 'unlimited' string for DA + 0 int for DB schema", async () => {
    await POST(makeReq());
    const unlimitedCall = createPackage.mock.calls.find(
      (c) => c[0] === "Unlimited"
    );
    expect(unlimitedCall![1].quota).toBe("unlimited");
    const unlimitedCreate = create.mock.calls.find(
      (c) => c[0].planId === "Unlimited"
    );
    expect(unlimitedCreate![0].quota).toBe(0);
  });

  it("bandwidthMB=0 → 'unlimited' for DA + 0 for DB (boundary inclusive)", async () => {
    await POST(makeReq());
    const unlimitedCall = createPackage.mock.calls.find(
      (c) => c[0] === "Unlimited"
    );
    expect(unlimitedCall![1].bandwidth).toBe("unlimited");
    const unlimitedCreate = create.mock.calls.find(
      (c) => c[0].planId === "Unlimited"
    );
    expect(unlimitedCreate![0].bandwidth).toBe(0);
  });
});

describe("DA 'already exists' recovery branch", () => {
  beforeEach(() => {
    findOne.mockResolvedValue(null);
    create.mockImplementation(async (data) => data);
  });

  it("DA 'already exists' error → proceed to DB sync (NOT rethrow)", async () => {
    createPackage.mockImplementation(async (pkgName: string) => {
      if (pkgName === "Standard") {
        throw new Error("Package Standard already exists on the server");
      }
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Standard still created in DB despite DA "already exists"
    const standardResult = body.data.results.find(
      (r: { name: string }) => r.name === "Standard"
    );
    expect(standardResult.status).toBe("created");
    expect(body.data.errors).toEqual([]);
  });

  it("DA error other than 'already exists' → counted as error for that plan; others still proceed", async () => {
    createPackage.mockImplementation(async (pkgName: string) => {
      if (pkgName === "Standard") {
        throw new Error("DA returned 500 — internal server error");
      }
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.errors).toHaveLength(1);
    expect(body.data.errors[0].name).toBe("Standard");
    // Other plans still created
    expect(body.data.results.length).toBeGreaterThan(0);
  });
});

describe("Per-plan isolation", () => {
  beforeEach(() => {
    findOne.mockResolvedValue(null);
  });

  it("one plan's DB create throw → other plans still complete", async () => {
    create.mockImplementation(async (data: { planId: string }) => {
      if (data.planId === "Starter") {
        throw new Error("Mongo blip on Starter");
      }
      return data;
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.errors).toHaveLength(1);
    expect(body.data.errors[0].name).toBe("Starter");
    // Other 2 plans created
    expect(
      body.data.results.filter(
        (r: { status: string }) => r.status === "created"
      )
    ).toHaveLength(2);
  });
});

describe("3-outcome dispatch", () => {
  beforeEach(() => {
    findOne.mockResolvedValue(null);
  });

  it("clean run (all created) → 200 'complete'", async () => {
    create.mockImplementation(async (data) => data);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("complete");
    expect(body.data.errors).toEqual([]);
  });

  it("partial success (some errors) → 200 with 'with some errors' message", async () => {
    create.mockImplementation(async (data: { planId: string }) => {
      if (data.planId === "Standard") throw new Error("blip");
      return data;
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("with some errors");
  });

  it("**total failure (zero successes + errors) → 500 with failure message**", async () => {
    create.mockRejectedValue(new Error("Mongo cluster down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message.toLowerCase()).toContain("failed");
    expect(body.data.errors.length).toBeGreaterThan(0);
  });

  it("skipped-only run (all already exist) → 200 'complete' (skipped counts as success)", async () => {
    findOne.mockResolvedValue({ planId: "exists" });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe("Outer catch", () => {
  it("isAdmin throw → 500 DEFAULT_PACKAGES_FAILED", async () => {
    isAdmin.mockRejectedValueOnce(new Error("Mongo auth down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DEFAULT_PACKAGES_FAILED");
  });
});
