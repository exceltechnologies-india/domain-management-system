/**
 * hosting.renew — a hosting renewal paid in ResellerOS, recorded in DMS.
 *
 * Threat model, in the order these cost something:
 *  - **A second renewal must be refused, not applied.** A retry that extended
 *    the expiry again would give away a term nobody paid for. expiryBefore is
 *    compared against the row, and the write is a compare-and-set on it.
 *  - **A test-mode payment never moves the expiry live**, and the refusal is a
 *    `[held]` sentence so ResellerOS reads it as held.
 *  - **Test mode writes nothing.**
 *  - **A suspended account is unsuspended through hosting.unsuspend's own
 *    path**, and when that fails the renewal is still reported truthfully.
 *  - **The reconciler is exact**: moved → done, unchanged → not_done.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserConfig = vi.fn();
const suspendUser = vi.fn();
const unsuspendUser = vi.fn();
vi.mock("@/lib/integrations/directadmin", () => ({
  getUserConfig: (...a: unknown[]) => getUserConfig(...a),
  suspendUser: (...a: unknown[]) => suspendUser(...a),
  unsuspendUser: (...a: unknown[]) => unsuspendUser(...a),
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/mongodb", () => ({ default: async () => undefined }));

interface Row {
  _id: string;
  domainName: string;
  status: string;
  expiryDate: Date | null;
  directAdminUsername?: string;
}
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  finds: [] as unknown[],
  updates: [] as Array<{ filter: Record<string, unknown>; update: { $set: Record<string, unknown> } }>,
  failUpdate: null as null | ((n: number) => Error | null),
}));
vi.mock("@/models/Hosting", () => ({
  default: {
    find: (filter: unknown) => {
      db.finds.push(filter);
      return { select: () => ({ lean: async () => db.rows.map((r) => ({ ...r })) }) };
    },
    updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const n = db.updates.length;
      db.updates.push({ filter, update });
      const err = db.failUpdate?.(n);
      if (err) throw err;
      const row = db.rows.find(
        (r) =>
          r._id === filter._id &&
          (!("expiryDate" in filter) ||
            (r.expiryDate && (filter.expiryDate as Date).getTime() === r.expiryDate.getTime()))
      );
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

import {
  renewHostingCommand,
  reconcileHostingRenew,
  addCalendarMonthsUtc,
} from "@/lib/integrations/engine-handlers-hosting-renew";
import { HOLD_PREFIX } from "@/lib/integrations/engine-register-policy";
import { transportOf } from "@/lib/integrations/engine-attempt";

/** 15 Mar 2027 10:30:00 UTC, epoch seconds. */
const EXP_ISO = "2027-03-15T10:30:00.000Z";
const BEFORE = Math.floor(Date.parse(EXP_ISO) / 1000);

const payload = (over: Record<string, unknown> = {}) => ({
  months: 12,
  expiryBefore: BEFORE,
  paymentMode: "live",
  sourceRef: "Q-HREN-1",
  ...over,
});
const ctx = (mode: "test" | "live", p: Record<string, unknown> = payload()) => ({
  commandId: "c1",
  subject: "Acme.IN",
  mode,
  payload: p,
});
const row = (over: Partial<Row> = {}): Row => ({
  _id: "h1",
  domainName: "acme.in",
  status: "active",
  expiryDate: new Date(EXP_ISO),
  directAdminUsername: "acmeab123",
  ...over,
});

beforeEach(() => {
  db.rows = [row()];
  db.finds = [];
  db.updates = [];
  db.failUpdate = null;
  getUserConfig.mockReset().mockResolvedValue({ kind: "found", config: { suspended: "yes" } });
  suspendUser.mockReset();
  unsuspendUser.mockReset().mockResolvedValue({ kind: "unsuspended" });
});

describe("the payload is checked before anything is read", () => {
  it.each([0, 37, 1.5, "twelve", undefined, null])("months=%p is refused", async (months) => {
    await expect(renewHostingCommand(ctx("live", payload({ months })))).rejects.toThrow(
      /"months" must be a whole number from 1 to 36/
    );
    expect(db.finds).toHaveLength(0);
  });

  it("a missing expiryBefore is refused, and says why it is not optional", async () => {
    const err = await renewHostingCommand(ctx("live", payload({ expiryBefore: undefined }))).catch((e) => e);
    expect(err.message).toMatch(/"expiryBefore" is required/);
    expect(err.message).toMatch(/retry would renew twice/);
    expect(db.finds).toHaveLength(0);
  });

  it("expiryBefore in milliseconds is caught and named", async () => {
    await expect(renewHostingCommand(ctx("live", payload({ expiryBefore: BEFORE * 1000 })))).rejects.toThrow(
      /looks like MILLISECONDS/
    );
  });

  it.each([undefined, "LIVE", "prod"])("paymentMode=%p is refused", async (paymentMode) => {
    await expect(renewHostingCommand(ctx("live", payload({ paymentMode })))).rejects.toThrow(
      /"paymentMode" must be "live" or "test"/
    );
    expect(db.finds).toHaveLength(0);
  });
});

