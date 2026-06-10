/**
 * Tests for `app/api/admin/hosting/change-package/route.ts` (slice
 * 7gu, part 1). Admin changes a customer's DirectAdmin package.
 * The interesting pin is the **typed-outcome dispatch** — the DA
 * anti-corruption layer returns one of 5 outcome kinds, each
 * mapped to a distinct HTTP response. A regression that collapses
 * the cases would hide upstream signal from the admin UI.
 *
 * Pins:
 *  - Admin gate via isAdmin → 403 FORBIDDEN 'Admin access
 *    required' (matches 7gq users-no-hosting style)
 *  - zod body schema: username trim+1-100, newPackage trim+1-100;
 *    both required
 *  - Typed-outcome dispatch (5 branches):
 *    - kind: 'changed' → 200 with `<username>` and `<newPackage>`
 *      interpolated in the message
 *    - kind: 'user_not_found' → 404 USER_NOT_FOUND
 *    - kind: 'package_not_found' → 404 PACKAGE_NOT_FOUND
 *    - kind: 'da_unreachable' → 503 DA_UNREACHABLE (NOT 500 —
 *      distinguishes upstream outage from logic bug; matches the
 *      slice 7g6 / 7gc DA convention)
 *    - kind: 'hard_failure' → 500 PACKAGE_CHANGE_FAILED with
 *      outcome.reason surfaced (admin needs the real reason)
 *  - Outer catch → 500 PACKAGE_CHANGE_FAILED with err.message
 *    surfaced (current source behaviour — pinned alongside the
 *    7gr/7gt error-leak family for the coordinated hardening pass)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const changePackage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  changePackage,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/hosting/change-package/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/admin/hosting/change-package",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

const validBody = { username: "alice_da", newPackage: "pro_50gb" };

beforeEach(() => {
  isAdmin.mockReset();
  changePackage.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 403 FORBIDDEN with 'Admin access required'; NO DA call", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(body.error).toContain("Admin access required");
    expect(changePackage).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing username → 400 VALIDATION_ERROR", async () => {
    isAdmin.mockResolvedValueOnce(true);
    const res = await POST(makeReq({ newPackage: "pro" }));
    expect(res.status).toBe(400);
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("missing newPackage → 400", async () => {
    isAdmin.mockResolvedValueOnce(true);
    const res = await POST(makeReq({ username: "alice_da" }));
    expect(res.status).toBe(400);
  });

  it("oversize fields → 400", async () => {
    isAdmin.mockResolvedValueOnce(true);
    const res = await POST(
      makeReq({ username: "x".repeat(101), newPackage: "pro" })
    );
    expect(res.status).toBe(400);
  });

  it("trim normalises whitespace before reaching DA service", async () => {
    isAdmin.mockResolvedValueOnce(true);
    changePackage.mockResolvedValueOnce({ kind: "changed" });
    await POST(
      makeReq({ username: "  alice_da  ", newPackage: "  pro  " })
    );
    expect(changePackage).toHaveBeenCalledWith({
      username: "alice_da",
      newPackage: "pro",
    });
  });
});

describe("Typed-outcome dispatch — 5 branches", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
  });

  it("'changed' → 200 with username + newPackage interpolated", async () => {
    changePackage.mockResolvedValueOnce({ kind: "changed" });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe(
      "Package for user 'alice_da' changed to 'pro_50gb' successfully."
    );
  });

  it("'user_not_found' → 404 USER_NOT_FOUND with username in message", async () => {
    changePackage.mockResolvedValueOnce({ kind: "user_not_found" });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("USER_NOT_FOUND");
    expect(body.error).toContain("alice_da");
  });

  it("'package_not_found' → 404 PACKAGE_NOT_FOUND with package name in message", async () => {
    changePackage.mockResolvedValueOnce({ kind: "package_not_found" });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("PACKAGE_NOT_FOUND");
    expect(body.error).toContain("pro_50gb");
  });

  it("'da_unreachable' → 503 DA_UNREACHABLE (NOT 500 — upstream-outage signal)", async () => {
    changePackage.mockResolvedValueOnce({ kind: "da_unreachable" });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("DA_UNREACHABLE");
    expect(body.error).toContain("temporarily unreachable");
  });

  it("'hard_failure' → 500 PACKAGE_CHANGE_FAILED with outcome.reason surfaced", async () => {
    changePackage.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "Package config corrupted; DA returned 500",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PACKAGE_CHANGE_FAILED");
    expect(body.error).toBe("Package config corrupted; DA returned 500");
  });
});

describe("Outer catch — error.message leaked (matches 7gr/7gt family)", () => {
  it("Error throw → 500 PACKAGE_CHANGE_FAILED with raw err.message (pinned alongside the family hardening signal)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    changePackage.mockRejectedValueOnce(
      new Error("Mongo: shard-2 connection refused")
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PACKAGE_CHANGE_FAILED");
    expect(body.error).toBe("Mongo: shard-2 connection refused");
  });

  it("non-Error throw → 'Failed to change package' fallback", async () => {
    isAdmin.mockResolvedValueOnce(true);
    changePackage.mockRejectedValueOnce("string-throw");
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to change package");
  });
});
