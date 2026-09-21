/**
 * hosting.change_plan — Phase 7's one command.
 *
 * Threat model:
 *  - **The DirectAdmin package must come from the plan row, never the payload.**
 *    A caller-supplied package name would be a second source for something the
 *    catalogue owns — the family of defects in AGENTS.md L104/L106, where a
 *    figure copied out of its source went wrong and the guard checking it had
 *    been fed the same copy.
 *  - **Both halves are the effect.** DMS stores the plan on the Hosting row, so
 *    a command that changed only DirectAdmin leaves the customer panel showing
 *    the old plan with no error anywhere. The reconciler checks both; checking
 *    DirectAdmin alone would settle a half-done command as `done`.
 *  - **Ambiguity is refused BEFORE DirectAdmin is touched.** `Hosting` is unique
 *    on `(userId, domainName)`, not on the DA username, so two rows can share a
 *    username. Picking one would be a guess about whose plan changed.
 *  - **Case must not read as a failure.** `changePackage` normalises the name
 *    it sends, so the stored value can differ in case from the one requested.
 *    An exact comparison would report a successful change as `not_done`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserConfig = vi.fn();
const changePackage = vi.fn();
const getPlanByPlanId = vi.fn();
const listHostingsByDirectAdminUsername = vi.fn();

vi.mock("@/lib/integrations/directadmin", () => ({
  getUserConfig: (...a: unknown[]) => getUserConfig(...a),
  changePackage: (...a: unknown[]) => changePackage(...a),
}));
vi.mock("@/lib/services/hosting-plans", () => ({
  getPlanByPlanId: (...a: unknown[]) => getPlanByPlanId(...a),
}));
vi.mock("@/lib/services/hostings", () => ({
  listHostingsByDirectAdminUsername: (...a: unknown[]) =>
    listHostingsByDirectAdminUsername(...a),
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  changeHostingPlan,
  reconcileChangePlan,
} from "@/lib/integrations/engine-handlers-plan";
import { transportOf } from "@/lib/integrations/engine-attempt";

const PLAN = {
  planId: "plus",
  name: "Plus",
  directAdminPackage: "Plus",
  isActive: true,
};

/** A Mongoose-ish doc: the handler mutates fields and calls save(). */
const hostingDoc = (over: Record<string, unknown> = {}) => ({
  domainName: "example.com",
  directAdminUsername: "acct1",
  planId: "starter",
  name: "Starter",
  serverPackage: "Starter",
  save: vi.fn().mockResolvedValue(undefined),
  ...over,
});

const ctx = (
  mode: "test" | "live",
  payload: Record<string, unknown> = { username: "acct1", planId: "plus" }
) => ({ commandId: "c1", subject: "example.com", mode, payload });

let doc: ReturnType<typeof hostingDoc>;

beforeEach(() => {
  getUserConfig.mockReset();
  changePackage.mockReset();
  getPlanByPlanId.mockReset();
  listHostingsByDirectAdminUsername.mockReset();

  doc = hostingDoc();
  getPlanByPlanId.mockResolvedValue(PLAN);
  listHostingsByDirectAdminUsername.mockResolvedValue([doc]);
  getUserConfig.mockResolvedValue({ kind: "found", config: { package: "Starter" } });
  changePackage.mockResolvedValue({ kind: "changed" });
});