describe("finding the hosting", () => {
  it("no non-terminated hosting names the domain, writes nothing", async () => {
    db.rows = [];
    const err = await renewHostingCommand(ctx("live")).catch((e) => e);
    expect(err.message).toMatch(/no hosting for acme\.in that is not terminated/);
    expect(db.updates).toHaveLength(0);
    // The query excludes terminated rows and matches the domain case-insensitively.
    expect(db.finds[0]).toEqual({
      domainName: { $regex: "^acme\\.in$", $options: "i" },
      status: { $ne: "terminated" },
    });
  });

  it("two candidate rows are refused as ambiguous", async () => {
    db.rows = [row(), row({ _id: "h2" })];
    await expect(renewHostingCommand(ctx("live"))).rejects.toThrow(/2 hostings for acme\.in/);
    expect(db.updates).toHaveLength(0);
  });
});

describe("a test-mode payment", () => {
  it("is HELD live, with the [held] prefix, unbranded, and nothing written", async () => {
    const err = await renewHostingCommand(ctx("live", payload({ paymentMode: "test" }))).catch((e) => e);
    expect(err.message.startsWith(`${HOLD_PREFIX} `)).toBe(true);
    expect(err.message).toMatch(/TEST-mode Razorpay key/);
    expect(transportOf(err)).toBeNull();
    expect(db.updates).toHaveLength(0);
    expect(unsuspendUser).not.toHaveBeenCalled();
  });

  it("in a dry run is reported, not thrown", async () => {
    const { result } = await renewHostingCommand(ctx("test", payload({ paymentMode: "test" })));
    expect(result.wouldRenew).toBe(false);
    expect(String(result.hold)).toMatch(/^\[held\]/);
    expect(db.updates).toHaveLength(0);
  });
});

describe("test mode writes nothing", () => {
  it("reports what a live run would do", async () => {
    db.rows = [row({ status: "suspended" })];
    const { result } = await renewHostingCommand(ctx("test"));
    expect(result).toMatchObject({
      dryRun: true,
      changed: false,
      hostingId: "h1",
      domain: "acme.in",
      expiryBefore: BEFORE,
      expiryAfter: "2028-03-15T10:30:00.000Z",
      months: 12,
      unsuspended: false,
      wouldUnsuspend: true,
      wouldRenew: true,
      hold: null,
      sourceRef: "Q-HREN-1",
    });
    expect(db.updates).toHaveLength(0);
    expect(unsuspendUser).not.toHaveBeenCalled();
    expect(getUserConfig).not.toHaveBeenCalled();
  });
});

describe("the expiryBefore comparison", () => {
  it("REFUSES when already extended since the caller read it, and writes nothing", async () => {
    const later = new Date("2028-03-15T10:30:00.000Z");
    db.rows = [row({ expiryDate: later })];
    const err = await renewHostingCommand(ctx("live")).catch((e) => e);
    expect(err.message).toMatch(/already been extended since you read it/);
    expect(err.message).toContain(`expiryBefore=${Math.floor(later.getTime() / 1000)}`);
    expect(err.message).toMatch(/deliberately/);
    expect(db.updates).toHaveLength(0);
    expect(db.rows[0].expiryDate).toEqual(later);
  });

  it("also refuses it in a dry run", async () => {
    db.rows = [row({ expiryDate: new Date("2028-03-15T10:30:00.000Z") })];
    await expect(renewHostingCommand(ctx("test"))).rejects.toThrow(/already been extended/);
  });

  it("refuses when DMS's expiry is EARLIER than the caller's view", async () => {
    db.rows = [row({ expiryDate: new Date("2026-03-15T10:30:00.000Z") })];
    await expect(renewHostingCommand(ctx("live"))).rejects.toThrow(/EARLIER than the/);
    expect(db.updates).toHaveLength(0);
  });

  it("refuses a row with no expiry date", async () => {
    db.rows = [row({ expiryDate: null })];
    await expect(renewHostingCommand(ctx("live"))).rejects.toThrow(/has no expiry date/);
    expect(db.updates).toHaveLength(0);
  });

  it("matches on whole seconds, so a stored expiry with milliseconds still matches", async () => {
    db.rows = [row({ expiryDate: new Date("2027-03-15T10:30:00.789Z") })];
    const { result } = await renewHostingCommand(ctx("live", payload({ months: 1 })));
    expect(result.expiryAfter).toBe("2027-04-15T10:30:00.000Z");
  });

  it("a row that changed between read and write is refused (compare-and-set)", async () => {
    db.failUpdate = () => {
      db.rows[0].expiryDate = new Date("2029-01-01T00:00:00.000Z");
      return null;
    };
    await expect(renewHostingCommand(ctx("live"))).rejects.toThrow(/changed between being read and being written/);
  });

  it("a write that dies in flight is branded sent_unknown, so the claim is held", async () => {
    db.failUpdate = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const err = await renewHostingCommand(ctx("live")).catch((e) => e);
    expect(transportOf(err)).toBe("sent_unknown");
  });
});

