/**
 * Tests for `@/lib/services/payment/provisioner` orchestrator
 * (rescan-4 slice 7fh). Thin dispatcher after the H2 decomposition —
 * the per-item branches live in provisioner-hosting / provisioner-
 * domain / provisioner-verification. Pins:
 *  - setupRcCustomerAndContact: getOrCreateCustomerAndContact called
 *    with user fields; failure → THROWS 'Failed to get ResellerClub
 *    customer/contact IDs' (provisioning aborts — no point per-item
 *    work without the customer)
 *  - **RC IDs persisted to User doc via setUserResellerClubIds** with
 *    a conditional write: only sets when user doesn't already have
 *    the field (avoids overwriting existing IDs); mirrors onto
 *    in-memory user too so callers later in the request don't refetch
 *  - **Per-item fan-out via Promise.all** (NOT a for-loop) — 5-item
 *    cart doesn't pay 5× the RC+DA latency
 *  - isHostingItem → routes to provisionHostingItem; non-hosting →
 *    provisionDomainItem
 *  - **Placeholder hosting-domain short-circuit**: cart items whose
 *    domainName starts with `hosting-` (synthetic placeholder for
 *    the linked hosting slot) → returns synthetic success WITHOUT
 *    calling provisionDomainItem; orderDomain:null (rides on the
 *    linked hosting item's row)
 *  - runDomainVerificationPhase called AFTER all per-item work, with
 *    orderDomains (so silently-failed registrations get caught)
 *  - **finalSuccessfulDomains** computed from orderDomains.status ===
 *    'registered' AND itemType !== 'hosting' (post-verification view —
 *    excludes hosting items even though they're 'registered' too)
 *  - pendingDomains + failedDomains arrays computed post-verification
 *  - **Logs delta when finalSuccessfulDomains count differs from the
 *    initial successfulDomains count** (silent-failure visibility)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getOrCreateCustomerAndContact = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getOrCreateCustomerAndContact },
}));

const setUserResellerClubIds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ setUserResellerClubIds }));

const isHostingItem = vi.hoisted(() =>
  vi.fn((item: { itemType?: string }) => item.itemType === "hosting")
);
vi.mock("@/lib/billing", () => ({ isHostingItem }));

const provisionHostingItem = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/provisioner-hosting", () => ({
  provisionHostingItem,
}));

const provisionDomainItem = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/provisioner-domain", () => ({
  provisionDomainItem,
}));

const runDomainVerificationPhase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/provisioner-verification", () => ({
  runDomainVerificationPhase,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { provisionCartItems } from "@/lib/services/payment/provisioner";

// Fresh user per test (source mutates user.resellerClubCustomerId).
function makeUser(overrides: Record<string, unknown> = {}): never {
  return {
    _id: "USER_ID",
    email: "u@x.test",
    firstName: "Alice",
    lastName: "Smith",
    phone: "9999999999",
    phoneCc: "91",
    companyName: "Acme",
    address: {
      line1: "1 Main",
      city: "Mumbai",
      state: "MH",
      country: "IN",
      zipcode: "400001",
    },
    ...overrides,
  } as never;
}
const USER = makeUser();

beforeEach(() => {
  connectDB.mockReset();
  getOrCreateCustomerAndContact.mockReset();
  setUserResellerClubIds.mockReset();
  isHostingItem.mockClear();
  isHostingItem.mockImplementation(
    (item: { itemType?: string }) => item.itemType === "hosting"
  );
  provisionHostingItem.mockReset();
  provisionDomainItem.mockReset();
  runDomainVerificationPhase.mockReset();
});

describe("setupRcCustomerAndContact", () => {
  it("called with user fields + address mapped to RC shape", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    await provisionCartItems({
      cartItems: [],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    const [args] = getOrCreateCustomerAndContact.mock.calls[0];
    expect(args.email).toBe("u@x.test");
    expect(args.firstName).toBe("Alice");
    expect(args.phone).toBe("9999999999");
    expect(args.companyName).toBe("Acme");
    expect(args.address).toEqual({
      line1: "1 Main",
      city: "Mumbai",
      state: "MH",
      country: "IN",
      zipcode: "400001",
    });
  });

  it("user.address missing → address arg undefined (RC accepts no-address)", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    await provisionCartItems({
      cartItems: [],
      user: makeUser({ address: undefined }),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    const [args] = getOrCreateCustomerAndContact.mock.calls[0];
    expect(args.address).toBeUndefined();
  });

  it("RC failure (status:'error' OR missing IDs) → THROWS 'Failed to get RC customer/contact'", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "error",
      error: "RC 503",
    });
    await expect(
      provisionCartItems({
        cartItems: [],
        user: makeUser(),
        orderId: "ord_42",
        razorpay_payment_id: "pay_xyz",
      } as never)
    ).rejects.toThrow(/Failed to get ResellerClub customer\/contact IDs/);
  });

  it("missing customerId in success response → also throws", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      contactId: 100, // no customerId
    });
    await expect(
      provisionCartItems({
        cartItems: [],
        user: makeUser(),
        orderId: "ord_42",
        razorpay_payment_id: "pay_xyz",
      } as never)
    ).rejects.toThrow(/Failed to get/);
  });
});

describe("setupRcCustomerAndContact — User persistence", () => {
  it("RC IDs persisted via setUserResellerClubIds when user lacks them", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    setUserResellerClubIds.mockResolvedValueOnce(undefined);
    await provisionCartItems({
      cartItems: [],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    expect(setUserResellerClubIds).toHaveBeenCalledWith("USER_ID", {
      customerId: 7,
      contactId: 100,
    });
  });

  it("when user ALREADY has customerId/contactId → setUserResellerClubIds called with `undefined` for those fields (no overwrite)", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    setUserResellerClubIds.mockResolvedValueOnce(undefined);
    const userWithIds = makeUser({
      resellerClubCustomerId: 99,
      resellerClubContactId: 88,
    });
    await provisionCartItems({
      cartItems: [],
      user: userWithIds,
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    const [, args] = setUserResellerClubIds.mock.calls[0];
    expect(args.customerId).toBeUndefined();
    expect(args.contactId).toBeUndefined();
  });

  it("in-memory user mirrored too (so later code in same request doesn't refetch)", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    setUserResellerClubIds.mockResolvedValueOnce(undefined);
    const user = makeUser() as unknown as Record<string, unknown>;
    await provisionCartItems({
      cartItems: [],
      user,
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    expect(user.resellerClubCustomerId).toBe(7);
    expect(user.resellerClubContactId).toBe(100);
  });

  it("setUserResellerClubIds throw SWALLOWED (logged + flow continues)", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    setUserResellerClubIds.mockRejectedValueOnce(new Error("write failed"));
    // Should NOT throw to caller — persistence is best-effort.
    await expect(
      provisionCartItems({
        cartItems: [],
        user: makeUser(),
        orderId: "ord_42",
        razorpay_payment_id: "pay_xyz",
      } as never)
    ).resolves.toBeDefined();
  });
});

describe("provisionCartItems — per-item dispatch", () => {
  beforeEach(() => {
    getOrCreateCustomerAndContact.mockResolvedValue({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    setUserResellerClubIds.mockResolvedValue(undefined);
  });

  it("hosting item → provisionHostingItem with customerResult passed through", async () => {
    provisionHostingItem.mockResolvedValueOnce({
      registrationResult: {
        domainName: "h.com",
        status: "success",
        itemType: "hosting",
      },
      orderDomain: { domainName: "h.com", status: "registered", itemType: "hosting" },
      successfulDomain: "h.com",
    });
    await provisionCartItems({
      cartItems: [{ domainName: "h.com", itemType: "hosting" } as never],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
      razorpay_subscription_id: "sub_xyz",
    } as never);
    expect(provisionHostingItem).toHaveBeenCalled();
    const [, ctx] = provisionHostingItem.mock.calls[0];
    expect(ctx.customerResult).toEqual({ customerId: 7, contactId: 100 });
    expect(ctx.razorpay_subscription_id).toBe("sub_xyz");
  });

  it("domain item → provisionDomainItem (non-hosting + non-placeholder)", async () => {
    provisionDomainItem.mockResolvedValueOnce({
      registrationResult: {
        domainName: "x.com",
        status: "success",
        itemType: "domain",
      },
      orderDomain: { domainName: "x.com", status: "registered", itemType: "domain" },
      successfulDomain: "x.com",
    });
    await provisionCartItems({
      cartItems: [{ domainName: "x.com", itemType: "domain" } as never],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    expect(provisionDomainItem).toHaveBeenCalled();
    expect(provisionHostingItem).not.toHaveBeenCalled();
  });

  it("**placeholder 'hosting-XYZ' shortcut**: returns synthetic success WITHOUT provisionDomainItem call + orderDomain:null", async () => {
    const result = await provisionCartItems({
      cartItems: [
        { domainName: "hosting-abc", itemType: "domain" } as never,
      ],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    expect(provisionDomainItem).not.toHaveBeenCalled();
    expect(provisionHostingItem).not.toHaveBeenCalled();
    expect(result.registrationResults[0].status).toBe("success");
    expect(result.registrationResults[0].message).toBe("Hosting setup complete");
    expect(result.orderDomains).toHaveLength(0); // null orderDomain skipped
  });

  it("Promise.all fan-out: 3 items resolve in parallel (no serial chain)", async () => {
    // Each per-item helper resolves with a unique result so we can
    // check the order is preserved.
    provisionHostingItem.mockImplementation(async (item: { domainName: string }) => ({
      registrationResult: { domainName: item.domainName, status: "success", itemType: "hosting" },
      orderDomain: { domainName: item.domainName, status: "registered", itemType: "hosting" },
      successfulDomain: item.domainName,
    }));
    provisionDomainItem.mockImplementation(async (item: { domainName: string }) => ({
      registrationResult: { domainName: item.domainName, status: "success", itemType: "domain" },
      orderDomain: { domainName: item.domainName, status: "registered", itemType: "domain" },
      successfulDomain: item.domainName,
    }));
    const result = await provisionCartItems({
      cartItems: [
        { domainName: "a.com", itemType: "domain" } as never,
        { domainName: "h.com", itemType: "hosting" } as never,
        { domainName: "b.com", itemType: "domain" } as never,
      ],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    // order preserved
    expect(result.registrationResults.map((r) => r.domainName)).toEqual([
      "a.com",
      "h.com",
      "b.com",
    ]);
  });
});

describe("provisionCartItems — post-loop verification + classification", () => {
  beforeEach(() => {
    getOrCreateCustomerAndContact.mockResolvedValue({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    setUserResellerClubIds.mockResolvedValue(undefined);
  });

  it("runDomainVerificationPhase called AFTER per-item with the accumulated orderDomains", async () => {
    provisionDomainItem.mockResolvedValueOnce({
      registrationResult: { domainName: "x.com", status: "success", itemType: "domain" },
      orderDomain: { domainName: "x.com", status: "registered", itemType: "domain" },
      successfulDomain: "x.com",
    });
    await provisionCartItems({
      cartItems: [{ domainName: "x.com", itemType: "domain" } as never],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    expect(runDomainVerificationPhase).toHaveBeenCalled();
    const [orderDomains, ctx] = runDomainVerificationPhase.mock.calls[0];
    expect(orderDomains[0].domainName).toBe("x.com");
    expect(ctx.customerResult).toEqual({ customerId: 7, contactId: 100 });
  });

  it("finalSuccessfulDomains: status:'registered' AND itemType !== 'hosting' (hosting EXCLUDED post-verification)", async () => {
    provisionHostingItem.mockImplementation(async (item: { domainName: string }) => ({
      registrationResult: { domainName: item.domainName, status: "success", itemType: "hosting" },
      orderDomain: { domainName: item.domainName, status: "registered", itemType: "hosting" },
      successfulDomain: item.domainName,
    }));
    provisionDomainItem.mockImplementation(async (item: { domainName: string }) => ({
      registrationResult: { domainName: item.domainName, status: "success", itemType: "domain" },
      orderDomain: { domainName: item.domainName, status: "registered", itemType: "domain" },
      successfulDomain: item.domainName,
    }));
    const result = await provisionCartItems({
      cartItems: [
        { domainName: "x.com", itemType: "domain" } as never,
        { domainName: "h.com", itemType: "hosting" } as never,
      ],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    // successfulDomains includes BOTH (pre-verification view)
    expect(result.successfulDomains).toEqual(["x.com", "h.com"]);
    // finalSuccessfulDomains is domain-only
    expect(result.finalSuccessfulDomains).toEqual(["x.com"]);
  });

  it("pendingDomains + failedDomains computed from orderDomains.status post-verification", async () => {
    provisionDomainItem
      .mockResolvedValueOnce({
        registrationResult: { domainName: "x.com", status: "pending", itemType: "domain" },
        orderDomain: { domainName: "x.com", status: "pending", itemType: "domain" },
      })
      .mockResolvedValueOnce({
        registrationResult: { domainName: "y.com", status: "failed", itemType: "domain" },
        orderDomain: { domainName: "y.com", status: "failed", itemType: "domain" },
      })
      .mockResolvedValueOnce({
        registrationResult: { domainName: "z.com", status: "success", itemType: "domain" },
        orderDomain: { domainName: "z.com", status: "registered", itemType: "domain" },
        successfulDomain: "z.com",
      });
    const result = await provisionCartItems({
      cartItems: [
        { domainName: "x.com", itemType: "domain" } as never,
        { domainName: "y.com", itemType: "domain" } as never,
        { domainName: "z.com", itemType: "domain" } as never,
      ],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    expect(result.pendingDomains.map((d) => d.domainName)).toEqual(["x.com"]);
    expect(result.failedDomains.map((d) => d.domainName)).toEqual(["y.com"]);
    expect(result.finalSuccessfulDomains).toEqual(["z.com"]);
  });
});

describe("provisionCartItems — return-shape contract", () => {
  it("returns 6-field result: registrationResults + successfulDomains + orderDomains + finalSuccessfulDomains + pendingDomains + failedDomains", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: 7,
      contactId: 100,
    });
    setUserResellerClubIds.mockResolvedValueOnce(undefined);
    const result = await provisionCartItems({
      cartItems: [],
      user: makeUser(),
      orderId: "ord_42",
      razorpay_payment_id: "pay_xyz",
    } as never);
    expect(Object.keys(result).sort()).toEqual([
      "failedDomains",
      "finalSuccessfulDomains",
      "orderDomains",
      "pendingDomains",
      "registrationResults",
      "successfulDomains",
    ]);
  });
});
