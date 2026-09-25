/**
 * `hosting.provision` with `trial: true` (25 Sep 2026) — ResellerOS's free
 * Starter trial, created by THIS engine so DMS stays the only DirectAdmin writer.
 *
 * What must hold:
 *   - a trial and a sale cannot be mistaken for each other (trial:true and
 *     paymentMode:"trial" travel together, both ways);
 *   - Starter only;
 *   - one trial per customer across both apps, failing CLOSED on a read error;
 *   - the trial being provisioned does not block itself — neither its own
 *     ResellerOS record (trialRef) nor, on a retry, its own Hosting row.
 *
 * trial-history.ts runs for real here against in-memory model stubs, so the
 * "own trialRef is ignored" case is proved through the actual query, not a mock
 * of the function that builds it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const da = vi.hoisted(() => ({ getUserConfig: vi.fn() }));
vi.mock("@/lib/integrations/directadmin", () => da);
const svc = vi.hoisted(() => ({ createUser: vi.fn() }));
vi.mock("@/lib/directadmin", () => ({ DirectAdminService: svc, DA_SERVER_IP: "10.0.0.1" }));
const plans = vi.hoisted(() => ({ getPlanByPlanId: vi.fn() }));
vi.mock("@/lib/services/hosting-plans", () => plans);
const users = vi.hoisted(() => ({ getUserByEmail: vi.fn(), createUser: vi.fn(), setUserDirectAdminUsername: vi.fn() }));
vi.mock("@/lib/services/users", () => users);
vi.mock("@/lib/mongodb", () => ({ default: async () => undefined }));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({ EmailService: { sendPasswordResetEmail: vi.fn(async () => true) } }));

type Row = Record<string, unknown>;
/** Enough of Mongo's matcher for the queries trial-history and the handler make. */
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return (cond as Row[]).some((f) => matches(row, f));
    if (k === "$nor") return !(cond as Row[]).some((f) => matches(row, f));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Row;
      if ("$ne" in c) return row[k] !== c.$ne;
      if ("$in" in c) return (c.$in as unknown[]).includes(row[k]);
      if ("$regex" in c) return new RegExp(String(c.$regex)).test(String(row[k] ?? ""));
    }
    return row[k] === cond;
  });
}
/** A query result that is both awaitable (the handler) and chainable (trial-history). */
function query(value: unknown, fail?: Error) {
  const settle = async () => {
    if (fail) throw fail;
    return value;
  };
  const chain = {
    sort: () => chain, select: () => chain, limit: () => chain, lean: settle,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej),
  };
  return chain;
}

const store = vi.hoisted(() => ({
  external: [] as Record<string, unknown>[],
  hostings: [] as Record<string, unknown>[],
  externalError: null as Error | null,
}));
vi.mock("@/models/ExternalTrial", () => ({
  default: { findOne: (f: Row) => query(store.external.find((r) => matches(r, f)) ?? null, store.externalError ?? undefined) },
}));
vi.mock("@/models/Order", () => ({ default: { findOne: () => query(null) } }));
vi.mock("@/models/User", () => ({ default: { find: () => query([]) } }));
const hostingModel = vi.hoisted(() => ({ findOne: vi.fn(), create: vi.fn() }));
vi.mock("@/models/Hosting", () => ({ default: hostingModel }));

import { daUsernameFor, provisionHostingCommand, reconcileProvision, parseProvision, TRIAL_DAYS } from "@/lib/integrations/engine-handlers-provision";
import { checkLiveAllowed } from "@/lib/integrations/engine-mode";

const customer = { firstName: "Asha", lastName: "Verma", email: "asha@example.invalid", phone: "9876543210" };
const trialPayload = (over: Record<string, unknown> = {}) => ({
  planId: "starter", trial: true, paymentMode: "trial", trialRef: "L-TRIAL-1", customer, sourceRef: "L-TRIAL-1", ...over,
});
const ctx = (mode: "test" | "live", over: Record<string, unknown> = {}) => ({ commandId: "c1", subject: "acme.in", mode, payload: trialPayload(over) });
const u0 = daUsernameFor("acme.in", 0);
const DAY = 24 * 60 * 60 * 1000;

