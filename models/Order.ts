import mongoose, { Document, Schema } from "mongoose";
import crypto from "crypto";

/**
 * Booking-status step values. Single source of truth shared between the
 * schema enum + the TS interface so a typo doesn't compile (silently
 * tripping the Mongoose validator only at runtime).
 */
export const BOOKING_STEPS = [
  "payment_verified",
  "customer_created",
  "contact_created",
  "domain_registering",
  "domain_pending",
  "domain_registered",
  "domain_failed",
  "dns_activated",
  // hosting-specific: DA unreachable at provision time, queued for retry by
  // the pending-hosting cron. Was missing from the schema enum before M3 — any
  // save with this value would have tripped Mongoose validation.
  "hosting_deferred",
] as const;
export type BookingStep = (typeof BOOKING_STEPS)[number];

/**
 * Mongoose Order Document Interface
 *
 * Represents a complete customer order in the system, which can include multiple
 * domain registrations and hosting packages. Tracks the payment gateway status
 * (Razorpay) and provisioning progress (bookingStatus).
 */
export interface IOrder extends Document {
  orderId: string;
  purchaseOrderNumber: string; // PO number for all purchases
  userId: Schema.Types.ObjectId;
  userName?: string;
  userEmail?: string;
  /** Legacy — see schema comment. New writes can omit. */
  paymentId?: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "processing" | "completed" | "failed" | "refunded";
  domains: {
    domainName: string;
    price: number;
    currency: string;
    registrationPeriod: number;
    status: "pending" | "processing" | "registered" | "failed" | "cancelled";
    bookingStatus: {
      step: BookingStep;
      message: string;
      timestamp: Date;
      progress: number; // 0-100
    }[];
    error?: string;
    orderId?: string;
    expiresAt?: Date;
    resellerClubOrderId?: string;
    resellerClubCustomerId?: string;
    resellerClubContactId?: string;
    dnsActivated?: boolean;
    dnsActivatedAt?: Date;
    dnsProvider?: "resellerclub" | "directadmin";
    itemType?: "domain" | "hosting"; // Defaults to "domain" if not present
    /**
     * For hosting cart items: the actual domain the DirectAdmin user is
     * provisioned against (e.g. "tryraju.com"). The cart store gives
     * hosting items a synthetic `domainName` ("hosting-standard-…") so the
     * cart can show domain + hosting as two distinct rows; `linkedDomain`
     * is the real domain. Without persisting it, /payments/verify
     * (security-pinned to DB-stored order.domains, NOT request-body
     * cartItems) reconstructed the hosting CartItem with only the
     * synthetic domainName, the provisioner tried `linkedDomain ||
     * domainName` and got the synthetic ID, and DirectAdmin refused to
     * create a user for it. Added 2026-06-18 to fix that flow.
     */
    linkedDomain?: string;
    hostingPlan?: {
      planId: string;
      name: string;
      serverPackage: string; // The actual package name on DA server
    };
    periodUnit?: "minutes" | "months" | "years" | "days";
    isTrial?: boolean;
  }[];
  successfulDomains: string[];
  paymentVerification?: {
    verifiedAt: Date;
    paymentStatus: string;
    paymentAmount: number;
    paymentCurrency: string;
    razorpayOrderId: string;
  };
  createdAt: Date;
  updatedAt: Date;
  invoiceNumber?: string;
  /**
   * Which engine issued this order's invoice — a FINAL outcome, set once.
   *
   *  - 'primary' — `invoiceNumber` is a TI/YYYY-YY/NNNNN number from our own
   *    GST engine (lib/billing). This is the only engine that issues anything.
   *  - 'zoho'    — HISTORICAL ONLY. Zoho Books was removed on 24 Sep 2026 by
   *    owner decision (see CLAUDE.md, "Zoho Books removed"). Orders invoiced
   *    before then were stamped 'zoho' by migration 009. Nothing writes this
   *    value any more; it exists so those orders read as ALREADY INVOICED and
   *    no retry ever issues a second tax invoice for the same payment.
   *
   * Undefined means no invoice has been issued yet.
   */
  invoiceProvider?: 'primary' | 'zoho';
  /**
   * Set when the primary engine failed to issue this order's invoice, cleared
   * when an invoice is finally recorded. This is what the retry paths and
   * admin integration-health read — "paid, no invoice, and we KNOW an attempt
   * failed". It replaces the old `zohoInvoiceId: "creation_failed"` sentinel,
   * which overloaded a Zoho id field with a failure flag.
   */
  invoiceFailedAt?: Date;
  /** The engine's own error message from the most recent failed attempt. */
  invoiceFailureReason?: string;
  // GST breakdown for invoiceProvider === 'primary' orders. Populated by
  // lib/services/billing/createPrimaryInvoice.ts at invoice-issue time;
  // absent on historical Zoho-issued invoices.
  gstRate?: number;
  taxableValue?: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  placeOfSupply?: string;
  customerGstin?: string;
  // Atomic-claim marker for the primary invoice engine — its own field,
  // because invoiceProvider only records a FINAL outcome.
  // Cleared on release; left behind harmlessly once invoiceProvider is set.
  primaryInvoiceClaimedAt?: Date;
  // ── Manual credit-note obligation (Primary Billing Integration) ───────────
  //
  // Our GST engine mints tax invoices but has NO credit-note counterpart yet
  // (operator decision 2026-09-03: deferred until real refund volume exists,
  // rather than shipping an unexercised reverse-numbering series). A refund
  // against a primary-issued invoice therefore still owes the customer a GST
  // credit note, which an operator has to raise by hand.
  //
  // These fields exist so that obligation is visible IN THE DATA rather than
  // only in prod-silenced logs — same reasoning as `mandateRefundStatus`.
  // `app/api/admin/integration-health` surfaces any order carrying
  // `creditNotePending: true` with the manual ACTION to take. Cleared by an
  // operator (or by the credit-note engine, if/when it's built).
  creditNotePending?: boolean;
  creditNotePendingRefundId?: string;
  // Refund amount in PAISE, as Razorpay reports it — deliberately not
  // converted, so the value the operator enters on the credit note matches the
  // refund record they're looking at.
  creditNotePendingAmountPaise?: number;
  creditNotePendingAt?: Date;
  // HISTORY ONLY since 26 Sep 2026: the dunning cron that wrote these fields
  // was deleted (owner: "Switch it off"). Kept so old rows still read.
  // Renewal-payment dunning (Primary Billing Integration Phase 2) — tracks
  // which escalation stage (hours since createdAt, from
  // AUTOMATION_CONFIG.RENEWAL_DUNNING_HOURS) was last emailed for a renewal
  // Order stuck in status='pending' (customer started but never completed
  // Razorpay checkout). Set only on orderType='renewal' orders.
  dunningLastStageHours?: number;
  // Set once the LAST dunning stage has been sent — stops further reminder
  // emails for this order. Does NOT change `status`; the order stays
  // 'pending' (an operator/future cron can decide separately whether to
  // void long-abandoned orders).
  dunningAbandonedAt?: Date;
  orderType?: 'domain' | 'hosting' | 'bundle' | 'renewal' | 'hosting_upgrade' | 'hosting_trial' | 'unknown';
  // Razorpay recurring-payment mode: 'subscription' uses the Subscriptions
  // API (current default), 'tokens' uses the Tokens API (Google ₹2-and-reverse
  // pattern). See docs/razorpay-tokens-migration.md.
  mandateMode?: 'subscription' | 'tokens' | 'manual';
  // Set when mandateMode='tokens'; the Razorpay customer+token tuple that
  // enables future merchant-initiated charges.
  razorpayCustomerId?: string;
  razorpayTokenId?: string;
  // Mandate-validation (₹2 CIT) refund tracking for the tokens trial flow.
  // Persisted by the webhook mandate handler so a silent refund failure is
  // visible in the data. `mandateRefundStatus:'failed'` = the ₹2 is still
  // captured and needs a manual refund from the Razorpay dashboard.
  mandateRefundId?: string;
  mandateRefundStatus?: 'processed' | 'failed';
  mandateRefundedAt?: Date;
  upgradeDetails?: {
    hostingId: string;
    fromPlanId: string;
    toPlanId: string;
    remainingDays: number;
  };
  isDeleted?: boolean;
  deletedAt?: Date;
}

