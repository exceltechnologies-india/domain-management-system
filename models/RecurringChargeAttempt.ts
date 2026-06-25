import mongoose, { Document, Schema } from "mongoose";

/**
 * RecurringChargeAttempt — retry log for the Tokens-flow recurring-charge cron.
 *
 * Unlike the Subscriptions-API flow (where Razorpay manages retries for us),
 * the Tokens-API flow makes US responsible for retrying failed merchant-initiated
 * transactions. This model is the persistent retry log.
 *
 * Lifecycle (one row per (hostingId, dueDate) pair):
 *  1. Cron determines hosting is due for charge → INSERT with attemptCount=1,
 *     nextAttemptAt=now, status='pending'
 *  2. Cron picks up the row, calls RazorpayService.chargeViaToken()
 *  3. On success → status='succeeded'; webhook handler later marks the
 *     Hosting expiry extended (same path as one-shot orders)
 *  4. On failure → status='failed', attemptCount incremented,
 *     nextAttemptAt scheduled per retry policy (T+1, T+3, T+7 days)
 *  5. After 4 failed attempts → status='abandoned'; Hosting marked expired,
 *     DA suspended, dunning email sent
 *
 * Idempotency: unique index on (hostingId, dueDate) — only one attempt per
 * billing cycle per hosting, regardless of how many times the cron fires.
 *
 * See docs/razorpay-tokens-migration.md §3.5 (retry + dunning logic).
 */
export interface IRecurringChargeAttempt extends Document {
  hostingId: Schema.Types.ObjectId;       // Reference to Hosting
  userId: Schema.Types.ObjectId;          // Reference to User (for dunning emails)
  customerId: string;                      // Razorpay customer_id from the Hosting
  tokenId: string;                         // Razorpay token_id from the Hosting
  amountInRupees: number;                  // The MIT charge amount, in INR
  dueDate: Date;                           // The billing period this attempt is for (= Hosting.expiryDate before extension)
  attemptCount: number;                    // 1-based — first attempt is 1
  status: "pending" | "in_progress" | "succeeded" | "failed" | "abandoned";
  nextAttemptAt?: Date;                    // When the next retry should fire (if status='failed')
  lastAttemptAt?: Date;
  lastError?: string;                      // Error message from the most recent failed attempt
  razorpayOrderId?: string;                // From the MIT order created during charge
  razorpayPaymentId?: string;              // From the MIT payment, populated on success
  abandonedAt?: Date;                      // When retry budget was exhausted
  createdAt: Date;
  updatedAt: Date;
}

const RecurringChargeAttemptSchema = new Schema<IRecurringChargeAttempt>(
  {
    hostingId: {
      type: Schema.Types.ObjectId,
      ref: "Hosting",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    customerId: {
      type: String,
      required: true,
    },
    tokenId: {
      type: String,
      required: true,
    },
    amountInRupees: {
      type: Number,
      required: true,
      min: 1,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    attemptCount: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    status: {
      type: String,
      enum: ["pending", "in_progress", "succeeded", "failed", "abandoned"],
      required: true,
      default: "pending",
      index: true,
    },
    nextAttemptAt: {
      type: Date,
      index: true,
    },
    lastAttemptAt: {
      type: Date,
    },
    lastError: {
      type: String,
    },
    razorpayOrderId: {
      type: String,
    },
    razorpayPaymentId: {
      type: String,
      index: true,
    },
    abandonedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Idempotency: one attempt row per (hostingId, dueDate). If the cron fires
// twice in the same billing cycle, the second insert errors (E11000 duplicate
// key) and the cron's handler reads the existing row instead.
RecurringChargeAttemptSchema.index({ hostingId: 1, dueDate: 1 }, { unique: true });

// Hot-path query for the cron: find rows due for retry.
RecurringChargeAttemptSchema.index({ status: 1, nextAttemptAt: 1 });

const RecurringChargeAttempt =
  mongoose.models.RecurringChargeAttempt ||
  mongoose.model<IRecurringChargeAttempt>(
    "RecurringChargeAttempt",
    RecurringChargeAttemptSchema
  );

export default RecurringChargeAttempt;
