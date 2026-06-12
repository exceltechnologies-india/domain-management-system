/**
 * Tests for `app/api/domains/booking-status/route.ts` (slice 7ho, part 2).
 *
 * Public (no-auth) domain booking-progress endpoint. The customer's
 * still-unauthed registration page polls this to render the live
 * progress widget between payment-redirect and account-creation.
 *
 * **PUBLIC NO-AUTH BY DESIGN** — pinned here so a refactor that adds
 * auth (intending to lock down "an admin route") doesn't accidentally
 * break the public progress widget. Anyone with the orderId+domainName
 * can read or write status; that's intentional, and the upstream
 * provisioners that POST here are trusted internal services.
 *
 * Threat model:
 *  - **Status injection**: `step` is a fixed 9-value enum — anything
 *    else is rejected before save. Pinned by zod enum.
 *  - **Status-mapping skew**: 3 of the 9 step names auto-flip the
 *    underlying `domains[i].status` ("registered" / "failed" /
 *    "processing"). A refactor renaming one of those steps would
 *    silently break the public dashboard. Pinned per-step.
 *  - **Message-size DoS**: `message` capped at 2000 chars; `progress`
 *    bounded to 0-100 integer.
 *
 * Other pins:
 *  - GET query: `.refine` rejects missing-both orderId+domainName
 *    with 400.
 *  - orderId WINS when both supplied (deterministic precedence).
 *  - GET response: success + orderId + status + domains + createdAt
 *    + updatedAt. orderId-only → full domains array.
 *  - GET populate hint: { path: 'userId', select: 'email firstName lastName' }
 *  - POST: order not found → 404; domain not in order → 404.
 *  - POST appends a bookingStatus row with a timestamp.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findOrderByDomain = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
const getOrderByOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomain,
  findOrderDomain,
  getOrderByOrderId,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/domains/booking-status/route";

function makeGet(qs: string) {
  const url = qs
    ? `https://example.com/api/domains/booking-status?${qs}`
    : "https://example.com/api/domains/booking-status";
  return new NextRequest(url, { method: "GET" });
}

function makePost(body: unknown) {
  return new NextRequest("https://example.com/api/domains/booking-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  findOrderByDomain.mockReset();
  findOrderDomain.mockReset();
  getOrderByOrderId.mockReset();
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET query schema", () => {
  it("neither orderId nor domainName → 400 (refine error)", async () => {
    const res = await GET(makeGet(""));
    expect(res.status).toBe(400);
    expect(getOrderByOrderId).not.toHaveBeenCalled();
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });

  it("domainName < 3 chars → 400", async () => {
    const res = await GET(makeGet("domainName=ab"));
    expect(res.status).toBe(400);
  });

  it("domainName trimmed+lower-cased before lookup", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    await GET(makeGet("domainName=%20EXAMPLE.COM%20"));
    expect(findOrderByDomain).toHaveBeenCalledWith(
      "example.com",
      expect.any(Object)
    );
  });
});

describe("GET order resolution precedence", () => {
  it("orderId WINS when both supplied (getOrderByOrderId called, findOrderByDomain NOT)", async () => {
    getOrderByOrderId.mockResolvedValueOnce(null);
    await GET(makeGet("orderId=ORD-1&domainName=x.com"));
    expect(getOrderByOrderId).toHaveBeenCalledWith(
      "ORD-1",
      expect.objectContaining({
        populate: { path: "userId", select: "email firstName lastName" },
      })
    );
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });

  it("domainName-only path uses findOrderByDomain with the same populate hint", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    await GET(makeGet("domainName=x.com"));
    expect(findOrderByDomain).toHaveBeenCalledWith(
      "x.com",
      expect.objectContaining({
        populate: { path: "userId", select: "email firstName lastName" },
      })
    );
  });

  it("order not found → 404", async () => {
    getOrderByOrderId.mockResolvedValueOnce(null);
    const res = await GET(makeGet("orderId=ORD-1"));
    expect(res.status).toBe(404);
  });
});

describe("GET response shape", () => {
  it("domainName specified → returns only that single domain via findOrderDomain", async () => {
    const order = {
      orderId: "ORD-1",
      status: "completed",
      createdAt: new Date("2026-06-12"),
      updatedAt: new Date("2026-06-12"),
      domains: [
        { domainName: "x.com", status: "registered" },
        { domainName: "y.com", status: "pending" },
      ],
    };
    getOrderByOrderId.mockResolvedValueOnce(order);
    findOrderDomain.mockReturnValueOnce(order.domains[0]);

    const res = await GET(makeGet("orderId=ORD-1&domainName=x.com"));
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        orderId: "ORD-1",
        status: "completed",
        domains: expect.objectContaining({
          domainName: "x.com",
          status: "registered",
        }),
      })
    );
  });

  it("orderId-only → returns FULL domains array", async () => {
    const order = {
      orderId: "ORD-1",
      status: "completed",
      createdAt: new Date(),
      updatedAt: new Date(),
      domains: [
        { domainName: "x.com", status: "registered" },
        { domainName: "y.com", status: "pending" },
      ],
    };
    getOrderByOrderId.mockResolvedValueOnce(order);
    const res = await GET(makeGet("orderId=ORD-1"));
    const body = await res.json();
    expect(body.domains).toHaveLength(2);
  });
});

// ─────────────────────────── POST ─────────────────────────────

describe("POST zod schema", () => {
  it("invalid step enum value → 400; getOrderByOrderId NOT called", async () => {
    const res = await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "BOGUS_STEP",
        message: "msg",
        progress: 10,
      })
    );
    expect(res.status).toBe(400);
    expect(getOrderByOrderId).not.toHaveBeenCalled();
  });

  it("message > 2000 chars → 400 (anti-DoS)", async () => {
    const res = await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "domain_registered",
        message: "x".repeat(2001),
        progress: 100,
      })
    );
    expect(res.status).toBe(400);
  });

  it("progress out of 0-100 range → 400", async () => {
    for (const bad of [-1, 101, 50.5]) {
      const res = await POST(
        makePost({
          orderId: "ORD-1",
          domainName: "x.com",
          step: "domain_registered",
          message: "msg",
          progress: bad,
        })
      );
      expect(res.status).toBe(400);
    }
  });

  it("domainName trimmed+lower-cased before lookup", async () => {
    getOrderByOrderId.mockResolvedValueOnce({ domains: [] });
    await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "  EXAMPLE.COM  ",
        step: "domain_registered",
        message: "msg",
        progress: 100,
      })
    );
    // The route looks up the lower-cased value in order.domains. Order
    // is empty here, so the route 404s — we only care that no zod 400
    // fired before that point.
    expect(getOrderByOrderId).toHaveBeenCalledWith("ORD-1");
  });
});

describe("POST lookup", () => {
  it("order null → 404", async () => {
    getOrderByOrderId.mockResolvedValueOnce(null);
    const res = await POST(
      makePost({
        orderId: "ORD-MISSING",
        domainName: "x.com",
        step: "domain_registered",
        message: "msg",
        progress: 100,
      })
    );
    expect(res.status).toBe(404);
  });

  it("domain not in order → 404 'Domain not found in order'", async () => {
    getOrderByOrderId.mockResolvedValueOnce({
      domains: [{ domainName: "other.com", status: "pending", bookingStatus: [] }],
      save: vi.fn(),
    });
    const res = await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "domain_registered",
        message: "msg",
        progress: 100,
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found in order");
  });
});

describe("POST status-mapping (THE KEY PIN)", () => {
  function setup() {
    const domain = {
      domainName: "x.com",
      status: "pending",
      bookingStatus: [] as Array<{
        step: string;
        message: string;
        progress: number;
        timestamp: Date;
      }>,
    };
    const order = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByOrderId.mockResolvedValueOnce(order);
    return { domain, order };
  }

  it("step='domain_registered' → domain.status = 'registered'", async () => {
    const { domain, order } = setup();
    await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "domain_registered",
        message: "ok",
        progress: 100,
      })
    );
    expect(domain.status).toBe("registered");
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  it("step='domain_failed' → domain.status = 'failed'", async () => {
    const { domain } = setup();
    await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "domain_failed",
        message: "nope",
        progress: 100,
      })
    );
    expect(domain.status).toBe("failed");
  });

  it("step='domain_registering' → domain.status = 'processing'", async () => {
    const { domain } = setup();
    await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "domain_registering",
        message: "go",
        progress: 50,
      })
    );
    expect(domain.status).toBe("processing");
  });

  it("non-mapping step (e.g. 'payment_verified') → domain.status UNCHANGED", async () => {
    const { domain } = setup();
    await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "payment_verified",
        message: "paid",
        progress: 20,
      })
    );
    expect(domain.status).toBe("pending"); // unchanged
  });

  it("ALL 9 enum values are accepted (no rejection at zod)", async () => {
    const allSteps = [
      "dns_activated",
      "payment_verified",
      "customer_created",
      "contact_created",
      "domain_registering",
      "domain_pending",
      "domain_registered",
      "domain_failed",
      "hosting_deferred",
    ];
    for (const step of allSteps) {
      const { order } = setup();
      const res = await POST(
        makePost({
          orderId: "ORD-1",
          domainName: "x.com",
          step,
          message: "m",
          progress: 50,
        })
      );
      expect(res.status).toBe(200);
      expect(order.save).toHaveBeenCalled();
    }
  });
});

describe("POST bookingStatus append (audit log)", () => {
  it("appends { step, message, timestamp, progress } to the domain's bookingStatus[]", async () => {
    const domain = {
      domainName: "x.com",
      status: "pending",
      bookingStatus: [{ step: "payment_verified", message: "old", progress: 20, timestamp: new Date(0) }],
    };
    const order = {
      domains: [domain],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getOrderByOrderId.mockResolvedValueOnce(order);

    await POST(
      makePost({
        orderId: "ORD-1",
        domainName: "x.com",
        step: "domain_registering",
        message: "go-go",
        progress: 50,
      })
    );
    expect(domain.bookingStatus).toHaveLength(2);
    const appended = domain.bookingStatus[1];
    expect(appended.step).toBe("domain_registering");
    expect(appended.message).toBe("go-go");
    expect(appended.progress).toBe(50);
    expect(appended.timestamp).toBeInstanceOf(Date);
  });
});
