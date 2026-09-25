import { describe, it, expect, vi, beforeEach } from "vitest";

const ext = vi.hoisted(() => ({ findOne: vi.fn(), updateOne: vi.fn() }));
const hosting = vi.hoisted(() => ({ findOne: vi.fn() }));
const order = vi.hoisted(() => ({ findOne: vi.fn() }));
const user = vi.hoisted(() => ({ find: vi.fn() }));
/** A mongoose query stub: .sort().lean() / .select().limit().lean() resolve to `value`. */
const q = (value: unknown) => {
  const chain = { sort: () => chain, select: () => chain, limit: () => chain, lean: async () => value };
  return chain;
};
vi.mock("@/lib/mongodb", () => ({ default: async () => undefined }));
vi.mock("@/models/ExternalTrial", () => ({ default: ext }));
vi.mock("@/models/Hosting", () => ({ default: hosting }));
vi.mock("@/models/Order", () => ({ default: order }));
vi.mock("@/models/User", () => ({ default: user }));

import { findPriorTrial, recordExternalTrial, trialKeys } from "@/lib/trials/trial-history";

beforeEach(() => {
  ext.findOne.mockReset().mockReturnValue(q(null));
  ext.updateOne.mockReset().mockResolvedValue({ upsertedCount: 1 });
  hosting.findOne.mockReset().mockReturnValue(q(null));
  order.findOne.mockReset().mockReturnValue(q(null));
  user.find.mockReset().mockReturnValue(q([]));
});

describe("trialKeys — one normalisation for both apps", () => {
  it("lower-cases the email, keeps the last 10 phone digits, strips a domain to its name", () => {
    expect(trialKeys({ email: " A@B.In ", phone: "+91 98765-43210", domain: "https://WWW.Acme.in/path" }))
      .toEqual({ email: "a@b.in", phoneKey: "9876543210", domain: "acme.in" });
    expect(trialKeys({ phone: "12345" }).phoneKey).toBe("");
  });
});

describe("findPriorTrial — a trial in EITHER app counts", () => {
  it("a trial the ResellerOS site recorded, on any key", async () => {
    ext.findOne.mockReturnValue(q({ createdAt: new Date("2026-09-20") }));
    const r = await findPriorTrial({ email: "a@b.in", phone: "9876543210", domain: "acme.in" });
    expect(r).toMatchObject({ found: true, where: "reselleros" });
    expect(ext.findOne.mock.calls[0][0]).toEqual({ $or: [{ email: "a@b.in" }, { phoneKey: "9876543210" }, { domain: "acme.in" }] });
  });

  it("a DMS trial hosting on the same domain", async () => {
    hosting.findOne.mockReturnValueOnce(q({ startDate: new Date("2026-09-01") }));
    expect(await findPriorTrial({ domain: "acme.in" })).toMatchObject({ found: true, where: "dms" });
  });

  it("a DMS account with the same email or phone that has had a trial order", async () => {
    user.find.mockReturnValue(q([{ _id: "U1" }]));
    order.findOne.mockReturnValue(q({ createdAt: new Date("2026-08-01") }));
    expect(await findPriorTrial({ email: "a@b.in", phone: "9876543210" })).toMatchObject({ found: true, where: "dms" });
    expect(user.find.mock.calls[0][0]).toEqual({ $or: [{ email: "a@b.in" }, { phone: { $regex: "9876543210$" } }] });
  });

  it("an abandoned-at-mandate checkout does not count, as in userHasPriorTrialOrder", async () => {
    user.find.mockReturnValue(q([{ _id: "U1" }]));
    await findPriorTrial({ email: "a@b.in" });
    expect(order.findOne.mock.calls[0][0]).toMatchObject({ $nor: [{ status: "pending", razorpayPaymentId: "pending" }] });
  });

  it("nothing anywhere → not found; no keys → not found without a query", async () => {
    expect(await findPriorTrial({ email: "new@b.in" })).toEqual({ found: false });
    ext.findOne.mockClear();
    expect(await findPriorTrial({})).toEqual({ found: false });
    expect(ext.findOne).not.toHaveBeenCalled();
  });

  it("a database error THROWS — it is never read as 'no earlier trial'", async () => {
    ext.findOne.mockReturnValue({ sort: () => ({ lean: async () => { throw new Error("mongo down"); } }) });
    await expect(findPriorTrial({ email: "a@b.in" })).rejects.toThrow("mongo down");
  });
});

describe("findPriorTrial — the trial being provisioned is excluded by its exact ids", () => {
  it("with no ignore, the queries are exactly as before", async () => {
    await findPriorTrial({ email: "a@b.in", domain: "acme.in" });
    expect(ext.findOne.mock.calls[0][0]).toEqual({ $or: [{ email: "a@b.in" }, { domain: "acme.in" }] });
    expect(hosting.findOne.mock.calls[0][0]).toEqual({ isTrial: true, domainName: "acme.in" });
  });

  it("externalRef excludes that ExternalTrial ref only; hostingOrderId excludes that Hosting row on both Hosting reads", async () => {
    user.find.mockReturnValue(q([{ _id: "U1" }]));
    await findPriorTrial({ email: "a@b.in", domain: "acme.in" }, { externalRef: "L-1", hostingOrderId: "rsos-trial:L-1" });
    expect(ext.findOne.mock.calls[0][0]).toEqual({ $or: [{ email: "a@b.in" }, { domain: "acme.in" }], ref: { $ne: "L-1" } });
    expect(hosting.findOne.mock.calls[0][0]).toEqual({ isTrial: true, domainName: "acme.in", orderId: { $ne: "rsos-trial:L-1" } });
    expect(hosting.findOne.mock.calls[1][0]).toMatchObject({ isTrial: true, orderId: { $ne: "rsos-trial:L-1" } });
  });
});

describe("recordExternalTrial", () => {
  it("upserts on the ResellerOS lead id, so a retried record is a no-op", async () => {
    await recordExternalTrial({ ref: "L-1", email: "A@B.in", phone: "+91 98765 43210", domain: "Acme.in", cycle: "monthly" });
    const [filter, update, opts] = ext.updateOne.mock.calls[0];
    expect(filter).toEqual({ ref: "L-1" });
    expect(update.$setOnInsert).toMatchObject({ email: "a@b.in", phoneKey: "9876543210", domain: "acme.in", cycle: "monthly", source: "reselleros" });
    expect(opts).toEqual({ upsert: true });
  });
});