describe("everything that can be refused is refused before DirectAdmin", () => {
  it("a missing username or planId is refused, and the message says the catalogue owns the package", async () => {
    await expect(changeHostingPlan(ctx("live", { planId: "plus" }))).rejects.toThrow(/"username"/);
    await expect(changeHostingPlan(ctx("live", { username: "acct1" }))).rejects.toThrow(/"planId"/);
    await expect(changeHostingPlan(ctx("live", {}))).rejects.toThrow(/catalogue owns it/);
    expect(getUserConfig).not.toHaveBeenCalled();
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("a package name in the payload is NOT honoured — the plan decides", async () => {
    await changeHostingPlan(
      ctx("live", { username: "acct1", planId: "plus", newPackage: "Ultimate" })
    );
    expect(changePackage).toHaveBeenCalledWith(
      expect.objectContaining({ newPackage: "Plus" })
    );
  });

  it("an unknown planId is refused with what to do about it", async () => {
    getPlanByPlanId.mockResolvedValue(null);
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/No hosting plan called "plus"/);
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/Add the plan in DMS/);
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("a plan with no directAdminPackage is refused rather than guessed at", async () => {
    getPlanByPlanId.mockResolvedValue({ ...PLAN, directAdminPackage: "" });
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/no directAdminPackage set/);
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("no matching hosting row is refused, and the message lists what that account DOES have", async () => {
    listHostingsByDirectAdminUsername.mockResolvedValue([hostingDoc({ domainName: "other.com" })]);
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/No hosting record in DMS/);
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/other\.com/);
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("TWO matching rows is refused — picking one would be a guess", async () => {
    listHostingsByDirectAdminUsername.mockResolvedValue([hostingDoc(), hostingDoc()]);
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/2 hosting records/);
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/Nothing was changed/);
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("an unreachable DirectAdmin is refused before any write", async () => {
    getUserConfig.mockResolvedValue({ kind: "da_unreachable", reason: "ETIMEDOUT" });
    await expect(changeHostingPlan(ctx("live"))).rejects.toThrow(/ETIMEDOUT/);
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("every one of those refusals is unbranded, so the route reads not_sent", async () => {
    getPlanByPlanId.mockResolvedValue(null);
    const err = await changeHostingPlan(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBeNull();
  });
});

describe("test mode reads and writes nothing", () => {
  it("names both halves it would change", async () => {
    const { result } = await changeHostingPlan(ctx("test"));
    expect(result).toMatchObject({ dryRun: true, changed: false });
    expect(result.wouldChange).toEqual([
      "DirectAdmin: Starter -> Plus",
      "DMS record: Starter -> Plus",
    ]);
    expect(changePackage).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("lists only the half that is actually behind", async () => {
    // DirectAdmin already moved; only the DMS record is stale.
    getUserConfig.mockResolvedValue({ kind: "found", config: { package: "Plus" } });
    const { result } = await changeHostingPlan(ctx("test"));
    expect(result.wouldChange).toEqual(["DMS record: Starter -> Plus"]);
  });
});

describe("a live change writes DirectAdmin and then the record", () => {
  it("does both and reports what it did", async () => {
    const { result } = await changeHostingPlan(ctx("live"));
    expect(changePackage).toHaveBeenCalledWith({ username: "acct1", newPackage: "Plus" });
    expect(doc.planId).toBe("plus");
    expect(doc.name).toBe("Plus");
    expect(doc.serverPackage).toBe("Plus");
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, changed: true, directAdminChanged: true });
  });

  it("still fixes a stale RECORD when DirectAdmin is already right", async () => {
    // The half that would otherwise be invisible: the server is correct and
    // the customer panel is not.
    getUserConfig.mockResolvedValue({ kind: "found", config: { package: "Plus" } });
    const { result } = await changeHostingPlan(ctx("live"));
    expect(changePackage).not.toHaveBeenCalled();
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ changed: true, directAdminChanged: false });
  });

  it("already on the plan in BOTH places changes nothing and is a success", async () => {
    getUserConfig.mockResolvedValue({ kind: "found", config: { package: "Plus" } });
    listHostingsByDirectAdminUsername.mockResolvedValue([
      hostingDoc({ planId: "plus", serverPackage: "Plus", name: "Plus" }),
    ]);
    const { result } = await changeHostingPlan(ctx("live"));
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(changePackage).not.toHaveBeenCalled();
  });

  it("a case difference is not a change — DA normalises what it stores", async () => {
    getUserConfig.mockResolvedValue({ kind: "found", config: { package: "plus" } });
    listHostingsByDirectAdminUsername.mockResolvedValue([
      hostingDoc({ planId: "plus", serverPackage: "PLUS", name: "Plus" }),
    ]);
    const { result } = await changeHostingPlan(ctx("live"));
    expect(result.changed).toBe(false);
  });

  it("an inactive plan is allowed and flagged, not refused", async () => {
    // Refusing would block a downgrade to a retired tier — a guard firing on
    // a right answer is one somebody deletes (L103).
    getPlanByPlanId.mockResolvedValue({ ...PLAN, isActive: false });
    const { result } = await changeHostingPlan(ctx("live"));
    expect(result.ok).toBe(true);
    expect(result.planIsActive).toBe(false);
  });
});

describe("when something goes wrong mid-write", () => {
  it("a package DirectAdmin does not have names the plan that points at it", async () => {
    changePackage.mockResolvedValue({ kind: "package_not_found", reason: "no such package" });
    const err = await changeHostingPlan(ctx("live")).catch((e) => e);
    expect(err.message).toMatch(/no package called "Plus"/);
    expect(err.message).toMatch(/fix the plan's directAdminPackage/);
    // DirectAdmin answered, so the subject is released rather than parked.
    expect(transportOf(err)).toBe("responded");
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("a DirectAdmin call that dies in flight is sent_unknown, so the claim is HELD", async () => {
    changePackage.mockRejectedValue(Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    }));
    const err = await changeHostingPlan(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("a record write that fails after DirectAdmin changed says so in full", async () => {
    doc.save.mockRejectedValue(new Error("E11000 duplicate key"));
    const err = await changeHostingPlan(ctx("live")).catch((e) => e);
    expect(err.message).toMatch(/DirectAdmin was changed to "Plus"/);
    expect(err.message).toMatch(/could NOT be updated/);
    // The operator needs to know a second run finishes the job rather than
    // repeating the DirectAdmin half.
    expect(err.message).toMatch(/Sending this command again is safe/);
    expect(transportOf(err)).toBe("responded");
  });
});

describe("the reconciler requires BOTH halves", () => {
  const rctx = { subject: "example.com", request: { username: "acct1", planId: "plus" } };

  it("DirectAdmin and the record both on target → done", async () => {
    getUserConfig.mockResolvedValue({ kind: "found", config: { package: "Plus" } });
    listHostingsByDirectAdminUsername.mockResolvedValue([
      hostingDoc({ planId: "plus", serverPackage: "Plus" }),
    ]);
    expect(await reconcileChangePlan(rctx)).toBe("done");
  });

  it("DirectAdmin moved but the record did not → not_done", async () => {
    // Checking DirectAdmin alone would call this `done` and settle a command
    // that left the customer panel wrong.
    getUserConfig.mockResolvedValue({ kind: "found", config: { package: "Plus" } });
    expect(await reconcileChangePlan(rctx)).toBe("not_done");
  });

  it("the record moved but DirectAdmin did not → not_done", async () => {
    listHostingsByDirectAdminUsername.mockResolvedValue([
      hostingDoc({ planId: "plus", serverPackage: "Plus" }),
    ]);
    expect(await reconcileChangePlan(rctx)).toBe("not_done");
  });

  it("neither moved → not_done", async () => {
    expect(await reconcileChangePlan(rctx)).toBe("not_done");
  });

  it.each([
    ["the account is gone", { kind: "user_not_found", reason: "gone" }],
    ["DirectAdmin is unreachable", { kind: "da_unreachable", reason: "ETIMEDOUT" }],
  ])("%s → unknown, never not_done", async (_label, outcome) => {
    getUserConfig.mockResolvedValue(outcome);
    expect(await reconcileChangePlan(rctx)).toBe("unknown");
  });

  it("DirectAdmin not reporting a package at all → unknown", async () => {
    // An absent field is a missing answer, not a "no".
    getUserConfig.mockResolvedValue({ kind: "found", config: {} });
    expect(await reconcileChangePlan(rctx)).toBe("unknown");
  });

  it("an ambiguous or missing hosting row → unknown", async () => {
    listHostingsByDirectAdminUsername.mockResolvedValue([hostingDoc(), hostingDoc()]);
    expect(await reconcileChangePlan(rctx)).toBe("unknown");
    listHostingsByDirectAdminUsername.mockResolvedValue([]);
    expect(await reconcileChangePlan(rctx)).toBe("unknown");
  });

  it("a plan that has since been deleted → unknown", async () => {
    getPlanByPlanId.mockResolvedValue(null);
    expect(await reconcileChangePlan(rctx)).toBe("unknown");
  });

  it("an unreadable stored request → unknown, and asks nothing", async () => {
    expect(await reconcileChangePlan({ subject: "example.com", request: {} })).toBe("unknown");
    expect(getUserConfig).not.toHaveBeenCalled();
  });
});
