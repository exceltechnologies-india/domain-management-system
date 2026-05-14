import mongoose, { Document, Schema } from "mongoose";

/**
 * RenewalPayment Model
 *
 * Purpose-built model for tracking idempotent processing of renewal payments
 * (subscription.charged webhook from Razorpay). Each payment event creates exactly
 * one RenewalPayment record. The `processed` flag is atomically set to `true` when
 * a worker claims and processes the renewal, preventing double renewals even if the
 * webhook is delivered more than once or Cloud Tasks retries.
 *
 * Idempotency mechanism:
 *  1. On webhook: INSERT with processed=false (unique index on providerPaymentId blocks duplicates)
 *  2. On worker claim: findOneAndUpdate WHERE processed=false SET processed=true
 *     → If update matches 0 docs → skip (already processed)
 */
export interface IRenewalPayment extends Document {
  serviceId: Schema.Types.ObjectId;   // Hosting._id or Domain._id
  serviceType: "hosting" | "domain";
  providerPaymentId: string;          // Razorpay payment ID (unique)
  subscriptionId?: string;            // Razorpay subscription ID
  amount: number;                     // In major currency units (e.g. INR, not paise)
  currency: string;
  status: "success";
  processed: boolean;                 // false = pending, true = renewal applied
  processedAt?: Date;
  renewalDurationMonths: number;      // Duration added to expiry on renewal
  orderId?: string;                   // Reference to the Order record created
  createdAt: Date;
  updatedAt: Date;
}

const RenewalPaymentSchema = new Schema<IRenewalPayment>(
  {
    serviceId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    serviceType: {
      type: String,
      enum: ["hosting", "domain"],
      required: true,
    },
    providerPaymentId: {
      type: String,
      required: true,
      unique: true, // Core idempotency guard — blocks duplicate inserts
    },
    subscriptionId: {
      type: String,
      index: true,
      sparse: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: "INR",
    },
    status: {
      type: String,
      enum: ["success"],
      required: true,
      default: "success",
    },
    processed: {
      type: Boolean,
      required: true,
      default: false,
      index: true, // Enables fast queries for unprocessed payments
    },
    processedAt: {
      type: Date,
    },
    renewalDurationMonths: {
      type: Number,
      required: true,
      default: 1,
    },
    orderId: {
      type: String,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index: quickly find unprocessed payments for a service
RenewalPaymentSchema.index({ serviceId: 1, processed: 1 });

export default mongoose.models.RenewalPayment ||
  mongoose.model<IRenewalPayment>("RenewalPayment", RenewalPaymentSchema);
