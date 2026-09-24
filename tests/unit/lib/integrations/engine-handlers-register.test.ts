/**
 * `domain.register` — Phase 9 (24 Sep 2026). Registering a domain cannot be undone.
 *
 * Every refusal is asserted to happen with ZERO writes — no DMS account, no
 * ResellerClub customer, no registration — because a hold that has already
 * half-acted is not a hold. The one path that registers is asserted to register
 * exactly once, and a lost response to hold the claim (sent_unknown).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rc = vi.hoisted(() => ({
  getDomainOrderId: vi.fn(),
  getDomainDetails: vi.fn(),
}));
vi.mock("@/lib/integrations/resellerclub", () => rc);

const api = vi.hoisted(() => ({
  getCustomerId: vi.fn(),
  searchDomainWithTlds: vi.fn(),
  getOrCreateCustomerAndContact: vi.fn(),
  registerDomain: vi.fn(),
}));
vi.mock("@/lib/resellerclub", () => ({ ResellerClubAPI: api }));

const pricing = vi.hoisted(() => ({ getDomainPricing: vi.fn(), getTLDPricing: vi.fn() }));
vi.mock("@/lib/pricing-service", () => ({ PricingService: pricing }));

const users = vi.hoisted(() => ({ getUserByEmail: vi.fn(), createUser: vi.fn() }));
vi.mock("@/lib/services/users", () => users);

const domainModel = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/models/Domain", () => ({ default: domainModel }));

const usageRows = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/models/EngineCommand", () => ({
  default: { find: () => ({ select: () => ({ lean: async () => usageRows.rows }) }) },
}));
vi.mock("@/lib/mongodb", () => ({ default: async () => undefined }));
vi.mock("@/lib/services/domains", () => ({ reminderTriggerFor: (d: Date) => d }));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerDomainCommand, reconcileRegister } from "@/lib/integrations/engine-handlers-register";
import { transportOf } from "@/lib/integrations/engine-attempt";
import { HOLD_PREFIX, parseRegister, decideSpend, capsFromEnv } from "@/lib/integrations/engine-register-policy";

const registrant = {
  firstName: "Asha",
  lastName: "Verma",
  email: "asha@example.invalid",
  phone: "98765 43210",
  phoneCc: "91",
  companyName: "Acme",
  address: { line1: "12 MG Road", city: "Delhi", state: "Delhi", country: "IN", zipcode: "110001" },
};
const payload = (over: Record<string, unknown> = {}) => ({
  years: 1,
  registrant,
  coverRupees: 1500,
  paymentMode: "live",
  sourceRef: "Q-TEST-1",
  ...over,
});
const ctx = (mode: "test" | "live", over: Record<string, unknown> = {}) => ({
  commandId: "cmd-1",
  subject: "acme.in",
  mode,
  payload: payload(over),
});

const noWrites = () => {
  expect(users.createUser).not.toHaveBeenCalled();
  expect(api.getOrCreateCustomerAndContact).not.toHaveBeenCalled();
  expect(api.registerDomain).not.toHaveBeenCalled();
  expect(domainModel.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  for (const f of [...Object.values(rc), ...Object.values(api), ...Object.values(pricing), ...Object.values(users), domainModel.create]) f.mockReset();
  usageRows.rows = [];
  rc.getDomainOrderId.mockResolvedValue({ kind: "not_found", reason: "no order" });
  pricing.getDomainPricing.mockResolvedValue({ stale: false });
  pricing.getTLDPricing.mockResolvedValue({
    in: { reseller: { addnewdomain: { "1": "550.00" } }, customer: { addnewdomain: { "1": "749.00" } } },
  });
  users.getUserByEmail.mockResolvedValue(null);
  users.createUser.mockResolvedValue({ _id: "U-NEW" });
  api.getOrCreateCustomerAndContact.mockResolvedValue({ status: "success", customerId: 111, contactId: 222 });
  api.registerDomain.mockResolvedValue({ status: "success", transport: "responded", data: { entityid: "RC-ORDER-9", actionstatus: "Success" } });
  api.searchDomainWithTlds.mockResolvedValue([{ domainName: "acme.in", available: true }]);
  domainModel.create.mockResolvedValue({});
});

describe("parseRegister", () => {
  it("normalises and accepts a complete registrant", () => {
    const r = parseRegister(payload());
    expect(r.registrant.phone).toBe("9876543210");
    expect(r.registrant.email).toBe("asha@example.invalid");
  });
  it("names what is missing — ResellerClub needs a postal address", () => {
    expect(() => parseRegister(payload({ registrant: { ...registrant, address: { ...registrant.address, zipcode: "" } } }))).toThrow(/PIN/);
  });
  it("refuses more than one year and an unknown payment mode", () => {
    expect(() => parseRegister(payload({ years: 2 }))).toThrow(/one year/);
    expect(() => parseRegister(payload({ paymentMode: "maybe" }))).toThrow(/paymentMode/);
  });
});

describe("decideSpend / caps", () => {
  const base = { paymentMode: "live" as const, costRupees: 550, coverRupees: 1500, usage: { count: 0, rupees: 0 }, caps: { maxPerDay: 5, maxRupeesPerDay: 10000 }, domain: "acme.in" };
  it("allows a live, covered registration under the caps", () => expect(decideSpend(base).ok).toBe(true));
  it.each([
    [{ paymentMode: "test" as const }, /TEST-mode/],
    [{ costRupees: null }, /could not be read/],
    [{ coverRupees: 400 }, /only ₹400 was paid/],
    [{ usage: { count: 5, rupees: 0 } }, /daily limit of 5/],
    [{ usage: { count: 1, rupees: 9800 } }, /daily spend limit of ₹10000/],
  ])("holds %j", (over, re) => {
    const d = decideSpend({ ...base, ...over });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.hold.startsWith(HOLD_PREFIX)).toBe(true);
      expect(d.hold).toMatch(re);
    }
  });
  it("caps default conservatively and never read unset as unlimited", () => {
    expect(capsFromEnv({})).toEqual({ maxPerDay: 5, maxRupeesPerDay: 10000 });
    expect(capsFromEnv({ ENGINE_DOMAIN_REGISTER_MAX_PER_DAY: "abc" }).maxPerDay).toBe(5);
    expect(capsFromEnv({ ENGINE_DOMAIN_REGISTER_MAX_PER_DAY: "20", ENGINE_DOMAIN_REGISTER_MAX_RUPEES_PER_DAY: "50000" })).toEqual({ maxPerDay: 20, maxRupeesPerDay: 50000 });
  });
});

describe("registerDomainCommand — refusals write nothing", () => {
  it("test mode READS and reports; it registers nothing", async () => {
    const { result } = await registerDomainCommand(ctx("test"));
    expect(result).toMatchObject({ dryRun: true, wouldRegister: true, available: true, costRupees: 550, dmsAccount: "would_be_created" });
    noWrites();
  });

  it("a TEST-mode payment is held live, before any write", async () => {
    await expect(registerDomainCommand(ctx("live", { paymentMode: "test" }))).rejects.toThrow(HOLD_PREFIX);
    noWrites();
  });

  it("paid less than cost is held", async () => {
    await expect(registerDomainCommand(ctx("live", { coverRupees: 100 }))).rejects.toThrow(/only ₹100 was paid/);
    noWrites();
  });

  it("the daily count cap holds the next one", async () => {
    usageRows.rows = Array.from({ length: 5 }, () => ({ status: "succeeded", result: { changed: true, costRupees: 550 } }));
    await expect(registerDomainCommand(ctx("live"))).rejects.toThrow(/daily limit/);
    noWrites();
  });

  it("dry runs and already-registered retries do not count toward the cap", async () => {
    usageRows.rows = [
      ...Array.from({ length: 5 }, () => ({ status: "succeeded", result: { dryRun: true } })),
      ...Array.from({ length: 5 }, () => ({ status: "succeeded", result: { changed: false } })),
    ];
    const { result } = await registerDomainCommand(ctx("live"));
    expect(result.changed).toBe(true);
  });

  it("a stale price cache is held — a cost check against an old price is not a check", async () => {
    pricing.getDomainPricing.mockResolvedValue({ stale: true });
    await expect(registerDomainCommand(ctx("live"))).rejects.toThrow(/could not be read/);
    noWrites();
  });

  it("registered to a DIFFERENT customer of ours is held", async () => {
    rc.getDomainOrderId.mockResolvedValue({ kind: "found", orderId: "77" });
    rc.getDomainDetails.mockResolvedValue({ kind: "found", details: { customerid: "999" } });
    api.getCustomerId.mockResolvedValue({ status: "success", customerId: 111 });
    await expect(registerDomainCommand(ctx("live"))).rejects.toThrow(/different customer/);
    noWrites();
  });

  it("an incomplete address is refused", async () => {
    await expect(registerDomainCommand(ctx("live", { registrant: { ...registrant, address: { ...registrant.address, city: "" } } }))).rejects.toThrow(/city/);
    noWrites();
  });
});

describe("registerDomainCommand — the one path that spends", () => {
  it("registers once, under the customer's own ResellerClub records, and records it on their DMS account", async () => {
    const { result } = await registerDomainCommand(ctx("live"));
    expect(api.registerDomain).toHaveBeenCalledTimes(1);
    expect(api.registerDomain).toHaveBeenCalledWith(expect.objectContaining({ domainName: "acme.in", years: 1, customerId: 111, adminContactId: 222 }));
    expect(users.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "asha@example.invalid", isActivated: true }));
    expect(domainModel.create).toHaveBeenCalledWith(expect.objectContaining({ userId: "U-NEW", domainName: "acme.in", orderId: "rsos:Q-TEST-1", price: 749 }));
    expect(result).toMatchObject({ ok: true, changed: true, costRupees: 550, recorded: true, dmsUserCreated: true });
  });

  it("reuses an existing DMS account", async () => {
    users.getUserByEmail.mockResolvedValue({ _id: "U-OLD" });
    await registerDomainCommand(ctx("live"));
    expect(users.createUser).not.toHaveBeenCalled();
    expect(domainModel.create).toHaveBeenCalledWith(expect.objectContaining({ userId: "U-OLD" }));
  });

  it("already registered to THIS customer is done with nothing spent (the retry case)", async () => {
    rc.getDomainOrderId.mockResolvedValue({ kind: "found", orderId: "77" });
    rc.getDomainDetails.mockResolvedValue({ kind: "found", details: { customerid: "111" } });
    api.getCustomerId.mockResolvedValue({ status: "success", customerId: 111 });
    const { result } = await registerDomainCommand(ctx("live"));
    expect(result).toMatchObject({ changed: false, alreadyRegistered: true });
    noWrites();
  });

  it("a lost response HOLDS the claim (sent_unknown), never reads as not-sent", async () => {
    api.registerDomain.mockResolvedValue({ status: "error", transport: "sent_unknown", message: "timeout" });
    const err = await registerDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });

  it("a thrown network error after sending is sent_unknown too", async () => {
    api.registerDomain.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    const err = await registerDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });

  it("balance pending at ResellerClub holds for a person, it is not a retryable failure", async () => {
    api.registerDomain.mockResolvedValue({ status: "error", transport: "responded", message: "Insufficient funds in your account" });
    const err = await registerDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });

  it("a plain refusal is `responded`, so the claim is released", async () => {
    api.registerDomain.mockResolvedValue({ status: "error", transport: "responded", message: "Domain name is invalid" });
    const err = await registerDomainCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("responded");
    expect(domainModel.create).not.toHaveBeenCalled();
  });

  it("if the DMS row cannot be written the registration still reports success — it happened", async () => {
    domainModel.create.mockRejectedValue(new Error("mongo down"));
    const { result } = await registerDomainCommand(ctx("live"));
    expect(result).toMatchObject({ changed: true, recorded: false });
  });
});

describe("reconcileRegister", () => {
  const rctx = { commandId: "cmd-1", subject: "acme.in", request: payload() };
  it("in our account for this customer → done", async () => {
    rc.getDomainOrderId.mockResolvedValue({ kind: "found", orderId: "77" });
    rc.getDomainDetails.mockResolvedValue({ kind: "found", details: { customerid: "111" } });
    api.getCustomerId.mockResolvedValue({ status: "success", customerId: 111 });
    expect(await reconcileRegister(rctx as never)).toBe("done");
  });
  it("not in our account → not_done", async () => {
    expect(await reconcileRegister(rctx as never)).toBe("not_done");
  });
  it("someone else's, or unreadable → unknown", async () => {
    rc.getDomainOrderId.mockResolvedValue({ kind: "found", orderId: "77" });
    rc.getDomainDetails.mockResolvedValue({ kind: "found", details: { customerid: "999" } });
    api.getCustomerId.mockResolvedValue({ status: "success", customerId: 111 });
    expect(await reconcileRegister(rctx as never)).toBe("unknown");
    rc.getDomainOrderId.mockResolvedValue({ kind: "hard_failure", reason: "x" });
    expect(await reconcileRegister(rctx as never)).toBe("unknown");
  });
});