let createdRow: Row;
beforeEach(() => {
  store.external = [];
  store.hostings = [];
  store.externalError = null;
  for (const f of [da.getUserConfig, svc.createUser, plans.getPlanByPlanId, users.getUserByEmail, users.createUser, users.setUserDirectAdminUsername, hostingModel.findOne, hostingModel.create]) f.mockReset();
  plans.getPlanByPlanId.mockResolvedValue({ planId: "Starter", name: "Starter", directAdminPackage: "Starter" });
  users.getUserByEmail.mockResolvedValue(null);
  users.createUser.mockResolvedValue({ _id: "U1", email: "asha@example.invalid" });
  hostingModel.findOne.mockImplementation((f: Row) => query(store.hostings.find((r) => matches(r, f)) ?? null));
  hostingModel.create.mockImplementation(async (doc: Row) => {
    createdRow = { _id: "H1", ...doc, save: vi.fn(async () => createdRow) };
    store.hostings.push(createdRow);
    return createdRow;
  });
  da.getUserConfig.mockResolvedValue({ kind: "user_not_found", reason: "no such user" });
  svc.createUser.mockResolvedValue({});
});

const nothingWritten = () => {
  expect(users.createUser).not.toHaveBeenCalled();
  expect(hostingModel.create).not.toHaveBeenCalled();
  expect(svc.createUser).not.toHaveBeenCalled();
};

describe("the happy path", () => {
  it("creates ONE Starter account and a Hosting row that says it is a 15-day trial", async () => {
    const before = Date.now();
    const { result } = await provisionHostingCommand(ctx("live", { cycle: "monthly" }));
    expect(svc.createUser).toHaveBeenCalledTimes(1);
    expect(svc.createUser).toHaveBeenCalledWith(u0, "asha@example.invalid", "acme.in", "Starter", "10.0.0.1");

    const doc = hostingModel.create.mock.calls[0][0] as Row;
    expect(doc).toMatchObject({
      isTrial: true, billingType: "manual", billingCycle: "monthly", autoRenew: false, last_reminder_sent: null,
      orderId: "rsos-trial:L-TRIAL-1", paymentId: "rsos-trial:L-TRIAL-1", planId: "Starter", serverPackage: "Starter",
    });
    const expiry = (doc.expiryDate as Date).getTime();
    expect(expiry - before).toBeGreaterThanOrEqual(TRIAL_DAYS * DAY - 1000);
    expect(expiry - before).toBeLessThanOrEqual(TRIAL_DAYS * DAY + 60_000);
    // First reminder 2 days before the end, as the manual-flow trial does.
    expect(expiry - (doc.next_action_at as Date).getTime()).toBe(2 * DAY);

    expect(createdRow.status).toBe("active");
    expect(createdRow.directAdminUsername).toBe(u0);
    expect(result).toMatchObject({ ok: true, trial: true, cycle: "monthly", amount: 0, changed: true, daUsername: u0 });
  });

  it("cycle defaults to yearly, and months is ignored", async () => {
    await provisionHostingCommand(ctx("live", { months: 7 }));
    expect(hostingModel.create.mock.calls[0][0]).toMatchObject({ billingCycle: "yearly", isTrial: true });
  });

  it("test mode reads and reports a trial without writing", async () => {
    const { result } = await provisionHostingCommand(ctx("test"));
    expect(result).toMatchObject({ dryRun: true, trial: true, trialDays: 15, wouldProvision: true, hold: null, action: "would_create_account" });
    nothingWritten();
  });

  it("the reconciler works for a trial row exactly as for a sale", async () => {
    const r = { commandId: "c1", subject: "acme.in", request: trialPayload() };
    expect(await reconcileProvision(r as never)).toBe("not_done");
    da.getUserConfig.mockResolvedValue({ kind: "found", config: { domain: "acme.in" } });
    expect(await reconcileProvision(r as never)).toBe("done");
  });
});

