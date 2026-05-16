/**
 * Payment service.
 *
 * Payment rows are written inside the order-creation transaction so the Order
 * and its matching Payment row land atomically. Both call sites — the
 * authenticated checkout and the guest-checkout — share the exact same write,
 * so the helper takes the Mongoose `ClientSession` directly.
 */
import type { ClientSession } from "mongoose";
import connectDB from "@/lib/mongodb";
import Payment from "@/models/Payment";
import type { IPayment } from "@/models/Payment";

export interface PaymentInput {
  userId: unknown;
  orderId: string;
  razorpayPaymentId: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed" | "refunded";
  domainIds?: unknown[];
}

/**
 * Persist a Payment row inside the supplied transaction. The Mongoose
 * `Model.create([doc], { session })` shape is the only way to attach a write
 * to an in-flight transaction, so the service mirrors it.
 */
export async function createPaymentInTransaction(
  data: PaymentInput,
  session: ClientSession
): Promise<IPayment> {
  await connectDB();
  const [doc] = await Payment.create([data], { session });
  return doc;
}
