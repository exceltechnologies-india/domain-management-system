/**
 * lib/billing/no-dms-bills.ts — a payment DMS took, which no bill covers, is
 * FLAGGED for an operator, never silently dropped (AGENTS.md §2).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const markInvoiceCreationFailed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ markInvoiceCreationFailed }));
const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({ serverLogger: { error: logError, warn: vi.fn(), info: vi.fn() } }));

import { flagPaymentWithoutBill, neededABill, NO_DMS_BILL_REASON } from "@/lib/billing/no-dms-bills";

beforeEach(() => {
  markInvoiceCreationFailed.mockReset().mockResolvedValue(undefined);
  logError.mockReset();
});

describe("neededABill", () => {
  it("a paid order did; a ₹0 order and a trial did not", () => {
    expect(neededABill({ amount: 708 })).toBe(true);
    expect(neededABill({ amount: 0 })).toBe(false);
    expect(neededABill({ amount: undefined })).toBe(false);
    expect(neededABill({ amount: 708, orderType: "hosting_trial" })).toBe(false);
  });
});

describe("flagPaymentWithoutBill", () => {
  it("flags a paid order with the reason that says what to do, and logs it as a fault", async () => {
    await flagPaymentWithoutBill({ _id: "o1", orderId: "ord_1", amount: 708 }, "payments/verify");
    expect(markInvoiceCreationFailed).toHaveBeenCalledWith("o1", NO_DMS_BILL_REASON);
    expect(NO_DMS_BILL_REASON).toMatch(/raise the bill for this payment in ResellerOS/);
    expect(logError.mock.calls[0][0]).toMatch(/\[NO-BILL\] payments\/verify: order ord_1/);
  });

  it("flags nothing for a trial", async () => {
    await flagPaymentWithoutBill({ _id: "o1", amount: 0, orderType: "hosting_trial" }, "x");
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
  });

  it("never throws, even when the flag cannot be written — and says so", async () => {
    markInvoiceCreationFailed.mockRejectedValue(new Error("db down"));
    await expect(flagPaymentWithoutBill({ _id: "o1", orderId: "ord_1", amount: 1 }, "webhook")).resolves.toBeUndefined();
    expect(logError.mock.calls.at(-1)?.[0]).toMatch(/ALSO failed to flag order ord_1.*db down/);
  });
});
