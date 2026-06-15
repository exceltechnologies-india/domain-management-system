/**
 * Tests for `app/api/admin/domains/dns/route.ts` (slice 7i9, part 2).
 *
 * Admin-facing DNS record CRUD. Three handlers (GET / POST / DELETE)
 * — NO PUT (admin can delete + re-add to "update", and the design
 * deliberately omits the modify path for audit clarity).
 *
 * Threat model:
 *  - **Admin gate per-method**: `getAdminFromRequest` first. Non-admin
 *    → 403 (NOT 401 — anti-info-leak). No subsequent work fires.
 *  - **No IDOR scoping by design**: `findOrderByDomain(domainName)` —
 *    admin can reach any customer's domain. Pinned with single-arg
 *    assertion.
 *  - **`resellerClubCustomerId` precondition**: GET + POST both check
 *    for a populated customer ID on the matched domain — 404 with
 *    "ResellerClub Customer ID not found for this domain" when
 *    absent. DELETE also checks this.
 *  - **RC typed outcomes** for `rcGetDNSRecords`: 'found' → 200,
 *    'not_found' → 404 "Domain not found in ResellerClub" (distinct
 *    body from the local 404), 'hard_failure' → 500 with reason.
 *  - **POST + DELETE recordId fallback**: result.data.recordid OR
 *    .recordId (RC is inconsistent across endpoints — pinned).
 *  - **DELETE param source**: domainName + recordId from query;
 *    recordData from body via `validatedBody(adminDnsDeleteSchema)`.
 *  - **All outer catches** → 500 'Internal server error' generic
 *    (no leak of Mongo / RC / admin-auth error messages).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z as realZ } from "zod";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const findOrderByDomain = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomain,
  findOrderDomain,
}));

const rcGetDNSRecords = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  getDNSRecords: rcGetDNSRecords,
}));

const addDNSRecord = vi.hoisted(() => vi.fn());
const deleteDNSRecord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { addDNSRecord, deleteDNSRecord },
}));

// Mock @/lib/api-validation, preserving real `z` so the inline
// schemas at the top of route.ts (built at module evaluation) are
// real. validatedBody is replaced with a small fake that just
// runs the supplied real-zod schema against the parsed body.
vi.mock("@/lib/api-validation", async () => {
  const { z } = await import("zod");
  const { NextResponse } = await import("next/server");
  return {
    z,
    validatedBody: async (req: Request, schema: import("zod").ZodSchema<unknown>) => {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return {
          ok: false,
          response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }),
        };
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: "Validation failed", details: parsed.error.flatten() },
            { status: 400 }
          ),
        };
      }
      return { ok: true, data: parsed.data };
    },
  };
});

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST, DELETE } from "@/app/api/admin/domains/dns/route";

// ── helpers ──────────────────────────────────────────────────────────
function makeReq(
  method: "GET" | "POST" | "DELETE",
  opts: { query?: Record<string, string>; body?: unknown } = {}
) {
  const url = new URL("https://example.com/api/admin/domains/dns");
  for (const [k, v] of Object.entries(opts.query || {})) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const admin = { _id: "A1", email: "admin@x.com", role: "admin" };
const validRecord = { type: "A", name: "@", value: "1.2.3.4", ttl: 300 };

// Sanity for the inline zod schemas — keep tests immune to schema drift.
void realZ;

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  findOrderByDomain.mockReset();
  findOrderDomain.mockReset();
  rcGetDNSRecords.mockReset();
  addDNSRecord.mockReset();
  deleteDNSRecord.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// GET
// ═══════════════════════════════════════════════════════════════════
describe("GET — admin gate FIRST", () => {
  it("no admin → 403 'Admin access required' (NOT 401 — anti-info-leak); NO DB lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Admin access required");
    expect(findOrderByDomain).not.toHaveBeenCalled();
    expect(rcGetDNSRecords).not.toHaveBeenCalled();
  });

  it("admin present → proceeds past gate", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    rcGetDNSRecords.mockResolvedValueOnce({ kind: "found", records: [] });
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(200);
  });
});

describe("GET — input validation", () => {
  it("missing domainName → 400 'Domain name is required'; NO DB lookup", async () => {
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Domain name is required");
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });

  it("empty string domainName → 400 (falsy guard)", async () => {
    const res = await GET(makeReq("GET", { query: { domainName: "" } }));
    expect(res.status).toBe(400);
  });
});

describe("GET — no IDOR scoping (admin can fetch any domain)", () => {
  it("findOrderByDomain called with just (domainName) — pinned single-arg", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    rcGetDNSRecords.mockResolvedValueOnce({ kind: "found", records: [] });
    await GET(makeReq("GET", { query: { domainName: "anycustomer.com" } }));
    expect(findOrderByDomain).toHaveBeenCalledWith("anycustomer.com");
    expect(findOrderByDomain).not.toHaveBeenCalledWith("anycustomer.com", expect.anything());
  });

  it("domain not in any order → 404 'Domain not found'", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET", { query: { domainName: "unknown.com" } }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found");
    expect(rcGetDNSRecords).not.toHaveBeenCalled();
  });
});

describe("GET — resellerClubCustomerId precondition", () => {
  it("missing customerId → 404 'ResellerClub Customer ID not found for this domain'", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({});
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("ResellerClub Customer ID not found for this domain");
    expect(rcGetDNSRecords).not.toHaveBeenCalled();
  });

  it("findOrderDomain returns undefined → same 404", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce(undefined);
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(404);
  });
});

describe("GET — RC typed outcomes", () => {
  function setup(rcOutcome: unknown) {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    rcGetDNSRecords.mockResolvedValueOnce(rcOutcome);
  }

  it("'found' → 200 with success + domainName + records echo", async () => {
    setup({
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

  it("'not_found' → 404 'Domain not found in ResellerClub' (DISTINCT from local-DB 404 body)", async () => {
    setup({ kind: "not_found", reason: "Not under RC management" });
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found in ResellerClub");
    // distinct from local 'Domain not found' so admin can disambiguate
    expect(body.error).not.toBe("Domain not found");
  });

  it("'hard_failure' → 500 with RC reason surfaced (admin gets the raw upstream message for debugging)", async () => {
    setup({ kind: "hard_failure", reason: "RC connection refused" });
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("RC connection refused");
  });

  it("RC called with (domainName, customerId)", async () => {
    setup({ kind: "found", records: [] });
    await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(rcGetDNSRecords).toHaveBeenCalledWith({
      domainName: "alice.com",
      customerId: 42,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST
// ═══════════════════════════════════════════════════════════════════
describe("POST — admin gate FIRST", () => {
  it("no admin → 403 'Admin access required'; NO body parse, NO DB lookup, NO RC call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(403);
    expect(findOrderByDomain).not.toHaveBeenCalled();
    expect(addDNSRecord).not.toHaveBeenCalled();
  });
});

describe("POST — schema validation via validatedBody", () => {
  it("missing recordData → 400", async () => {
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com" } })
    );
    expect(res.status).toBe(400);
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });

  it("domainName below 3 chars → 400", async () => {
    const res = await POST(
      makeReq("POST", { body: { domainName: "ab", recordData: validRecord } })
    );
    expect(res.status).toBe(400);
  });

  it("domainName trimmed + lowercased before validation (zod transform)", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    addDNSRecord.mockResolvedValueOnce({ status: "success", data: { recordid: "R1" } });
    await POST(
      makeReq("POST", { body: { domainName: "  Alice.Com  ", recordData: validRecord } })
    );
    expect(findOrderByDomain).toHaveBeenCalledWith("alice.com");
  });

  it("recordData accepts passthrough fields (priority, etc.) — admin can add MX with priority", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    addDNSRecord.mockResolvedValueOnce({ status: "success", data: { recordid: "R1" } });
    const mxRecord = { type: "MX", name: "@", value: "mail.alice.com", ttl: 300, priority: 10 };
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: mxRecord } })
    );
    expect(res.status).toBe(200);
    expect(addDNSRecord).toHaveBeenCalledWith(
      "alice.com",
      42,
      expect.objectContaining({ priority: 10 })
    );
  });
});

describe("POST — no IDOR + ownership", () => {
  it("findOrderByDomain single-arg (no admin._id scope)", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    await POST(
      makeReq("POST", { body: { domainName: "anycustomer.com", recordData: validRecord } })
    );
    expect(findOrderByDomain).toHaveBeenCalledWith("anycustomer.com");
    expect(findOrderByDomain).not.toHaveBeenCalledWith("anycustomer.com", expect.anything());
  });

  it("domain not found → 404 'Domain not found'", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { body: { domainName: "ghost.com", recordData: validRecord } })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found");
  });

  it("missing customerId → 404 'ResellerClub Customer ID not found for this domain'", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({});
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(404);
    expect(addDNSRecord).not.toHaveBeenCalled();
  });
});

describe("POST — RC dispatch + recordId fallback", () => {
  function setup() {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
  }

  it("success → 200 with recordId from .recordid", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "success", data: { recordid: "REC-7" } });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.recordId).toBe("REC-7");
  });

  it("recordId fallback to .recordId (camelCase) when .recordid missing", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "success", data: { recordId: "REC-8" } });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    const body = await res.json();
    expect(body.recordId).toBe("REC-8");
  });

  it("non-success status → 500 with RC message", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "error", message: "RC payload rejected" });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("RC payload rejected");
  });

  it("non-success status with no message → fallback 'Failed to add DNS record'", async () => {
    setup();
    addDNSRecord.mockResolvedValueOnce({ status: "error" });
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to add DNS record");
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════
describe("DELETE — admin gate FIRST", () => {
  it("no admin → 403; NO body parse, NO DB lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(403);
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });
});

describe("DELETE — mixed param source (query for ids, body for record)", () => {
  it("missing query.domainName → 400 'Domain name and record ID are required'", async () => {
    const res = await DELETE(
      makeReq("DELETE", {
        query: { recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Domain name and record ID are required");
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });

  it("missing query.recordId → 400", async () => {
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(400);
  });

  it("recordData (body) validation: missing → 400 via validatedBody", async () => {
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: {},
      })
    );
    expect(res.status).toBe(400);
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });

  it("happy path: deleteDNSRecord called with (query.domainName, query.recordId, body.recordData)", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    deleteDNSRecord.mockResolvedValueOnce({ status: "success" });
    await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(deleteDNSRecord).toHaveBeenCalledWith("alice.com", "R7", validRecord);
  });
});

describe("DELETE — ownership + RC dispatch", () => {
  function setup() {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
  }

  it("domain not in DB → 404 'Domain not found'", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "ghost.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(404);
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it("missing customerId → 404 'ResellerClub Customer ID not found for this domain'", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({});
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(404);
    expect(deleteDNSRecord).not.toHaveBeenCalled();
  });

  it("success → 200 'DNS record deleted successfully'", async () => {
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
    expect(body.success).toBe(true);
    expect(body.message).toBe("DNS record deleted successfully");
  });

  it("RC non-success → 500 with RC message", async () => {
    setup();
    deleteDNSRecord.mockResolvedValueOnce({ status: "error", message: "RC delete rejected" });
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("RC delete rejected");
  });

  it("RC non-success with no message → fallback 'Failed to delete DNS record'", async () => {
    setup();
    deleteDNSRecord.mockResolvedValueOnce({ status: "error" });
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to delete DNS record");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Outer catches — generic 500 with no leak
// ═══════════════════════════════════════════════════════════════════
describe("Outer catches — 500 'Internal server error' generic per method", () => {
  it("GET: findOrderByDomain throw → 500 generic (NO leak of Mongo error)", async () => {
    findOrderByDomain.mockRejectedValueOnce(
      new Error("Mongo error: replicaset secret-host-leak-A")
    );
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("secret-host-leak-A");
  });

  it("POST: addDNSRecord throw → 500 generic (NO leak)", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    addDNSRecord.mockRejectedValueOnce(new Error("RC blowup: rc_LEAK_MARKER"));
    const res = await POST(
      makeReq("POST", { body: { domainName: "alice.com", recordData: validRecord } })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("rc_LEAK_MARKER");
  });

  it("DELETE: deleteDNSRecord throw → 500 generic (NO leak)", async () => {
    findOrderByDomain.mockResolvedValueOnce({});
    findOrderDomain.mockReturnValueOnce({ resellerClubCustomerId: 42 });
    deleteDNSRecord.mockRejectedValueOnce(new Error("RC blowup: rc_DEL_LEAK_X"));
    const res = await DELETE(
      makeReq("DELETE", {
        query: { domainName: "alice.com", recordId: "R7" },
        body: { recordData: validRecord },
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("rc_DEL_LEAK_X");
  });

  it("admin gate throw → 500 generic", async () => {
    getAdminFromRequest.mockRejectedValueOnce(
      new Error("Admin lookup blowup: admin_LEAK_MARKER")
    );
    const res = await GET(makeReq("GET", { query: { domainName: "alice.com" } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("admin_LEAK_MARKER");
  });
});
