import mongoose, { Document, Schema } from "mongoose";
import crypto from "crypto";

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
  paymentId: string;
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
      step:
        | "payment_verified"
        | "customer_created"
        | "contact_created"
        | "domain_registering"
        | "domain_pending"
        | "domain_registered"
        | "domain_failed"
        | "dns_activated";
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
  orderType?: 'domain' | 'hosting' | 'bundle' | 'renewal' | 'hosting_upgrade' | 'hosting_trial' | 'unknown';
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
    paymentId: {
      type: String,
      required: true,
      unique: true,
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
              enum: [
                "payment_verified",
                "customer_created",
                "contact_created",
                "domain_registering",
                "domain_pending",
                "domain_registered",
                "domain_failed",
                "dns_activated",
              ],
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
    paymentVerification: {
      verifiedAt: {
        type: Date,
        required: true,
      },
      paymentStatus: {
        type: String,
        required: true,
      },
      paymentAmount: {
        type: Number,
        required: true,
      },
      paymentCurrency: {
        type: String,
        required: true,
      },
      razorpayOrderId: {
        type: String,
        required: true,
      },
    },
    invoiceNumber: {
      type: String,
      unique: true,
      sparse: true,
    },
    zohoInvoiceId: {
      type: String, // ID of the invoice in Zoho Books
      sparse: true,
    },
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
  if (this.status === "completed" && !this.invoiceNumber) {
    const timestamp = Date.now().toString().slice(-6);
    this.invoiceNumber = `INV-${timestamp}-${randomSuffix()}`;
  }
  next();
});

export default mongoose.models.Order ||
  mongoose.model<IOrder>("Order", OrderSchema);
