/**
 * `hosting.provision` (24 Sep 2026) — a paid customer's DirectAdmin account.
 *
 * The property that matters most: a retry after a lost response ADOPTS the
 * account the first attempt made; it never creates a second one. So usernames
 * are deterministic per domain and DirectAdmin is read before any write.
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

const hostingDoc = () => {
  const doc: Record<string, unknown> = { _id: "H1", save: vi.fn(async () => doc) };
  return doc;
};
const hostingModel = vi.hoisted(() => ({ findOne: vi.fn(), create: vi.fn() }));
vi.mock("@/models/Hosting", () => ({ default: hostingModel }));
vi.mock("@/lib/mongodb", () => ({ default: async () => undefined }));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const email = vi.hoisted(() => ({ sendPasswordResetEmail: vi.fn(async () => true) }));
vi.mock("@/lib/email", () => ({ EmailService: email }));

import { daUsernameFor, provisionHostingCommand, reconcileProvision, parseProvision } from "@/lib/integrations/engine-handlers-provision";
import { transportOf } from "@/lib/integrations/engine-attempt";
import { HOLD_PREFIX } from "@/lib/integrations/engine-register-policy";

const customer = { firstName: "Asha", lastName: "Verma", email: "asha@example.invalid", phone: "9876543210" };
const payload = (over: Record<string, unknown> = {}) => ({ planId: "starter", months: 12, customer, paymentMode: "live", sourceRef: "Q-1", ...over });
const ctx = (mode: "test" | "live", over: Record<string, unknown> = {}) => ({ commandId: "c1", subject: "acme.in", mode, payload: payload(over) });

const u0 = daUsernameFor("acme.in", 0);
const u1 = daUsernameFor("acme.in", 1);
let created: Record<string, unknown>;

beforeEach(() => {
  email.sendPasswordResetEmail.mockClear();
  for (const f of [da.getUserConfig, svc.createUser, plans.getPlanByPlanId, users.getUserByEmail, users.createUser, users.setUserDirectAdminUsername, hostingModel.findOne, hostingModel.create]) f.mockReset();
  plans.getPlanByPlanId.mockResolvedValue({ planId: "Starter", name: "Starter", directAdminPackage: "Starter" });
  users.getUserByEmail.mockResolvedValue(null);
  users.createUser.mockResolvedValue({ _id: "U1", email: "asha@example.invalid" });
  hostingModel.findOne.mockResolvedValue(null);
  created = hostingDoc();
  hostingModel.create.mockResolvedValue(created);
  da.getUserConfig.mockResolvedValue({ kind: "user_not_found", reason: "no such user" });
  svc.createUser.mockResolvedValue({});
});

const noWrites = () => {
  expect(users.createUser).not.toHaveBeenCalled();
  expect(hostingModel.create).not.toHaveBeenCalled();
  expect(svc.createUser).not.toHaveBeenCalled();
};

describe("usernames are deterministic", () => {
  it("the same domain always gives the same candidates, in DMS's 10-character shape", () => {
    expect(daUsernameFor("acme.in", 0)).toBe(u0);
    expect(u0).toMatch(/^acmei[0-9a-f]{5}$/);
    expect(u1).not.toBe(u0);
    expect(daUsernameFor("123shop.in", 0)).toMatch(/^shopi/); // must start with a letter
  });
});

describe("refusals write nothing", () => {
  it("test mode reads and reports", async () => {
    const { result } = await provisionHostingCommand(ctx("test"));
    expect(result).toMatchObject({ dryRun: true, action: "would_create_account", daUsername: u0, package: "Starter", dmsAccount: "would_be_created", wouldProvision: true });
    noWrites();
  });
  it("a test-mode payment is held live", async () => {
    await expect(provisionHostingCommand(ctx("live", { paymentMode: "test" }))).rejects.toThrow(HOLD_PREFIX);
    noWrites();
  });
  it("an unknown or inactive plan is held — the package comes from the catalogue", async () => {
    plans.getPlanByPlanId.mockResolvedValue(null);
    await expect(provisionHostingCommand(ctx("live"))).rejects.toThrow(/not an active plan/);
    noWrites();
  });
  it("DirectAdmin unreadable → nothing created", async () => {
    da.getUserConfig.mockResolvedValue({ kind: "da_unreachable", reason: "timeout" });
    await expect(provisionHostingCommand(ctx("live"))).rejects.toThrow(/Could not ask DirectAdmin/);
    noWrites();
  });
  it("all candidates taken by other domains → held", async () => {
    da.getUserConfig.mockResolvedValue({ kind: "found", config: { domain: "other.in" } });
    await expect(provisionHostingCommand(ctx("live"))).rejects.toThrow(/belong to other domains/);
    noWrites();
  });
  it("missing customer details are refused", () => {
    expect(() => parseProvision(payload({ customer: { firstName: "A" } }))).toThrow(/last name, a valid email/);
    expect(() => parseProvision(payload({ months: 6 }))).toThrow(/months/);
  });
});

describe("the path that creates", () => {
  it("creates ONE account under the first free candidate, with the catalogue package, and activates the Hosting row", async () => {
    const { result } = await provisionHostingCommand(ctx("live"));
    expect(svc.createUser).toHaveBeenCalledTimes(1);
    expect(svc.createUser).toHaveBeenCalledWith(u0, "asha@example.invalid", "acme.in", "Starter", "10.0.0.1");
    expect(hostingModel.create).toHaveBeenCalledWith(expect.objectContaining({ userId: "U1", domainName: "acme.in", serverPackage: "Starter", status: "pending", orderId: "rsos:Q-1" }));
    expect(created.status).toBe("active");
    expect(created.directAdminUsername).toBe(u0);
    expect(result).toMatchObject({ changed: true, adopted: false, daUsername: u0, dmsUserCreated: true, recorded: true });
  });

  it("skips a candidate owned by another domain and uses the next", async () => {
    da.getUserConfig.mockImplementation(async ({ username }: { username: string }) =>
      username === u0 ? { kind: "found", config: { domain: "someoneelse.in" } } : { kind: "user_not_found", reason: "" }
    );
    await provisionHostingCommand(ctx("live"));
    expect(svc.createUser).toHaveBeenCalledWith(u1, expect.anything(), "acme.in", "Starter", "10.0.0.1");
  });

  it("a RETRY after a lost response adopts the existing account and creates nothing", async () => {
    da.getUserConfig.mockImplementation(async ({ username }: { username: string }) =>
      username === u0 ? { kind: "found", config: { domain: "acme.in" } } : { kind: "user_not_found", reason: "" }
    );
    const { result } = await provisionHostingCommand(ctx("live"));
    expect(svc.createUser).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: false, adopted: true, daUsername: u0 });
    expect(created.status).toBe("active");
  });

  it("already provisioned for this customer → done, nothing read or written at DirectAdmin", async () => {
    users.getUserByEmail.mockResolvedValue({ _id: "U1", email: "asha@example.invalid" });
    hostingModel.findOne.mockResolvedValue({ _id: "H9", directAdminUsername: "acmeiabcde" });
    const { result } = await provisionHostingCommand(ctx("live"));
    expect(result).toMatchObject({ changed: false, alreadyProvisioned: true });
    expect(da.getUserConfig).not.toHaveBeenCalled();
    noWrites();
  });

  it("a lost response is sent_unknown, so the claim is held", async () => {
    svc.createUser.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    const err = await provisionHostingCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });

  it("a username taken between read and write is a hold, not a success", async () => {
    svc.createUser.mockRejectedValue(Object.assign(new Error("That username already exists on the system"), { status: 400 }));
    const err = await provisionHostingCommand(ctx("live")).catch((e) => e);
    expect(String(err.message)).toContain(HOLD_PREFIX);
    expect(created.status).not.toBe("active");
  });
});

describe("a new DMS account gets a way in", () => {
  it("sets a setup token and sends the 'set your password' email — ResellerOS has no customer portal to hand off from", async () => {
    const saved = vi.fn(async () => undefined);
    const user: Record<string, unknown> = { _id: "U1", email: "asha@example.invalid", save: saved };
    users.createUser.mockResolvedValue(user);
    await provisionHostingCommand(ctx("live"));
    expect(typeof user.resetToken).toBe("string");
    expect((user.resetToken as string).length).toBe(64);
    expect(saved).toHaveBeenCalled();
    expect(email.sendPasswordResetEmail).toHaveBeenCalledWith("asha@example.invalid", "Asha Verma", user.resetToken, true);
  });
  it("an existing account gets no email", async () => {
    users.getUserByEmail.mockResolvedValue({ _id: "U1", email: "asha@example.invalid" });
    await provisionHostingCommand(ctx("live"));
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe("reconcileProvision", () => {
  const r = { commandId: "c1", subject: "acme.in", request: payload() };
  it("an account for this domain under a candidate → done", async () => {
    da.getUserConfig.mockResolvedValue({ kind: "found", config: { domain: "acme.in" } });
    expect(await reconcileProvision(r as never)).toBe("done");
  });
  it("no account → not_done", async () => {
    expect(await reconcileProvision(r as never)).toBe("not_done");
  });
  it("unreadable → unknown", async () => {
    da.getUserConfig.mockResolvedValue({ kind: "da_unreachable", reason: "x" });
    expect(await reconcileProvision(r as never)).toBe("unknown");
  });
});