describe("the renewal", () => {
  it("extends an active hosting by 1 month and resets the reminder machinery", async () => {
    const { result } = await renewHostingCommand(ctx("live", payload({ months: 1 })));
    expect(result).toEqual({
      ok: true,
      changed: true,
      hostingId: "h1",
      domain: "acme.in",
      expiryBefore: BEFORE,
      expiryAfter: "2027-04-15T10:30:00.000Z",
      months: 1,
      unsuspended: false,
      unsuspendError: null,
      sourceRef: "Q-HREN-1",
    });
    expect(db.updates).toHaveLength(1);
    const set = db.updates[0].update.$set;
    expect(set.expiryDate).toEqual(new Date("2027-04-15T10:30:00.000Z"));
    // Mirrors lib/services/payment/renewal.ts: expiry − 15 days, ladder reset.
    expect(set.next_action_at).toEqual(new Date("2027-03-31T10:30:00.000Z"));
    expect(set.last_reminder_sent).toBeNull();
    // The CAS filter is the expiry that was compared.
    expect(db.updates[0].filter.expiryDate).toEqual(new Date(EXP_ISO));
    expect(unsuspendUser).not.toHaveBeenCalled();
  });

  it("extends by 12 months", async () => {
    const { result } = await renewHostingCommand(ctx("live"));
    expect(result.expiryAfter).toBe("2028-03-15T10:30:00.000Z");
    expect(db.rows[0].expiryDate).toEqual(new Date("2028-03-15T10:30:00.000Z"));
  });

  it("sourceRef is optional", async () => {
    const { result } = await renewHostingCommand(ctx("live", payload({ sourceRef: undefined })));
    expect(result.sourceRef).toBeNull();
  });
});

describe("calendar months are added in UTC, clamped to the month's last day", () => {
  it.each([
    ["2027-01-31T08:00:00.000Z", 1, "2027-02-28T08:00:00.000Z"],
    ["2028-01-31T08:00:00.000Z", 1, "2028-02-29T08:00:00.000Z"],
    ["2027-03-31T00:00:00.000Z", 1, "2027-04-30T00:00:00.000Z"],
    ["2028-02-29T12:00:00.000Z", 12, "2029-02-28T12:00:00.000Z"],
    ["2027-12-15T23:59:59.000Z", 1, "2028-01-15T23:59:59.000Z"],
    ["2027-05-31T05:00:00.000Z", 36, "2030-05-31T05:00:00.000Z"],
    ["2027-11-30T05:00:00.000Z", 3, "2028-02-29T05:00:00.000Z"],
  ])("%s + %i month(s) = %s", (from, months, to) => {
    expect(addCalendarMonthsUtc(new Date(from), months).toISOString()).toBe(to);
  });
});

