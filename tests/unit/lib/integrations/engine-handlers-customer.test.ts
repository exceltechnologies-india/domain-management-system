/** customer.ensure — the portal account the moment a customer has paid (7 Oct 2026). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureDmsUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/engine-customer", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/engine-customer")>()),
  ensureDmsUser,
}));
const getUserByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserByEmail }));

import { ensureCustomerCommand } from "@/lib/integrations/engine-handlers-customer";
import { OWN_LIVE_GATES } from "@/lib/integrations/engine-mode";
import { HANDLERS, KNOWN_COMMANDS } from "@/lib/integrations/engine-command-registry";

const customer = { firstName: "Asha", lastName: "Verma", email: "asha@example.in", phone: "9811122233" };
const ctx = (mode: "test" | "live", over: Record<string, unknown> = {}) =>
  ({ commandId: "c1", subject: "Asha@Example.in", mode, payload: { customer, ...over } });

beforeEach(() => { ensureDmsUser.mockReset(); getUserByEmail.mockReset(); });

describe("customer.ensure", () => {
  it("is a known command with a handler and its own live gate", () => {
    expect(KNOWN_COMMANDS).toContain("customer.ensure");
    expect(HANDLERS["customer.ensure"]).toBe(ensureCustomerCommand);
    expect(OWN_LIVE_GATES["customer.ensure"]).toBe("ENGINE_CUSTOMER_ACCOUNT_LIVE");
  });
  it("live: creates the account (which emails the one-time password) and says so", async () => {
    ensureDmsUser.mockResolvedValueOnce({ user: { _id: "U1" }, created: true });
    const { result } = await ensureCustomerCommand(ctx("live"));
    expect(ensureDmsUser).toHaveBeenCalledWith(expect.objectContaining({ email: "asha@example.in", firstName: "Asha" }));
    expect(result).toEqual({ ok: true, email: "asha@example.in", userId: "U1", created: true, emailed: true });
  });
  it("live: an existing account is found, not emailed again", async () => {
    ensureDmsUser.mockResolvedValueOnce({ user: { _id: "U9" }, created: false });
    const { result } = await ensureCustomerCommand(ctx("live"));
    expect(result).toMatchObject({ created: false, emailed: false });
  });
  it("test mode creates nothing and reports what live would do", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    const { result } = await ensureCustomerCommand(ctx("test"));
    expect(result).toEqual({ ok: true, dryRun: true, wouldCreate: true, email: "asha@example.in" });
    expect(ensureDmsUser).not.toHaveBeenCalled();
  });
  it("refuses when the subject is not the customer's email, and when details are missing", async () => {
    await expect(ensureCustomerCommand({ ...ctx("live"), subject: "other@example.in" })).rejects.toThrow(/nothing was done/);
    await expect(ensureCustomerCommand(ctx("live", { customer: { ...customer, lastName: "" } }))).rejects.toThrow(/last name/);
    expect(ensureDmsUser).not.toHaveBeenCalled();
  });
});
