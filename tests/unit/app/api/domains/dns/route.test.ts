/**
 * Tests for `app/api/domains/dns/route.ts` (slice 7i9, part 1).
 *
 * Customer-facing DNS record CRUD. Four handlers (GET / POST / PUT /
 * DELETE) over a customer's own domain's DNS records via ResellerClub.
 *
 * Threat model:
 *  - **IDOR**: every method calls `findOrderByDomainForUser(user._id,
 *    domainName)` so a customer cannot read or mutate another
 *    customer's DNS. Pinned per-method.
 *  - **CSRF**: POST / PUT / DELETE all run a CSRF check FIRST (even
 *    before auth resolution). GET intentionally skips CSRF since it's
 *    a safe-method idempotent read.
 *  - **404-vs-403 asymmetry** (pinned): GET + POST return **404
 *    'Domain not found'** when the user doesn't own the domain
 *    (read-side: ambiguous, prevents domain-enumeration). PUT +
 *    DELETE return **403 'Unauthorized'** when the user doesn't own
 *    the domain (mutation-side: explicit denial, surface signal for
 *    audit). Don't unify these — they communicate different things.
 *  - **`resellerClubCustomerId` precondition**: GET + POST require a
 *    populated `domain.resellerClubCustomerId` and 404 with "DNS
 *    management not active" / "Domain configuration missing" when
 *    absent. PUT + DELETE skip this check (they pass through to RC
 *    directly with the domainName).
 *  - **RC typed outcomes** for `rcGetDNSRecords`: 'found' → 200 with
 *    records, 'not_found' → 404 PROVISIONER_ERROR, 'hard_failure' →
 *    500 PROVISIONER_ERROR.
 *  - **DELETE mixed param source** pinned: domainName + recordId
 *    pulled from query, recordData from body, then re-validated as
 *    one composite object via deleteSchema.
 *  - All outer catches → 500 SERVER_ERROR generic (no upstream leak).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z as realZ } from "zod";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const validateCSRF = vi.hoisted(() => vi.fn());
vi.mock("@/lib/security", () => ({
  SecurityValidator: { validateCSRF },
}));

// Use REAL zod schemas inside the Schemas mock so the route's
// `z.object({ domainName: Schemas.domainName, ... })` composition
// still parses correctly.
vi.mock("@/lib/validation", async () => {
  const { z } = await import("zod");
  return {
    Schemas: {
      domainName: z
        .string()
        .regex(
          /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i,
          "Invalid domain name"
        ),
      dnsRecord: z.object({
        type: z.enum(["A", "AAAA", "MX", "CNAME", "TXT", "NS", "SRV"]),
        name: z.string().max(255).trim(),
        value: z.string().min(1).trim(),
        ttl: z.number().int().min(60).max(86400),
        priority: z.number().int().min(0).max(65535).optional(),
      }),
    },
  };
});
void realZ;

const findOrderByDomainForUser = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomainForUser,
  findOrderDomain,
}));

const rcGetDNSRecords = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  getDNSRecords: rcGetDNSRecords,
}));

const addDNSRecord = vi.hoisted(() => vi.fn());
const updateDNSRecord = vi.hoisted(() => vi.fn());
const deleteDNSRecord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { addDNSRecord, updateDNSRecord, deleteDNSRecord },
}));

const secureJsonResponse = vi.hoisted(() =>
  vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
);
const secureErrorResponse = vi.hoisted(() =>
  vi.fn(
    (message: string, status: number, code: string) =>
      new Response(JSON.stringify({ error: message, code }), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  )
);
vi.mock("@/lib/api-response-wrapper", () => ({
  secureJsonResponse,
  secureErrorResponse,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest }));

import { GET, POST, PUT, DELETE } from "@/app/api/domains/dns/route";

// ── helpers ──────────────────────────────────────────────────────────
function makeReq(
  method: "GET" | "POST" | "PUT" | "DELETE",
  opts: { query?: Record<string, string>; body?: unknown } = {}
) {
  const url = new URL("https://example.com/api/domains/dns");
  for (const [k, v] of Object.entries(opts.query || {})) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const user = { _id: "U1", email: "u@x.com" };
const validRecord = { type: "A", name: "@", value: "1.2.3.4", ttl: 300 };

// With real zod in the Schemas mock, these helpers are no-ops kept
// for call-site readability — bad inputs are now genuine invalid
// strings/objects against the real schemas.
function passDomain(_name = "alice.com") {}
function passRecord(_rec: unknown = validRecord) {}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  validateCSRF.mockReset().mockReturnValue({ isValid: true });
  findOrderByDomainForUser.mockReset();
  findOrderDomain.mockReset();
  rcGetDNSRecords.mockReset();
  addDNSRecord.mockReset();
  updateDNSRecord.mockReset();
  deleteDNSRecord.mockReset();
  secureJsonResponse.mockClear();
  secureErrorResponse.mockClear();
});

// ═══════════════════════════════════════════════════════════════════
// GET — read DNS records
// ═══════════════════════════════════════════════════════════════════
describe("GET — auth gate FIRST", () => {
  it("no user → 401 UNAUTHORIZED; NO schema parse, NO DB lookup, NO RC call", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(401);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Unauthorized",
      401,
      "UNAUTHORIZED"
    );
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
    expect(rcGetDNSRecords).not.toHaveBeenCalled();
  });
});

describe("GET — input validation", () => {
  it("invalid domain name (path-traversal probe) → 400 VALIDATION_ERROR; NO DB lookup, NO RC call", async () => {
    const res = await GET(makeReq("GET", { query: { domainName: "../etc/passwd" } }));
    expect(res.status).toBe(400);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Invalid domain name",
      400,
      "VALIDATION_ERROR"
    );
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
    expect(rcGetDNSRecords).not.toHaveBeenCalled();
  });

  it("missing domainName query param → 400 (null input fails the safeParse)", async () => {
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(400);
  });
});

describe("GET — IDOR scoping", () => {
  it("findOrderByDomainForUser called with (user._id, parsed domainName) — pinned anti-IDOR", async () => {
    passDomain("alice.com");
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "alice.com");
  });

  it("non-owner order → 404 NOT_FOUND with 'Domain not found or unauthorized' (anti-enumeration on read)", async () => {
    passDomain("hostile.com");
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET", { query: { domainName: "hostile.com" } }));
    expect(res.status).toBe(404);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Domain not found or unauthorized",
      404,
      "NOT_FOUND"
    );
    expect(rcGetDNSRecords).not.toHaveBeenCalled();
  });
});

describe("GET — resellerClubCustomerId precondition", () => {
  it("missing customerId on the matched domain → 404 'Domain configuration missing'", async () => {
    passDomain("alice.com");
    findOrderByDomainForUser.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({}); // no resellerClubCustomerId
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(404);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Domain configuration missing",
      404,
      "NOT_FOUND"
    );
    expect(rcGetDNSRecords).not.toHaveBeenCalled();
  });

  it("matched-but-no-domain-entry → 404 (findOrderDomain returns undefined)", async () => {
    passDomain("alice.com");
    findOrderByDomainForUser.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce(undefined);
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(404);
  });
});

describe("GET — RC typed outcomes", () => {
  function setupValidPath(rcOutcome: unknown) {
    passDomain("alice.com");
    findOrderByDomainForUser.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    rcGetDNSRecords.mockResolvedValueOnce(rcOutcome);
  }

  it("'found' → 200 with records", async () => {
    setupValidPath({
      kind: "found",
      records: [{ type: "A", name: "@", value: "1.2.3.4", ttl: 300 }],
    });
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.domainName).toBe("alice.com");
    expect(body.records).toHaveLength(1);
  });

  it("RC called with (domainName, customerId) — pinned arg shape", async () => {
    setupValidPath({ kind: "found", records: [] });
    await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(rcGetDNSRecords).toHaveBeenCalledWith({
      domainName: "alice.com",
      customerId: 42,
    });
  });

  it("'not_found' → 404 PROVISIONER_ERROR with RC reason", async () => {
    setupValidPath({ kind: "not_found", reason: "Domain not on RC" });
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(404);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Domain not on RC",
      404,
      "PROVISIONER_ERROR"
    );
  });

  it("'hard_failure' → 500 PROVISIONER_ERROR with RC reason", async () => {
    setupValidPath({ kind: "hard_failure", reason: "RC timeout" });
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "RC timeout",
      500,
      "PROVISIONER_ERROR"
    );
  });
});

describe("GET — outer catch", () => {
  it("findOrderByDomainForUser throw → 500 SERVER_ERROR generic", async () => {
    passDomain("alice.com");
    findOrderByDomainForUser.mockRejectedValueOnce(
      new Error("Mongo timeout: secret-leak-XYZ")
    );
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "DNS records fetch error",
      500,
      "SERVER_ERROR",
      expect.anything()
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST — add DNS record
// ═══════════════════════════════════════════════════════════════════
describe("POST — CSRF check FIRST", () => {
  it("CSRF fail → 403 CSRF_ERROR; NO auth call, NO DB lookup, NO RC call", async () => {
    validateCSRF.mockReturnValueOnce({ isValid: false, error: "CSRF token missing" });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(403);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "CSRF token missing",
      403,
      "CSRF_ERROR"
    );
    expect(getUserFromRequest).not.toHaveBeenCalled();
    expect(addDNSRecord).not.toHaveBeenCalled();
  });

  it("CSRF fail with no error string → falls back to 'CSRF Validation Failed'", async () => {
    validateCSRF.mockReturnValueOnce({ isValid: false });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(403);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "CSRF Validation Failed",
      403,
      "CSRF_ERROR"
    );
  });

  it("auth check fires AFTER CSRF; null user → 401 UNAUTHORIZED", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(401);
    expect(addDNSRecord).not.toHaveBeenCalled();
  });
});

describe("POST — schema validation", () => {
  it("invalid body (path-traversal domainName probe) → 400 VALIDATION_ERROR; NO DB lookup", async () => {
    const res = await POST(
      makeReq("POST", { body: { domainName: "../bad", recordData: validRecord } })
    );
    expect(res.status).toBe(400);
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
  });

  it("missing recordData → 400", async () => {
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com" } })
    );
    expect(res.status).toBe(400);
  });

  it("invalid record type (unsupported enum value) → 400", async () => {
    const res = await POST(
      makeReq("POST", {
        body: {
          domainName: "alice.com",
          recordData: { ...validRecord, type: "AXFR" },
        },
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST — IDOR + ownership", () => {
  it("findOrderByDomainForUser called with (user._id, domainName) — pinned anti-IDOR", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "alice.com");
  });

  it("non-owner → 404 NOT_FOUND 'Domain not found' (NOT 403 — pinned: read-side ambiguity)", async () => {
    passDomain("hostile.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { body: { domainName: "hostile.com", recordData: validRecord } })
    );
    expect(res.status).toBe(404);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Domain not found",
      404,
      "NOT_FOUND"
    );
  });

  it("missing resellerClubCustomerId → 404 'DNS management not active'", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({});
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(404);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "DNS management not active",
      404,
      "NOT_FOUND"
    );
    expect(addDNSRecord).not.toHaveBeenCalled();
  });
});

describe("POST — RC dispatch", () => {
  function setup() {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
  }

  it("addDNSRecord called with (domainName, customerId, recordData)", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "success", data: { recordid: "REC-7" } });
    await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(addDNSRecord).toHaveBeenCalledWith("alice.com", 42, validRecord);
  });

  it("success → 200 with recordId", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "success", data: { recordid: "REC-7" } });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recordId).toBe("REC-7");
  });

  it("RC error → 500 PROVISIONER_ERROR with RC message", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "error", message: "RC rejected MX priority" });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "RC rejected MX priority",
      500,
      "PROVISIONER_ERROR"
    );
  });

  it("RC error with no message → fallback 'Failed to add record'", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "error" });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Failed to add record",
      500,
      "PROVISIONER_ERROR"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// PUT — update DNS record
// ═══════════════════════════════════════════════════════════════════
describe("PUT — CSRF + auth gates", () => {
  it("CSRF fail → 403; NO mutation", async () => {
    validateCSRF.mockReturnValueOnce({ isValid: false, error: "Bad token" });
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordId: "R1", recordData: validRecord },
      })
    );
    expect(res.status).toBe(403);
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });

  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordId: "R1", recordData: validRecord },
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("PUT — anti-IDOR pinned to 403 (NOT 404 — mutation-side asymmetry)", () => {
  it("non-owner → 403 'Unauthorized modification attempt' (distinct from GET/POST 404)", async () => {
    passDomain("hostile.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "hostile.com", recordId: "R1", recordData: validRecord },
      })
    );
    expect(res.status).toBe(403);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Unauthorized modification attempt",
      403,
      "UNAUTHORIZED"
    );
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });

  it("findOrderByDomainForUser receives user._id (anti-IDOR scope)", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordId: "R1", recordData: validRecord },
      })
    );
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "alice.com");
  });

  it("PUT does NOT check resellerClubCustomerId (skipped — passes domainName to RC directly)", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    updateDNSRecord.mockResolvedValueOnce({ status: "success" });
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordId: "R1", recordData: validRecord },
      })
    );
    expect(res.status).toBe(200);
    expect(findOrderDomain).not.toHaveBeenCalled();
  });
});

describe("PUT — RC dispatch + schema", () => {
  it("invalid update body (missing recordId) → 400 VALIDATION_ERROR", async () => {
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordData: validRecord },
      })
    );
    expect(res.status).toBe(400);
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
  });

  it("updateDNSRecord called with (domainName, recordId, recordData)", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    updateDNSRecord.mockResolvedValueOnce({ status: "success" });
    await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordId: "R7", recordData: validRecord },
      })
    );
    expect(updateDNSRecord).toHaveBeenCalledWith("alice.com", "R7", validRecord);
  });

  it("RC error → 500 PROVISIONER_ERROR with message fallback 'Update failed'", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    updateDNSRecord.mockResolvedValueOnce({ status: "error" });
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordId: "R7", recordData: validRecord },
      })
    );
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Update failed",
      500,
      "PROVISIONER_ERROR"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE — delete DNS record
// ═══════════════════════════════════════════════════════════════════
describe("DELETE — mixed param source (query + body)", () => {
  it("domainName + recordId pulled from query string; recordData from body", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    deleteDNSRecord.mockResolvedValueOnce({ status: "success" });
    await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(deleteDNSRecord).toHaveBeenCalledWith("alice.com", "R7", validRecord);
  });

  it("CSRF fail → 403; NO mutation", async () => {
    validateCSRF.mockReturnValueOnce({ isValid: false, error: "Bad token" });
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(403);
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(401);
  });

  it("missing recordId in query → 400 VALIDATION_ERROR (deleteSchema requires non-empty recordId)", async () => {
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(400);
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
  });
});

describe("DELETE — anti-IDOR pinned to 403", () => {
  it("non-owner → 403 'Unauthorized deletion attempt' (mirror of PUT)", async () => {
    passDomain("hostile.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "hostile.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(403);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Unauthorized deletion attempt",
      403,
      "UNAUTHORIZED"
    );
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it("findOrderByDomainForUser scoped to user._id", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "alice.com");
  });
});

describe("DELETE — RC dispatch", () => {
  function setup() {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
  }

  it("RC success → 200", async () => {
    setup();
    deleteDNSRecord.mockResolvedValueOnce({ status: "success" });
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("DNS record deleted successfully");
  });

  it("RC error → 500 PROVISIONER_ERROR with message fallback 'Delete failed'", async () => {
    setup();
    deleteDNSRecord.mockResolvedValueOnce({ status: "error" });
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "Delete failed",
      500,
      "PROVISIONER_ERROR"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// 404-vs-403 asymmetry (final cross-method pin)
// ═══════════════════════════════════════════════════════════════════
describe("Method asymmetry — reads 404, mutations 403 (anti-enumeration vs explicit denial)", () => {
  it("GET non-owner → 404 NOT_FOUND", async () => {
    passDomain("x.com");
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET", { query: { domainName: "x.com" } }));
    expect(res.status).toBe(404);
  });

  it("POST non-owner → 404 NOT_FOUND", async () => {
    passDomain("x.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { body: { domainName: "x.com", recordData: validRecord } })
    );
    expect(res.status).toBe(404);
  });

  it("PUT non-owner → 403 UNAUTHORIZED (distinct)", async () => {
    passDomain("x.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "x.com", recordId: "R1", recordData: validRecord },
      })
    );
    expect(res.status).toBe(403);
  });

  it("DELETE non-owner → 403 UNAUTHORIZED (distinct)", async () => {
    passDomain("x.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "x.com", recordId: "R1" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Outer-catch generic 500 (per method)
// ═══════════════════════════════════════════════════════════════════
describe("Outer catches — 500 SERVER_ERROR generic per method", () => {
  it("POST: addDNSRecord throw → 500 'DNS update failed'", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    addDNSRecord.mockRejectedValueOnce(new Error("RC blowup: leak-A"));
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "DNS update failed",
      500,
      "SERVER_ERROR",
      expect.anything()
    );
  });

  it("PUT: updateDNSRecord throw → 500 'DNS update error'", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    updateDNSRecord.mockRejectedValueOnce(new Error("RC blowup"));
    const res = await PUT(
      makeReq("PUT", {
        body: { domainName: "alice.com", recordId: "R7", recordData: validRecord },
      })
    );
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "DNS update error",
      500,
      "SERVER_ERROR",
      expect.anything()
    );
  });

  it("DELETE: deleteDNSRecord throw → 500 'DNS deletion error'", async () => {
    passDomain("alice.com");
    passRecord();
    findOrderByDomainForUser.mockResolvedValueOnce({});
    deleteDNSRecord.mockRejectedValueOnce(new Error("RC blowup"));
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(500);
    expect(secureErrorResponse).toHaveBeenCalledWith(
      "DNS deletion error",
      500,
      "SERVER_ERROR",
      expect.anything()
    );
  });
});