describe("a suspended or expired account is unsuspended through hosting.unsuspend", () => {
  it.each(["suspended", "expired"])("status %s: DirectAdmin unsuspended, row set active", async (status) => {
    db.rows = [row({ status })];
    const { result } = await renewHostingCommand(ctx("live"));
    expect(result.unsuspended).toBe(true);
    expect(result.unsuspendError).toBeNull();
    // The shared path: hosting.unsuspend reads the account, then unsuspends it.
    expect(getUserConfig).toHaveBeenCalledWith({ username: "acmeab123" });
    expect(unsuspendUser).toHaveBeenCalledWith({ username: "acmeab123" });
    // Expiry written FIRST, then the status.
    expect(db.updates.map((u) => Object.keys(u.update.$set))).toEqual([
      ["expiryDate", "next_action_at", "last_reminder_sent"],
      ["status"],
    ]);
    expect(db.rows[0].status).toBe("active");
  });

  it("an account DirectAdmin already shows active just gets the row set active", async () => {
    db.rows = [row({ status: "suspended" })];
    getUserConfig.mockResolvedValue({ kind: "found", config: { suspended: "no" } });
    const { result } = await renewHostingCommand(ctx("live"));
    expect(unsuspendUser).not.toHaveBeenCalled();
    expect(result.unsuspended).toBe(true);
    expect(db.rows[0].status).toBe("active");
  });

  it("an unsuspend REFUSAL still reports the renewal, truthfully, and says what to do", async () => {
    db.rows = [row({ status: "suspended" })];
    unsuspendUser.mockResolvedValue({ kind: "hard_failure" });
    const { result } = await renewHostingCommand(ctx("live"));
    expect(result.changed).toBe(true);
    expect(result.expiryAfter).toBe("2028-03-15T10:30:00.000Z");
    expect(result.unsuspended).toBe(false);
    expect(String(result.unsuspendError)).toMatch(/renewal is recorded/);
    expect(String(result.unsuspendError)).toMatch(/Send hosting\.unsuspend/);
    expect(String(result.unsuspendError)).toMatch(/Do NOT resend hosting\.renew/);
    // The expiry moved; the status did not.
    expect(db.updates).toHaveLength(1);
    expect(db.rows[0].status).toBe("suspended");
  });

  it("an unreachable DirectAdmin is reported the same way", async () => {
    db.rows = [row({ status: "expired" })];
    getUserConfig.mockResolvedValue({ kind: "unreachable", reason: "ETIMEDOUT" });
    const { result } = await renewHostingCommand(ctx("live"));
    expect(result.unsuspended).toBe(false);
    expect(String(result.unsuspendError)).toMatch(/ETIMEDOUT/);
    expect(db.rows[0].expiryDate).toEqual(new Date("2028-03-15T10:30:00.000Z"));
  });

  it("no DirectAdmin username: renewal recorded, unsuspend reported impossible", async () => {
    db.rows = [row({ status: "suspended", directAdminUsername: undefined })];
    const { result } = await renewHostingCommand(ctx("live"));
    expect(result.unsuspended).toBe(false);
    expect(String(result.unsuspendError)).toMatch(/no DirectAdmin username/);
    expect(getUserConfig).not.toHaveBeenCalled();
  });

  it("DirectAdmin unsuspended but the row could not be set active: says so", async () => {
    db.rows = [row({ status: "suspended" })];
    db.failUpdate = (n) => (n === 1 ? new Error("write concern timeout") : null);
    const { result } = await renewHostingCommand(ctx("live"));
    expect(result.unsuspended).toBe(true);
    expect(String(result.unsuspendError)).toMatch(/could not be set active/);
  });
});

describe("the reconciler", () => {
  const rctx = (request: Record<string, unknown> = { months: 12, expiryBefore: BEFORE }) => ({
    subject: "acme.in",
    request,
  });

  it("expiry moved past the baseline: done", async () => {
    db.rows = [row({ expiryDate: new Date("2028-03-15T10:30:00.000Z") })];
    expect(await reconcileHostingRenew(rctx())).toBe("done");
  });

  it("expiry unchanged: not_done", async () => {
    expect(await reconcileHostingRenew(rctx())).toBe("not_done");
  });

  it("earlier than the baseline, no row, no expiry, or a bad request: unknown", async () => {
    db.rows = [row({ expiryDate: new Date("2026-01-01T00:00:00.000Z") })];
    expect(await reconcileHostingRenew(rctx())).toBe("unknown");
    db.rows = [];
    expect(await reconcileHostingRenew(rctx())).toBe("unknown");
    db.rows = [row({ expiryDate: null })];
    expect(await reconcileHostingRenew(rctx())).toBe("unknown");
    db.rows = [row()];
    expect(await reconcileHostingRenew(rctx({ months: 12 }))).toBe("unknown");
  });

  it("never writes", async () => {
    await reconcileHostingRenew(rctx());
    expect(db.updates).toHaveLength(0);
  });
});
