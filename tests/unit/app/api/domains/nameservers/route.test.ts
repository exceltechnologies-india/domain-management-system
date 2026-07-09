/**
 * Tests for `app/api/domains/nameservers/route.ts` (rescan-4 slice 7g3).
 * Domain-nameservers GET (lookup) + POST (update) route. Focused on
 * security gates + happy-path RC API mode. The route also has a
 * fallback chain (RC → RDAP → DNS) and a custom-mode DNS-resolve
 * pre-check, but those paths route through `util.promisify(dns.X)`
 * which doesn't compose with vi.fn mocks (Node consults
 * `[util.promisify.custom]` on the target and synthesises a
 * never-resolving callback-style wrapper); excluded from this slice
 * by design so the tests run hermetically.
 *
 * Pins:
 *  - **GET auth gate**: no user → 401 (no RC call)
 *  - **GET param validation**: missing domainName → 400; invalid
 *    format → 400 (catches '../../etc/passwd', SQL-injection patterns)
 *  - **GET method='api' happy path** (RC returns data): registrar
 *    pinned to 'Anutech Digital'; nameserver cleanup applied (dedup
 *    after lowercase, filter invalid, drop 'name'-containing entries)
 *  - **Default-vs-custom detection (4 patterns)**: registrar-servers,
 *    orderbox-dns, resellerclub, publicdomainregistry → 'default';
 *    others (cloudflare, route53) → 'custom'
 *  - **GET response shape**: success + domainName + nameservers +
 *    count + method + whoisData + lastChecked
 *  - **POST auth gate**: no user → 401 (no domain lookup)
 *  - **POST schema validation**: domainName regex, method enum,
 *    custom REQUIRES ≥2 valid NSs, NS format
 *  - **POST ownership gate (3-tier)**: findOrderByDomainForUser null
 *    → 404; findOrderDomain null → 404; resellerClubOrderId missing
 *    → 404 'contact support'
 *  - **POST method='default'**: calls setDefaultNameservers; emits
 *    fixed pair ['ns1.registrar-servers.com', 'ns2.registrar-servers.com']
 *  - **POST RC failure → 502** (upstream gateway error)
 *  - **POST DB persistence**: Domain.updateOne fires; DB failure
 *    SWALLOWED (registrar already updated — non-fatal)
 *  - **POST outer catch** → 500 'Failed to update nameservers'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getNameservers = vi.hoisted(() => vi.fn());
const setDefaultNameservers = vi.hoisted(() => vi.fn());
const setCustomNameservers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: {
    getNameservers,
    setDefaultNameservers,
    setCustomNameservers,
  },
}));

const findOrderByDomainForUser = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomainForUser,
  findOrderDomain,
}));

const domainUpdateOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: { updateOne: domainUpdateOne },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/domains/nameservers/route";

// ── helpers ──────────────────────────────────────────────────────────
function makeGetReq(domainName?: string) {
  const url = domainName
    ? `https://example.com/api/domains/nameservers?domainName=${encodeURIComponent(
        domainName
      )}`
    : "https://example.com/api/domains/nameservers";
  return new NextRequest(url, { method: "GET" });
}

function makePostReq(body: unknown) {
  return new NextRequest("https://example.com/api/domains/nameservers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validUser = { _id: "U1", email: "u@x.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(validUser);
  getNameservers.mockReset();
  setDefaultNameservers.mockReset();
  setCustomNameservers.mockReset();
  findOrderByDomainForUser.mockReset();
  findOrderDomain.mockReset();
  domainUpdateOne.mockReset().mockResolvedValue(undefined);
});

// ─── GET ────────────────────────────────────────────────────────────
describe("GET — auth gate FIRST", () => {
  it("no user → 401 (no RC call)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq("example.com"));
    expect(res.status).toBe(401);
    expect(getNameservers).not.toHaveBeenCalled();
  });
});

describe("GET — param validation", () => {
  it("missing domainName query param → 400", async () => {
    const res = await GET(makeGetReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Domain name is required");
  });

  it("invalid domain format → 400 'Invalid domain name format'", async () => {
    const res = await GET(makeGetReq("not-a-domain"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid domain name format");
  });

  it("path-traversal attempt rejected by regex → 400", async () => {
    const res = await GET(makeGetReq("../../etc/passwd"));
    expect(res.status).toBe(400);
  });

  it("SQL-injection chars rejected by regex → 400", async () => {
    const res = await GET(makeGetReq("'; DROP TABLE users; --"));
    expect(res.status).toBe(400);
  });
});

describe("GET — Method 1: ResellerClub API happy path", () => {
  it("RC returns nameservers → method='custom' (cloudflare); registrar='Anutech Digital'", async () => {
    getNameservers.mockResolvedValueOnce([
      "tom.ns.cloudflare.com",
      "lisa.ns.cloudflare.com",
    ]);
    const res = await GET(makeGetReq("example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.nameservers).toEqual([
      "tom.ns.cloudflare.com",
      "lisa.ns.cloudflare.com",
    ]);
    expect(body.whoisData.registrar).toBe("Anutech Digital");
    expect(body.whoisData.status).toBe("Active");
  });

  it("RC returns mixed-case → cleanup dedups lowercase + drops 'name'-containing entries", async () => {
    getNameservers.mockResolvedValueOnce([
      "ns1.example.com",
      "ns1.example.com", // exact dup
      "name.example.com", // contains 'name' — filtered
      "no-dot", // no dot — filtered
      "has spaces.example.com", // has space — filtered
    ]);
    const res = await GET(makeGetReq("example.com"));
    const body = await res.json();
    expect(body.nameservers).toEqual(["ns1.example.com"]);
  });
});

describe("GET — default-vs-custom detection", () => {
  it.each([
    ["dns1.registrar-servers.com", "default"],
    ["ns2.orderbox-dns.com", "default"],
    ["ns3.resellerclub.com", "default"],
    ["ns4.publicdomainregistry.com", "default"],
    ["tom.ns.cloudflare.com", "custom"],
    ["ns-100.awsdns-12.org", "custom"],
  ])("'%s' → method:'%s'", async (ns, expected) => {
    getNameservers.mockResolvedValueOnce([ns, ns.replace("1", "2")]);
    const res = await GET(makeGetReq("example.com"));
    const body = await res.json();
    expect(body.method).toBe(expected);
  });
});

describe("GET — response shape", () => {
  it("count = nameservers.length; lastChecked is ISO timestamp", async () => {
    getNameservers.mockResolvedValueOnce([
      "ns1.cloudflare.com",
      "ns2.cloudflare.com",
    ]);
    const res = await GET(makeGetReq("example.com"));
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.domainName).toBe("example.com");
  });
});

describe("GET — placeholder / invalid delegation → unset (not error)", () => {
  it("filters 127.0.0.1-style placeholder NS and returns nameserverStatus:'unset'", async () => {
    // sgweb.biz-style broken delegation: registrar returns placeholder IPs.
    getNameservers.mockResolvedValueOnce(["127.0.0.1", "0.0.0.0"]);
    const res = await GET(makeGetReq("sgweb.biz"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.nameservers).toEqual([]);
    expect(body.nameserverStatus).toBe("unset");
  });

  it("valid NS from the API report nameserverStatus:'ok'", async () => {
    getNameservers.mockResolvedValueOnce(["ns1.cloudflare.com", "ns2.cloudflare.com"]);
    const res = await GET(makeGetReq("example.com"));
    const body = await res.json();
    expect(body.nameserverStatus).toBe("ok");
  });
});

// ─── POST ───────────────────────────────────────────────────────────
describe("POST — auth gate FIRST", () => {
  it("no user → 401 (no domain lookup, no RC call)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(401);
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
    expect(setDefaultNameservers).not.toHaveBeenCalled();
  });
});

describe("POST — schema validation", () => {
  it("invalid domain format → schema rejection", async () => {
    const res = await POST(
      makePostReq({ domainName: "not-a-domain", method: "default" })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("invalid method enum → schema rejection", async () => {
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "weird" })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("custom method WITHOUT nameservers → schema rejection", async () => {
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "custom" })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("custom method with only 1 nameserver → schema rejection (refine requires ≥2)", async () => {
    const res = await POST(
      makePostReq({
        domainName: "example.com",
        method: "custom",
        nameservers: ["ns1.example.com"],
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("nameserver invalid format → schema rejection", async () => {
    const res = await POST(
      makePostReq({
        domainName: "example.com",
        method: "custom",
        nameservers: ["no-tld", "ns2.example.com"],
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST — ownership 3-tier defense", () => {
  it("findOrderByDomainForUser null → 404 'Domain not found for this user'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found for this user");
  });

  it("findOrderDomain null → 404 'Domain not found in order'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ orderId: "ORD-1" });
    findOrderDomain.mockReturnValueOnce(null);
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found in order");
  });

  it("resellerClubOrderId missing → 404 'contact support'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ orderId: "ORD-1" });
    findOrderDomain.mockReturnValueOnce({
      domainName: "example.com",
      resellerClubOrderId: undefined,
    });
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/contact support/);
  });
});

describe("POST — method='default' branch", () => {
  function setupOwnedDomain() {
    findOrderByDomainForUser.mockResolvedValueOnce({ orderId: "ORD-1" });
    findOrderDomain.mockReturnValueOnce({
      domainName: "example.com",
      resellerClubOrderId: "RC-99",
    });
  }

  it("calls setDefaultNameservers with the RC order id (NOT setCustomNameservers)", async () => {
    setupOwnedDomain();
    setDefaultNameservers.mockResolvedValueOnce({ status: "success" });
    await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(setDefaultNameservers).toHaveBeenCalledWith("RC-99");
    expect(setCustomNameservers).not.toHaveBeenCalled();
  });

  it("effectiveNameservers = ['ns1.registrar-servers.com', 'ns2.registrar-servers.com']", async () => {
    setupOwnedDomain();
    setDefaultNameservers.mockResolvedValueOnce({ status: "success" });
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    const body = await res.json();
    expect(body.nameservers).toEqual([
      "ns1.registrar-servers.com",
      "ns2.registrar-servers.com",
    ]);
  });

  it("response shape: success:true + message + nameservers", async () => {
    setupOwnedDomain();
    setDefaultNameservers.mockResolvedValueOnce({ status: "success" });
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/updated successfully/);
  });
});

describe("POST — RC failure mapping", () => {
  function setupOwnedDomain() {
    findOrderByDomainForUser.mockResolvedValueOnce({ orderId: "ORD-1" });
    findOrderDomain.mockReturnValueOnce({
      domainName: "example.com",
      resellerClubOrderId: "RC-99",
    });
  }

  it("RC status !== 'success' → 502 with message (upstream gateway error)", async () => {
    setupOwnedDomain();
    setDefaultNameservers.mockResolvedValueOnce({
      status: "error",
      message: "Registrar rejected the request",
    });
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Registrar rejected the request");
  });

  it("RC error without message → generic 'Failed to update nameservers'", async () => {
    setupOwnedDomain();
    setDefaultNameservers.mockResolvedValueOnce({ status: "error" });
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Failed to update nameservers");
  });
});

describe("POST — DB persistence (non-fatal)", () => {
  function setupOwnedDomainWithSuccess() {
    findOrderByDomainForUser.mockResolvedValueOnce({ orderId: "ORD-1" });
    findOrderDomain.mockReturnValueOnce({
      domainName: "example.com",
      resellerClubOrderId: "RC-99",
    });
    setDefaultNameservers.mockResolvedValueOnce({ status: "success" });
  }

  it("Domain.updateOne called with {domainName, deletedAt:null} filter + nameservers $set", async () => {
    setupOwnedDomainWithSuccess();
    await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(domainUpdateOne).toHaveBeenCalledWith(
      { domainName: "example.com", deletedAt: null },
      {
        $set: {
          nameservers: [
            "ns1.registrar-servers.com",
            "ns2.registrar-servers.com",
          ],
        },
      }
    );
  });

  it("DB write failure SWALLOWED (registrar already updated — non-fatal)", async () => {
    setupOwnedDomainWithSuccess();
    domainUpdateOne.mockRejectedValueOnce(new Error("DB down"));
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe("POST — outer catch", () => {
  it("findOrderByDomainForUser throw → 500 'Failed to update nameservers'", async () => {
    findOrderByDomainForUser.mockRejectedValueOnce(new Error("DB outage"));
    const res = await POST(
      makePostReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update nameservers");
  });
});