describe("a trial and a sale cannot be mistaken for each other", () => {
  it("only Starter can be trialled", async () => {
    for (const planId of ["standard", "plus", "Business"]) {
      await expect(provisionHostingCommand(ctx("live", { planId }))).rejects.toThrow(/only on the Starter plan/);
    }
    expect(plans.getPlanByPlanId).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("a trial that claims a live or test payment is refused", async () => {
    for (const paymentMode of ["live", "test", undefined]) {
      await expect(provisionHostingCommand(ctx("live", { paymentMode }))).rejects.toThrow(/must send "paymentMode": "trial"/);
    }
    nothingWritten();
  });

  it("a paid provision that claims paymentMode trial is refused", () => {
    expect(() => parseProvision({ planId: "starter", months: 12, paymentMode: "trial", customer, sourceRef: "Q-1" }))
      .toThrow(/only valid with "trial": true/);
    expect(() => parseProvision({ planId: "starter", trial: false, months: 12, paymentMode: "trial", customer, sourceRef: "Q-1" }))
      .toThrow(/only valid with "trial": true/);
  });

  it("a non-boolean trial flag, a bad cycle or a non-string trialRef is refused", () => {
    expect(() => parseProvision(trialPayload({ trial: "true" }))).toThrow(/JSON boolean/);
    expect(() => parseProvision(trialPayload({ cycle: "weekly" }))).toThrow(/"cycle"/);
    expect(() => parseProvision(trialPayload({ trialRef: 12 }))).toThrow(/"trialRef"/);
  });

  it("a paid provision is unchanged: no trial fields, rsos: prefix", async () => {
    await provisionHostingCommand({ commandId: "c2", subject: "acme.in", mode: "live", payload: { planId: "starter", months: 12, paymentMode: "live", customer, sourceRef: "Q-1" } });
    const doc = hostingModel.create.mock.calls[0][0] as Row;
    expect(doc.orderId).toBe("rsos:Q-1");
    expect(doc).not.toHaveProperty("isTrial");
    expect(doc).not.toHaveProperty("next_action_at");
  });
});

describe("one free trial per customer, across both apps", () => {
  it("a trial ResellerOS recorded earlier for this customer refuses the trial", async () => {
    store.external.push({ ref: "L-OLD", email: "asha@example.invalid", createdAt: new Date("2026-08-01") });
    await expect(provisionHostingCommand(ctx("live"))).rejects.toThrow(/already had a free hosting trial/);
    nothingWritten();
  });

  it("a DMS trial on the same domain refuses the trial", async () => {
    store.hostings.push({ isTrial: true, domainName: "acme.in", orderId: "ord_x", startDate: new Date("2026-09-01") });
    await expect(provisionHostingCommand(ctx("live"))).rejects.toThrow(/already had a free hosting trial/);
    nothingWritten();
  });

  it("the customer's OWN just-recorded ResellerOS trial (ref = trialRef) does not block it", async () => {
    store.external.push({ ref: "L-TRIAL-1", email: "asha@example.invalid", domain: "acme.in", createdAt: new Date() });
    const { result } = await provisionHostingCommand(ctx("live"));
    expect(result).toMatchObject({ ok: true, trial: true });
  });

  it("…but only that exact ref: without trialRef the same record blocks, and another ref still blocks", async () => {
    store.external.push({ ref: "L-TRIAL-1", email: "asha@example.invalid", createdAt: new Date() });
    await expect(provisionHostingCommand(ctx("live", { trialRef: undefined }))).rejects.toThrow(/already had a free hosting trial/);
    await expect(provisionHostingCommand(ctx("live", { trialRef: "L-OTHER" }))).rejects.toThrow(/already had a free hosting trial/);
    nothingWritten();
  });

  it("a retry after the Hosting row was written but DirectAdmin failed is not refused by its own row", async () => {
    svc.createUser.mockRejectedValueOnce(Object.assign(new Error("internal error"), { status: 500 }));
    await expect(provisionHostingCommand(ctx("live"))).rejects.toThrow();
    expect(store.hostings).toHaveLength(1);
    users.getUserByEmail.mockResolvedValue({ _id: "U1", email: "asha@example.invalid" });
    const { result } = await provisionHostingCommand(ctx("live"));
    expect(result).toMatchObject({ ok: true, trial: true, changed: true });
    expect(hostingModel.create).toHaveBeenCalledTimes(1); // the first row was reused
  });

  it("a finished trial, asked again, is answered as done — not refused as a second trial", async () => {
    await provisionHostingCommand(ctx("live"));
    users.getUserByEmail.mockResolvedValue({ _id: "U1", email: "asha@example.invalid" });
    const { result } = await provisionHostingCommand(ctx("live"));
    expect(result).toMatchObject({ alreadyProvisioned: true });
  });

  it("an unreadable trial history refuses — it is never read as 'no earlier trial'", async () => {
    store.externalError = new Error("mongo down");
    await expect(provisionHostingCommand(ctx("live"))).rejects.toThrow(/Could not read the free-trial history.*mongo down/);
    await expect(provisionHostingCommand(ctx("test"))).rejects.toThrow(/Could not read the free-trial history/);
    nothingWritten();
  });
});

describe("the live gate still applies to a trial", () => {
  it("hosting.provision runs live only with ENGINE_HOSTING_PROVISION_LIVE=1 — a trial is the same command", () => {
    const saved = process.env.ENGINE_HOSTING_PROVISION_LIVE;
    try {
      delete process.env.ENGINE_HOSTING_PROVISION_LIVE;
      const shut = checkLiveAllowed("live", "hosting.provision");
      expect(shut.ok).toBe(false);
      process.env.ENGINE_HOSTING_PROVISION_LIVE = "true";
      expect(checkLiveAllowed("live", "hosting.provision").ok).toBe(false);
      process.env.ENGINE_HOSTING_PROVISION_LIVE = "1";
      expect(checkLiveAllowed("live", "hosting.provision").ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ENGINE_HOSTING_PROVISION_LIVE;
      else process.env.ENGINE_HOSTING_PROVISION_LIVE = saved;
    }
  });
});
