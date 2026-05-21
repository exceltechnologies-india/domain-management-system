/**
 * Service-layer integration tests for lib/services/payments.ts.
 *
 * `createPaymentInTransaction` is the only export — it does
 * `Payment.create([data], { session })` so the Order + Payment writes can
 * land atomically inside a Mongoose `withTransaction()`.
 *
 * The in-memory test Mongo is a standalone (no replica set), so we can't
 * actually exercise `withTransaction()` here. Instead these tests verify
 * the input → output contract by passing the session through unused:
 * `Payment.create([doc], { session: dummy })` falls through to a plain
 * insert when the session isn't in a started transaction. The full
 * commit/rollback path is covered by `tests/integration/api/payments-verify`
 * via a vi.mock on this service.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import Payment from "@/models/Payment";
import { createPaymentInTransaction } from "@/lib/services/payments";

const validUserId = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await Payment.syncIndexes();
});

beforeEach(clearAllCollections);

describe("createPaymentInTransaction", () => {
  it("persists a payment with the supplied fields", async () => {
    const userId = validUserId();
    // Start a session but don't open a transaction — the call becomes a
    // plain insert in standalone Mongo.
    const session = await mongoose.startSession();
    try {
      const result = await createPaymentInTransaction(
        {
          userId,
          orderId: "ord_insert_1",
          razorpayPaymentId: "rzp_pay_insert_1",
          amount: 1500,
          currency: "INR",
          status: "completed",
        },
        session
      );
      expect(result._id).toBeDefined();
      expect(result.orderId).toBe("ord_insert_1");
    } finally {
      await session.endSession();
    }

    const found = await Payment.findOne({ orderId: "ord_insert_1" });
    expect(found).toBeTruthy();
    expect(found?.amount).toBe(1500);
    expect(found?.status).toBe("completed");
    expect(found?.userId.toString()).toBe(userId.toString());
  });

  it("preserves status enum values (pending / completed / failed / refunded)", async () => {
    const session = await mongoose.startSession();
    try {
      const statuses = ["pending", "completed", "failed", "refunded"] as const;
      for (const status of statuses) {
        const r = await createPaymentInTransaction(
          {
            userId: validUserId(),
            orderId: `ord_status_${status}`,
            razorpayPaymentId: `rzp_pay_status_${status}`,
            amount: 100,
            currency: "INR",
            status,
          },
          session
        );
        expect(r.status).toBe(status);
      }
    } finally {
      await session.endSession();
    }
  });

  it("rejects writes that violate the required-field schema (missing razorpayPaymentId)", async () => {
    const session = await mongoose.startSession();
    try {
      await expect(
        createPaymentInTransaction(
          {
            userId: validUserId(),
            orderId: "ord_bad_1",
            // razorpayPaymentId intentionally omitted
            razorpayPaymentId: undefined as unknown as string,
            amount: 100,
            currency: "INR",
            status: "completed",
          },
          session
        )
      ).rejects.toThrow();
    } finally {
      await session.endSession();
    }
  });
});