/**
 * Mongoose Schema definition for the Order entity.
 * 
 * Captures all financial transactional data, including Razorpay specific identifiers
 * and signature verification fields. Includes a detailed subdocument array for
 * `domains` that tracks multi-step registration progress constraints.
 */
const OrderSchema = new Schema<IOrder>(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
    },
    purchaseOrderNumber: {
      type: String,
      unique: true,
      sparse: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userName: {
      type: String,
      trim: true,
    },
    userEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    // Legacy field — never read by any code path; `razorpayPaymentId` is
    // the real payment identifier and is independently indexed. Kept here
    // (without required/unique) to avoid a destructive schema change on
    // existing rows that still carry it. New writes can omit it.
    paymentId: {
      type: String,
    },
    razorpayOrderId: {
      type: String,
      required: true,
    },
    razorpayPaymentId: {
      type: String,
      required: true,
    },
    razorpaySignature: {
      type: String,
      // NOT required. The client HMAC is genuinely absent on some real flows:
      // the Tokens/recurring-mandate authorization returns no usable signature
      // (see verification.ts — the webhook, verified via
      // RAZORPAY_WEBHOOK_SECRET, is the authoritative verifier there), and both
      // /api/payments/verify and lib/services/payment/upgrade.ts already
      // normalise a missing one to `razorpay_signature ?? ""`.
      //
      // With `required: true` Mongoose rejects that empty string, so
      // finalizePendingOrder's `order.save()` threw
      // "Path `razorpaySignature` is required" AFTER provisioning had already
      // run — DirectAdmin account created, Hosting row written, welcome email
      // sent — leaving the Order stranded at status "processing" with no
      // invoice while /verify still answered 200 "success". Reproduced against
      // a real captured test payment on 2026-09-04.
      //
      // This field is an audit record of what the client sent; nothing branches
      // on its value. An empty string is the honest record of "no signature".
      required: false,
      default: "",
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      default: "INR",
    },
    status: {
      type: String,
      enum: ["pending", "paid", "processing", "completed", "failed", "refunded"],
      default: "pending",
    },
    domains: [
      {
        domainName: {
          type: String,
          required: true,
        },
        price: {
          type: Number,
          required: true,
        },
        currency: {
          type: String,
          required: true,
        },
        registrationPeriod: {
          type: Number,
          required: true,
        },
        status: {
          type: String,
          enum: ["pending", "processing", "registered", "failed", "cancelled"],
          default: "pending",
        },
        bookingStatus: [
          {
            step: {
              type: String,
              // Spread from the BOOKING_STEPS const to keep the schema enum
              // and the IOrder TS literal in lockstep. Mongoose accepts a
              // mutable string[] for `enum`, so we copy to a fresh array.
              enum: [...BOOKING_STEPS],
              required: true,
            },
            message: {
              type: String,
              required: true,
            },
            timestamp: {
              type: Date,
              default: Date.now,
            },
            progress: {
              type: Number,
              min: 0,
              max: 100,
              required: true,
            },
          },
        ],
        error: String,
        orderId: String,
        expiresAt: Date,
        resellerClubOrderId: String,
        resellerClubCustomerId: String,
        resellerClubContactId: String,
        dnsActivated: {
          type: Boolean,
          default: false,
        },
        dnsActivatedAt: Date,
        itemType: {
          type: String,
          enum: ["domain", "hosting"],
          default: "domain",
        },
        // See the IOrder interface comment above. For hosting cart items the
        // synthetic cart-store domainName ("hosting-standard-…") would
        // otherwise be passed to the DirectAdmin provisioner and rejected.
        linkedDomain: String,
        dnsProvider: {
          type: String,
          enum: ["resellerclub", "directadmin"],
          default: "resellerclub",
        },
        hostingPlan: {
          planId: String,
          name: String,
          serverPackage: String,
        },
        periodUnit: {
          type: String,
          enum: ["minutes", "months", "years", "days"],
          default: "years",
        },
        // Trial flag must survive the create-order → pending → finalize round
        // trip. Without it, finalizePendingOrder rebuilds cartItems from
        // order.domains with isTrial=undefined, the hosting provisioner takes
        // the paid branch, and the 1-trial-per-user eligibility gate gets
        // defeated for any cart that mixes a trial hosting with a paid domain.
        isTrial: {
          type: Boolean,
          default: false,
        },
      },
    ],
    successfulDomains: [String],
    // paymentVerification is OPTIONAL on the parent (an Order starts as
    // `pending` with no verification, then `/payments/verify` fills this in
    // once the payment completes). The required fields below only apply
    // when the verifier actually sets the subdoc — without the explicit
    // sub-schema + `default: undefined`, Mongoose auto-creates an empty
    // `paymentVerification: {}` on every parent save and trips the required
    // validators, producing
    //   Order validation failed: paymentVerification.razorpayOrderId: Path
    //   `paymentVerification.razorpayOrderId` is required
    // which is exactly what the diagnostic surfaced on 2026-06-18 when the
    // first checkout attempt of the day failed to persist the pending Order.
    paymentVerification: {
      type: new Schema(
        {
          verifiedAt: { type: Date, required: true },
          paymentStatus: { type: String, required: true },
          paymentAmount: { type: Number, required: true },
          paymentCurrency: { type: String, required: true },
          razorpayOrderId: { type: String, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
    invoiceNumber: {
      type: String,
      unique: true,
      sparse: true,
    },
    invoiceProvider: {
      type: String,
      enum: ['primary', 'zoho'],
    },
    invoiceFailedAt: Date,
    invoiceFailureReason: String,
    gstRate: Number,
    taxableValue: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    placeOfSupply: String,
    customerGstin: String,
    primaryInvoiceClaimedAt: Date,
    creditNotePending: Boolean,
    creditNotePendingRefundId: String,
    creditNotePendingAmountPaise: Number,
    creditNotePendingAt: Date,
    dunningLastStageHours: Number,
    dunningAbandonedAt: Date,
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
    orderType: {
      type: String,
      enum: ['domain', 'hosting', 'bundle', 'renewal', 'hosting_upgrade', 'hosting_trial', 'unknown'],
      default: 'unknown',
      index: true,
    },
    // Recurring-billing rail used at signup. 'subscription' = legacy
    // Razorpay Subscriptions API (mandate at signup, renewals charged
    // by Razorpay's recurring billing); 'tokens' = Razorpay Tokens
    // API (CIT auth + MIT cron); 'manual' = no Razorpay mandate at
    // signup, renewals are operator/customer-initiated via the
    // existing renewal flow at /api/user/hosting/renew. The 'manual'
    // value was missing from the enum until 2026-06-30 — every
    // manual-flow trial signup since the HOSTING_MANDATE_FLOW=manual
    // flip (2026-06-29 06:12Z) was failing Mongoose validation,
    // throwing inside the route's manual-flow try/catch, falling
    // through to the Razorpay createOrder path, and 500-ing because
    // oneTimeAmount=0 leaves no payment target either. See
    // app/api/payments/create-order/route.ts:284 for the saving site.
    mandateMode: {
      type: String,
      enum: ['subscription', 'tokens', 'manual'],
      index: true,
    },
    razorpayCustomerId: {
      type: String,
      index: true,
    },
    razorpayTokenId: {
      type: String,
      index: true,
    },
    mandateRefundId: {
      type: String,
    },
    mandateRefundStatus: {
      type: String,
      enum: ['processed', 'failed'],
    },
    mandateRefundedAt: {
      type: Date,
    },
    upgradeDetails: {
      hostingId: String,
      fromPlanId: String,
      toPlanId: String,
      remainingDays: Number,
    },
  },
  {
    timestamps: true,
  }
);

// Existing indexes
OrderSchema.index({ isDeleted: 1, "domains.status": 1, createdAt: -1 });
OrderSchema.index({ "domains.domainName": 1 });

// Compound indexes for high-frequency query patterns
OrderSchema.index({ userId: 1, orderType: 1, createdAt: -1 }); // order history
OrderSchema.index({ userId: 1, status: 1 });                    // status filtering

// Index kept for existing data; its only reader, the renewal-payment-dunning
// cron, was deleted on 26 Sep 2026 (dropping it would need a migration).
// Renewal-payment dunning cron scan (app/api/cron/renewal-payment-dunning) —
// finds pending renewal orders not yet fully chased. Without this the query
// COLLSCANs the whole Order collection on every run.
OrderSchema.index({ status: 1, orderType: 1, dunningAbandonedAt: 1, createdAt: 1 });

// Razorpay identifier lookups — touched by every webhook and payment-verify
// idempotency check. Without these the queries COLLSCAN. Sparse because
// pending/renewal Orders may write "pending" sentinels.
OrderSchema.index({ razorpayPaymentId: 1 }, { sparse: true });
OrderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
// Invoice-retry scan: "paid orders whose invoice attempt failed". Sparse —
// almost no order ever carries the field.
OrderSchema.index({ invoiceFailedAt: 1 }, { sparse: true });

/**
 * Pre-save Database Hook for Orders
 * 
 * Automatically generates a unique Purchase Order (PO) number for all new
 * orders. It does NOT generate an invoice number (see below).
 */
OrderSchema.pre("save", function (next) {
  // Random suffix uses crypto.randomBytes (~16M values) instead of
  // Math.random.substring(2,5) (~46k values). The old impl + ms-granular
  // timestamp prefix collided under burst load — admin/orders/invoice-conflicts
  // exists because we hit that in prod.
  const randomSuffix = () => crypto.randomBytes(4).toString("hex").toUpperCase();

  // Generate PO number for all new orders (successful or failed)
  if (this.isNew && !this.purchaseOrderNumber) {
    const timestamp = Date.now().toString().slice(-6);
    this.purchaseOrderNumber = `PO-${timestamp}-${randomSuffix()}`;
  }

  // No invoice number is minted here any more. This hook used to write a
  // legacy `INV-<ts>-<hex>` number onto every order that reached `completed`.
  // DMS issues no bills (owner decision, 24 Sep 2026): every bill is
  // ResellerOS's. Removed in the same commit as the TI/... engine, so there is
  // never a window with one issuer left. Orders that already carry a number
  // keep it. Pinned by tests/unit/lib/billing/no-dms-bills-scan.test.ts.
  next();
});

export default mongoose.models.Order ||
  mongoose.model<IOrder>("Order", OrderSchema);
