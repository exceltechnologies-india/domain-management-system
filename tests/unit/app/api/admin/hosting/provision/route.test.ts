/**
 * Tests for `app/api/admin/hosting/provision/route.ts` (rescan-4
 * slice 7g7). Admin manual hosting-provision endpoint. Coordinates
 * DA createUser + DNS NS update + Order row + Zoho invoice +
 * Hosting row + email notification + PendingHosting save-on-failure.
 *
 * Pins:
 *  - **Schema validation FIRST** (BEFORE admin check — deliberate so
 *    the outer catch can reference parsed body when provisioning
 *    fails)
 *  - **Admin gate**: AuthService.isAdmin false → 403 FORBIDDEN
 *  - **User lookup**: getUserById null → 404 USER_NOT_FOUND
 *  - **Period clamping**: validityPeriod===1 stays 1; ANY OTHER value
 *    (incl. 6, 24, undefined, etc.) → 12 (the route only accepts
 *    monthly or yearly)
 *  - **Period unit default**: 'months' when omitted; 'days'/'minutes'
 *    pass through (for test/QA plans)
 *  - **DA package name lowercased BEFORE createUser** (DA requires
 *    lowercase package names regardless of how admin typed it)
 *  - **DNS update failure SWALLOWED** (doesn't fail provisioning —
 *    user.directAdminUsername is the primary commit; DNS is a
 *    follow-up that the admin can retry from the dashboard)
 *  - **user.directAdminUsername CAS-style first-set**: only assigned
 *    when not already set (multi-account-per-user support — admin
 *    might provision a 2nd hosting account for the same user)
 *  - **First account stamps hostingCreatedAt + hostingExpiresAt**;
 *    subsequent accounts do NOT touch those primary fields (per-
 *    Hosting row tracks its own dates instead)
 *  - **Order pending-row contracts**: orderId 'ORD-<ts>-<3-char-upper>';
 *    paymentId 'ADMIN-PAY-<ts>'; paymentMethod 'admin_provision';
 *    status 'completed'; bookingStatus[0] step 'domain_registered'
 *    progress 100
 *  - **Manual price wins over plan price**: manualPrice provided →
 *    used verbatim; absent → plan.price; absent both → 0
 *  - **All bookkeeping side-effects SWALLOWED**: Order create, Zoho
 *    invoice, Hosting record create, email — each in its own try/
 *    catch (DA + user have already been committed; bookkeeping
 *    failures don't undo the provisioning)
 *  - **DA error 503 OR code 'DA_SERVER_DOWN'** → 503 with
 *    'DA_SERVER_DOWN' code (admin-visible — distinguishes upstream
 *    outage from logic bugs)
 *  - **Other provisioning failures → PendingHosting row + 200 with
 *    savedToPending:true** (anti-loss: even when DA call fails,
 *    admin gets a queueable record to retry later)
 *  - **PendingHosting save failure → 500 PROVISION_FAILED**
 *    (terminal — admin must retry the form)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const daCreateUser = vi.hoisted(() => vi.fn());
const daUpdateDNSNameservers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    createUser: daCreateUser,
    updateDNSNameservers: daUpdateDNSNameservers,
    NAMESERVERS: ["ns1.example.com", "ns2.example.com"],
  },
  DA_SERVER_IP: "1.2.3.4",
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const createOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ createOrder }));

const createPendingHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({ createPendingHosting }));

const createHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ createHosting }));

const sendHostingProvisionedEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendHostingProvisionedEmail },
}));

const zohoCreateInvoice = vi.hoisted(() => vi.fn());
const zohoGetInstance = vi.hoisted(() =>
  vi.fn(() => ({ createInvoice: zohoCreateInvoice }))
);
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance: zohoGetInstance },
}));

const calculateHostingDates = vi.hoisted(() =>
  vi.fn(() => ({
    registeredAt: new Date("2026-01-01"),
    expiresAt: new Date("2027-01-01"),
  }))
);
vi.mock("@/lib/hosting-dates", () => ({ calculateHostingDates }));

const HostingPlanFindOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: { findOne: HostingPlanFindOne },
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
  vi.fn((message: string, status: number, code: string) =>
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
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/hosting/provision/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/hosting/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  userId: "507f1f77bcf86cd799439011", // valid 24-hex
  domain: "alice.example.com",
  packageName: "PRO",
  daUsername: "alice",
};

function makeUser(overrides: Partial<any> = {}): any {
  return {
    _id: "U1",
    email: "user@x.com",
    firstName: "First",
    lastName: "Last",
    directAdminUsername: undefined, // first account
    hostingCreatedAt: undefined,
    hostingExpiresAt: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  daCreateUser.mockReset().mockResolvedValue(undefined);
  daUpdateDNSNameservers.mockReset().mockResolvedValue(undefined);
  getUserById.mockReset();
  createOrder.mockReset().mockResolvedValue({
    domains: [{ domainName: "alice.example.com" }],
    save: vi.fn().mockResolvedValue(undefined),
  });
  createPendingHosting.mockReset().mockResolvedValue(undefined);
  createHosting.mockReset().mockResolvedValue(undefined);
  sendHostingProvisionedEmail.mockReset().mockResolvedValue(undefined);
  zohoCreateInvoice.mockReset().mockResolvedValue(undefined);
  HostingPlanFindOne.mockReset().mockResolvedValue(null);
});

// ─── Schema validation FIRST ───────────────────────────────────────
describe("Schema validation FIRST (BEFORE admin check)", () => {
  it("invalid userId (not ObjectId) → schema rejection", async () => {
    const res = await POST(makeReq({ ...validBody, userId: "not-an-id" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it("missing domain → schema rejection", async () => {
    const res = await POST(makeReq({ ...validBody, domain: undefined }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("daUsername > 14 chars → schema rejection (DA limit)", async () => {
    const res = await POST(
      makeReq({ ...validBody, daUsername: "x".repeat(15) })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("negative price → schema rejection", async () => {
    const res = await POST(makeReq({ ...validBody, price: -1 }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("invalid periodUnit enum → schema rejection", async () => {
    const res = await POST(
      makeReq({ ...validBody, periodUnit: "years" }) // not in enum
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── Admin gate ────────────────────────────────────────────────────
describe("Admin auth gate", () => {
  it("not admin → 403 FORBIDDEN", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(getUserById).not.toHaveBeenCalled();
    expect(daCreateUser).not.toHaveBeenCalled();
  });
});

// ─── User lookup ───────────────────────────────────────────────────
describe("User lookup", () => {
  it("user not found → 404 USER_NOT_FOUND", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("USER_NOT_FOUND");
    expect(daCreateUser).not.toHaveBeenCalled();
  });
});

// ─── Period clamping ───────────────────────────────────────────────
describe("Period clamping: validityPeriod === 1 ? 1 : 12", () => {
  it.each([
    [undefined, 12],
    [1, 1],
    [6, 12], // anything non-1 → 12
    [12, 12],
    [24, 12],
  ])("validityPeriod=%s → period %d", async (validityPeriod, expected) => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq({ ...validBody, validityPeriod }));
    expect(calculateHostingDates).toHaveBeenCalledWith(expected, "months");
  });

  it("periodUnit default 'months'", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq(validBody));
    expect(calculateHostingDates).toHaveBeenCalledWith(12, "months");
  });

  it("periodUnit override flows through ('days' for test plans)", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq({ ...validBody, periodUnit: "days" }));
    expect(calculateHostingDates).toHaveBeenCalledWith(12, "days");
  });
});

// ─── DA createUser ─────────────────────────────────────────────────
describe("DirectAdmin createUser", () => {
  it("called with (daUsername, email, domain, lowercased package)", async () => {
    getUserById.mockResolvedValueOnce(makeUser({ email: "u@x.com" }));
    await POST(
      makeReq({ ...validBody, packageName: "PRO", daUsername: "alice" })
    );
    expect(daCreateUser).toHaveBeenCalledWith(
      "alice",
      "u@x.com",
      "alice.example.com", // domain (normalised by schema to lowercase)
      "pro" // package lowercased
    );
  });

  it("package name lowercased BEFORE DA call (regardless of admin typing)", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq({ ...validBody, packageName: "MIXED-Case-Plus" }));
    expect(daCreateUser.mock.calls[0][3]).toBe("mixed-case-plus");
  });
});

// ─── DNS update (best-effort) ──────────────────────────────────────
describe("DNS nameservers update (best-effort)", () => {
  it("called with (daUsername, domain, NAMESERVERS) after createUser", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq(validBody));
    expect(daUpdateDNSNameservers).toHaveBeenCalledWith(
      "alice",
      "alice.example.com",
      ["ns1.example.com", "ns2.example.com"]
    );
  });

  it("DNS failure SWALLOWED → provisioning continues + 200 success", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    daUpdateDNSNameservers.mockRejectedValueOnce(new Error("DNS API down"));

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ─── User mutation (first-set semantics) ───────────────────────────
describe("user.directAdminUsername CAS-style first-set", () => {
  it("first account (no DA username): assigns daUsername + stamps both dates", async () => {
    const user = makeUser({ directAdminUsername: undefined });
    getUserById.mockResolvedValueOnce(user);

    await POST(makeReq(validBody));

    expect(user.directAdminUsername).toBe("alice");
    expect(user.hostingCreatedAt).toEqual(new Date("2026-01-01"));
    expect(user.hostingExpiresAt).toEqual(new Date("2027-01-01"));
    expect(user.save).toHaveBeenCalled();
  });

  it("subsequent account (DA username already set): does NOT overwrite", async () => {
    const user = makeUser({
      directAdminUsername: "alice_first", // already set
      hostingCreatedAt: new Date("2025-01-01"),
      hostingExpiresAt: new Date("2026-01-01"),
    });
    getUserById.mockResolvedValueOnce(user);

    await POST(makeReq({ ...validBody, daUsername: "alice_second" }));

    expect(user.directAdminUsername).toBe("alice_first"); // unchanged
    expect(user.hostingCreatedAt).toEqual(new Date("2025-01-01")); // unchanged
    expect(user.hostingExpiresAt).toEqual(new Date("2026-01-01")); // unchanged
    expect(user.save).toHaveBeenCalled(); // still saves
  });
});

// ─── Order pending-row contracts ───────────────────────────────────
describe("Order pending-row contracts", () => {
  it("orderId 'ORD-<ts>-<3char-upper>'; paymentId 'ADMIN-PAY-<ts>'; paymentMethod 'admin_provision'", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq(validBody));

    const payload = createOrder.mock.calls[0][0];
    expect(payload.orderId).toMatch(/^ORD-\d+-[A-Z0-9]{3}$/);
    expect(payload.paymentId).toMatch(/^ADMIN-PAY-\d+$/);
    expect(payload.paymentMethod).toBe("admin_provision");
    expect(payload.status).toBe("completed");
  });

  it("bookingStatus[0]: step 'domain_registered' progress 100 message 'Hosting provisioned by admin'", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq(validBody));

    const payload = createOrder.mock.calls[0][0];
    const bs = payload.domains[0].bookingStatus[0];
    expect(bs.step).toBe("domain_registered");
    expect(bs.progress).toBe(100);
    expect(bs.message).toBe("Hosting provisioned by admin");
  });

  it("itemType 'hosting' + dnsProvider 'directadmin' + status 'registered'", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq(validBody));

    const payload = createOrder.mock.calls[0][0];
    expect(payload.domains[0].itemType).toBe("hosting");
    expect(payload.domains[0].dnsProvider).toBe("directadmin");
    expect(payload.domains[0].status).toBe("registered");
  });
});

// ─── Price resolution ──────────────────────────────────────────────
describe("Price resolution: manualPrice > plan.price > 0", () => {
  it("manual price wins over plan price", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    HostingPlanFindOne.mockResolvedValueOnce({
      planId: "pro",
      name: "Pro",
      price: 5000,
      currency: "INR",
    });
    await POST(makeReq({ ...validBody, price: 12345 }));

    const payload = createOrder.mock.calls[0][0];
    expect(payload.totalAmount).toBe(12345);
    expect(payload.amount).toBe(12345);
    expect(payload.domains[0].price).toBe(12345);
  });

  it("no manual price + plan found → plan.price", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    HostingPlanFindOne.mockResolvedValueOnce({
      planId: "pro",
      name: "Pro",
      price: 5000,
      currency: "INR",
    });
    await POST(makeReq(validBody));

    const payload = createOrder.mock.calls[0][0];
    expect(payload.totalAmount).toBe(5000);
  });

  it("no manual price + plan NOT found → 0 (no charge)", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    HostingPlanFindOne.mockResolvedValueOnce(null);
    await POST(makeReq(validBody));

    const payload = createOrder.mock.calls[0][0];
    expect(payload.totalAmount).toBe(0);
  });

  it("plan.hostingPlan reference in Order.domains[].hostingPlan when plan exists", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    HostingPlanFindOne.mockResolvedValueOnce({
      planId: "pro",
      name: "Pro Plan",
      price: 5000,
      currency: "INR",
    });
    await POST(makeReq(validBody));

    const payload = createOrder.mock.calls[0][0];
    expect(payload.domains[0].hostingPlan).toMatchObject({
      planId: "pro",
      name: "Pro Plan",
      price: 5000,
    });
  });

  it("hostingPlan undefined when plan NOT found", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    HostingPlanFindOne.mockResolvedValueOnce(null);
    await POST(makeReq(validBody));

    const payload = createOrder.mock.calls[0][0];
    expect(payload.domains[0].hostingPlan).toBeUndefined();
  });
});

// ─── Zoho invoice (best-effort) ────────────────────────────────────
describe("Zoho invoice (best-effort)", () => {
  it("createInvoice called with paymentMode 'Admin Provision'", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    await POST(makeReq(validBody));

    expect(zohoCreateInvoice).toHaveBeenCalled();
    const args = zohoCreateInvoice.mock.calls[0];
    expect(args[3]).toBe("Admin Provision");
  });

  it("Zoho failure SWALLOWED → response still 200", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    zohoCreateInvoice.mockRejectedValueOnce(new Error("Zoho down"));

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });
});

// ─── createHosting + email (best-effort) ───────────────────────────
describe("Hosting record + email (best-effort)", () => {
  it("createHosting called with full payload (userId, domainName, planId, name, serverPackage, daUsername, dates, orderId, paymentId)", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    HostingPlanFindOne.mockResolvedValueOnce({
      planId: "pro",
      name: "Pro Plan",
    });
    await POST(makeReq(validBody));

    expect(createHosting).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "U1",
        domainName: "alice.example.com",
        planId: "pro",
        name: "Pro Plan",
        serverPackage: "PRO",
        status: "active",
        startDate: new Date("2026-01-01"),
        expiryDate: new Date("2027-01-01"),
        directAdminUsername: "alice",
      })
    );
  });

  it("createHosting failure SWALLOWED → response still 200", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    createHosting.mockRejectedValueOnce(new Error("Hosting DB down"));

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });

  it("Email sent with domainName + packageName + serverIp + nameservers", async () => {
    getUserById.mockResolvedValueOnce(
      makeUser({ email: "u@x.com", firstName: "First" })
    );
    await POST(makeReq(validBody));

    expect(sendHostingProvisionedEmail).toHaveBeenCalledWith(
      "u@x.com",
      "First",
      {
        domainName: "alice.example.com",
        packageName: "PRO",
        serverIp: "1.2.3.4",
        nameservers: ["ns1.example.com", "ns2.example.com"],
      }
    );
  });

  it("Email failure SWALLOWED → response still 200", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    sendHostingProvisionedEmail.mockRejectedValueOnce(
      new Error("SMTP down")
    );

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });

  it("user.firstName fallback to 'User' when undefined", async () => {
    getUserById.mockResolvedValueOnce(
      makeUser({ firstName: undefined, email: "u@x.com" })
    );
    await POST(makeReq(validBody));

    const args = sendHostingProvisionedEmail.mock.calls[0];
    expect(args[1]).toBe("User");
  });
});

// ─── Response shape ────────────────────────────────────────────────
describe("Happy-path response shape", () => {
  it("success + message + data {username, domain, package}", async () => {
    getUserById.mockResolvedValueOnce(makeUser({ email: "u@x.com" }));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/Hosting provisioned successfully for u@x.com on alice.example.com/);
    expect(body.data).toEqual({
      username: "alice",
      domain: "alice.example.com",
      package: "PRO",
    });
  });
});

// ─── DA server-down error ──────────────────────────────────────────
describe("DA server-down error mapping", () => {
  it("status 503 → 503 'DA_SERVER_DOWN' code", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    const daError = Object.assign(new Error("DA unreachable"), {
      status: 503,
    });
    daCreateUser.mockRejectedValueOnce(daError);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("DA_SERVER_DOWN");
    expect(createPendingHosting).not.toHaveBeenCalled();
  });

  it("code 'DA_SERVER_DOWN' → 503", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    const daError = Object.assign(new Error("DA down"), {
      code: "DA_SERVER_DOWN",
    });
    daCreateUser.mockRejectedValueOnce(daError);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(503);
  });
});

// ─── Generic failure → PendingHosting ──────────────────────────────
describe("Generic provisioning failure → PendingHosting save", () => {
  it("DA error (non-503) → createPendingHosting + 200 savedToPending:true", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    daCreateUser.mockRejectedValueOnce(new Error("DA: username collision"));

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/Added to Pending Hostings list for retry/);
    expect(body.data.savedToPending).toBe(true);

    expect(createPendingHosting).toHaveBeenCalledWith({
      userId: validBody.userId,
      domain: "alice.example.com",
      package: "PRO",
      daUsername: "alice",
      error: "DA: username collision",
      status: "failed",
    });
  });

  it("PendingHosting save ALSO fails → 500 PROVISION_FAILED (terminal)", async () => {
    getUserById.mockResolvedValueOnce(makeUser());
    daCreateUser.mockRejectedValueOnce(new Error("DA fail"));
    createPendingHosting.mockRejectedValueOnce(new Error("DB down"));

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PROVISION_FAILED");
  });
});
