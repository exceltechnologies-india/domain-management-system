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
    zohoRecurringInvoiceId?: string;
    zohoRecurringProfileStatus?: string;
    zohoRecurringProfileError?: string;
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
  zohoInvoiceId?: string;
  /**
   * Which engine actually issued this order's tax invoice. 'primary' means
   * `invoiceNumber` is a TI/YYYY-YY/NNNNN number from our own GST engine
   * (lib/billing) and IS the legal tax invoice — no Zoho invoice exists.
   * 'zoho' means the primary engine failed (or hasn't been enabled yet) and
   * Zoho Books issued the invoice as before, referenced by `zohoInvoiceId`.
   * Undefined on orders created before this field existed.
   */
  invoiceProvider?: 'primary' | 'zoho';
  // GST breakdown for invoiceProvider === 'primary' orders. Populated by
  // lib/services/billing/createPrimaryInvoice.ts at invoice-issue time;
  // absent on Zoho-issued invoices, whose tax breakdown lives in Zoho, not
  // here.
  gstRate?: number;
  taxableValue?: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  placeOfSupply?: string;
  customerGstin?: string;
  // Atomic-claim marker for the primary invoice engine (mirrors the
  // zohoInvoiceId="pending_creation" sentinel pattern used for Zoho, but on
  // its own field since invoiceProvider only records a FINAL outcome).
  // Cleared on release; left behind harmlessly once invoiceProvider is set.
  primaryInvoiceClaimedAt?: Date;
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
      required: true,
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
        zohoRecurringInvoiceId: {
            type: String,
            sparse: true
        },
        zohoRecurringProfileStatus: {
            type: String, // 'pending', 'created', 'failed', 'skipped'
            default: 'pending'
        },
        zohoRecurringProfileError: String,
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
    zohoInvoiceId: {
      type: String, // ID of the invoice in Zoho Books
      // Index defined explicitly below via OrderSchema.index(..., { sparse: true }).
      // Don't add `sparse`/`index` here too — that builds a duplicate index
      // (Mongoose "Duplicate schema index on {zohoInvoiceId:1}" warning).
    },
    invoiceProvider: {
      type: String,
      enum: ['primary', 'zoho'],
    },
    gstRate: Number,
    taxableValue: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    placeOfSupply: String,
    customerGstin: String,
    primaryInvoiceClaimedAt: Date,
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

// Renewal-payment dunning cron scan (app/api/cron/renewal-payment-dunning) —
// finds pending renewal orders not yet fully chased. Without this the query
// COLLSCANs the whole Order collection on every run.
OrderSchema.index({ status: 1, orderType: 1, dunningAbandonedAt: 1, createdAt: 1 });

// Razorpay / Zoho identifier lookups — touched by every webhook, payment-verify
// idempotency check, and Zoho retry cron. Without these the queries COLLSCAN.
// Sparse on zohoInvoiceId because most rows don't carry one until the invoice
// step lands; sparse on razorpayPaymentId/Id because pending/renewal Orders
// may write "pending" sentinels.
OrderSchema.index({ razorpayPaymentId: 1 }, { sparse: true });
OrderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
OrderSchema.index({ zohoInvoiceId: 1 }, { sparse: true });

/**
 * Pre-save Database Hook for Orders
 * 
 * Automatically generates a unique Purchase Order (PO) number for all new
 * orders. Furthermore, if an order successfully transitions to a 'completed'
 * state, it generates a unique Invoice Number for billing purposes.
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

  // Generate invoice number for completed orders that don't yet have one.
  // Fires on both fresh creates and on the `pending → completed` transition
  // used by the new pending-order lifecycle (orders persisted at
  // /create-order, finalised by /verify or /razorpay/webhook).
  //
  // The `invoiceProvider !== "primary"` guard is defence-in-depth for the
  // Primary Billing Integration: a primary-issued order already carries a
  // legally sequential TI/YYYY-YY/NNNNN number written by
  // recordPrimaryInvoiceForOrder. If a caller saves a doc that was loaded
  // BEFORE that write, `this.invoiceNumber` looks empty here and this hook
  // would overwrite the real tax-invoice number with a random legacy one.
  // Call sites holding such a doc must sync the number back (see the
  // webhook's payment.captured handler); this guard catches the rest.
  if (
    this.status === "completed" &&
    !this.invoiceNumber &&
    this.invoiceProvider !== "primary"
  ) {
    const timestamp = Date.now().toString().slice(-6);
    this.invoiceNumber = `INV-${timestamp}-${randomSuffix()}`;
  }
  next();
});

export default mongoose.models.Order ||
  mongoose.model<IOrder>("Order", OrderSchema);
