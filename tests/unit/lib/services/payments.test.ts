/**
 * Tests for `@/lib/services/payments` (rescan-4 slice 7dg).
 * `createPaymentInTransaction` writes a Payment row inside a Mongoose
 * ClientSession — the only way to attach the write to an in-flight
 * transaction. Pins the create([doc], {session}) signature.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClientSession } from "mongoose";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const paymentCreateMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/Payment", () => ({
  default: { create: paymentCreateMock },
}));

import { createPaymentInTransaction } from "@/lib/services/payments";

const SESSION = { fake: "session" } as unknown as ClientSession;

const SAMPLE = {
  userId: "user-123",
  orderId: "ord_1",
  razorpayPaymentId: "pay_abc",
  amount: 1000,
  currency: "INR",
  status: "pending" as const,
  domainIds: ["d1"],
};

beforeEach(() => {
  connectDBMock.mockReset();
  paymentCreateMock.mockReset();
});

describe("createPaymentInTransaction", () => {
  it("connects to DB then calls Payment.create([data], {session})", async () => {
    paymentCreateMock.mockResolvedValueOnce([{ _id: "pay-row-1", ...SAMPLE }]);
    const doc = await createPaymentInTransaction(SAMPLE, SESSION);
    expect(connectDBMock).toHaveBeenCalledTimes(1);
    expect(paymentCreateMock).toHaveBeenCalledWith([SAMPLE], { session: SESSION });
    // The helper returns the FIRST element of the returned array
    // (Mongoose's array-create returns an array even for a single doc).
    expect(doc).toMatchObject({ _id: "pay-row-1", orderId: "ord_1" });
  });

  it("propagates errors from the underlying create (transaction-abort path)", async () => {
    paymentCreateMock.mockRejectedValueOnce(new Error("write conflict"));
    await expect(createPaymentInTransaction(SAMPLE, SESSION)).rejects.toThrow(
      "write conflict"
    );
  });
});
