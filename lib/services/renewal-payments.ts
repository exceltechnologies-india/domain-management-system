/**
 * RenewalPayment service.
 *
 * Idempotency guard for the Razorpay `subscription.charged` webhook. The flow
 * is:
 *
 *  1. {@link recordRenewalPayment} inserts the row with `processed=false`. The
 *     unique index on `providerPaymentId` makes a duplicate insert throw
 *     `11000`, which callers treat as "already seen, move on."
 *  2. {@link claimRenewalPayment} atomically flips `processed` to true. Only
 *     one worker wins; everyone else gets `null` and skips.
 *  3. {@link releaseRenewalClaim} unwinds the claim if downstream work fails,
 *     so the next retry can pick the payment up again.
 *  4. {@link attachOrderToRenewal} crosslinks the row to the Order created in
 *     the renewal-applied path.
 *
 * The whole point of the service is that the webhook handler doesn't have to
 * know the lock protocol — it just calls these helpers in order.
 */
import connectDB from "@/lib/mongodb";
import RenewalPayment from "@/models/RenewalPayment";
import type { IRenewalPayment } from "@/models/RenewalPayment";

export interface RenewalPaymentInput {
  serviceId: unknown;
  serviceType: "hosting" | "domain";
  providerPaymentId: string;
  subscriptionId?: string;
  amount: number;
  currency: string;
  renewalDurationMonths: number;
}

/**
 * Insert a renewal-payment row with `processed=false`. Throws Mongo error
 * `11000` (duplicate key on providerPaymentId) if the same payment was
 * already recorded — callers should catch that case as "already seen".
 */
export async function recordRenewalPayment(
  input: RenewalPaymentInput
): Promise<IRenewalPayment> {
  await connectDB();
  return RenewalPayment.create({
    serviceId: input.serviceId,
    serviceType: input.serviceType,
    providerPaymentId: input.providerPaymentId,
    subscriptionId: input.subscriptionId,
    amount: input.amount,
    currency: input.currency,
    status: "success",
    processed: false,
    renewalDurationMonths: input.renewalDurationMonths,
  });
}

/**
 * Look up the renewal-payment by Razorpay paymentId. Used by the webhook
 * handler after insert (or after duplicate-key) to read the row's current
 * `processed` state.
 */
export async function getRenewalByProviderPaymentId(
  providerPaymentId: string
): Promise<IRenewalPayment | null> {
  await connectDB();
  return RenewalPayment.findOne({ providerPaymentId });
}

/**
 * Atomic claim — try to flip `processed: false → true` and stamp
 * `processedAt`. Returns the updated doc on success, `null` if another
 * worker had already claimed it.
 */
export async function claimRenewalPayment(
  providerPaymentId: string
): Promise<IRenewalPayment | null> {
  await connectDB();
  return RenewalPayment.findOneAndUpdate(
    { providerPaymentId, processed: false },
    { $set: { processed: true, processedAt: new Date() } },
    { new: true }
  );
}

/**
 * Release a previously-claimed row so the next retry can pick it up again.
 * Called from the renewal handler when downstream work failed *after* the
 * claim succeeded.
 */
export async function releaseRenewalClaim(
  providerPaymentId: string
): Promise<void> {
  await connectDB();
  await RenewalPayment.updateOne(
    { providerPaymentId },
    { $set: { processed: false }, $unset: { processedAt: "" } }
  );
}

/**
 * Cross-link the renewal row to the Order document created in the renewal-
 * applied flow. Fire-and-forget — failure here is logged but never blocks
 * the renewal.
 */
export async function attachOrderToRenewal(
  providerPaymentId: string,
  orderId: string
): Promise<void> {
  await connectDB();
  await RenewalPayment.updateOne(
    { providerPaymentId },
    { $set: { orderId } }
  );
}
