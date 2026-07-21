import mongoose, { Document, Schema } from "mongoose";

export interface IHosting extends Document {
  userId: Schema.Types.ObjectId;
  domainName: string;
  planId: string; // The package name in DirectAdmin/Pricing
  name: string; // Display name (e.g., "Basic Plan")
  serverPackage: string; // The actual package name on DA server
  status: "active" | "expired" | "pending" | "failed" | "terminated";
  startDate: Date;
  expiryDate: Date;
  next_action_at?: Date;
  last_reminder_sent?: number | null;
  processing_until?: Date | null; // Distributed lock: null = unlocked
  directAdminUsername: string; // Username on the DA server
  orderId: string; // Reference to the purchase order
  paymentId?: string; // Reference to the verified payment
  subscriptionId?: string; // Reference to Razorpay Subscription (Subscriptions-API flow)
  razorpayCustomerId?: string; // Reference to Razorpay Customer (Tokens-API flow)
  razorpayTokenId?: string; // Stored mandate token for merchant-initiated recurring charges (Tokens-API flow)
  region?: string;
  ipAddress?: string;
  nameservers?: string[];
  autoRenew: boolean;
  billingType: "subscription" | "manual";
  isTrial: boolean;
  conversionEventSent?: boolean;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const HostingSchema = new Schema<IHosting>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    domainName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    planId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    serverPackage: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "expired", "pending", "failed", "terminated"],
      default: "pending",
      index: true,
    },
    startDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiryDate: {
      type: Date,
      required: true,
    },
    next_action_at: {
      type: Date,
    },
    last_reminder_sent: {
      type: Number,
      default: null,
    },
    processing_until: {
      type: Date,
      default: null,
      index: true, // Enables fast lock queries
    },
    directAdminUsername: {
      type: String,
      trim: true,
    },
    orderId: {
      type: String,
      required: true,
      index: true,
    },
    paymentId: {
      type: String,
    },
    subscriptionId: {
      type: String,
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
    region: {
      type: String,
      default: "Asia/Kolkata",
    },
    ipAddress: {
      type: String,
    },
    nameservers: [String],
    autoRenew: {
      type: Boolean,
      default: false,
    },
    billingType: {
      type: String,
      enum: ["subscription", "manual"],
      default: "manual",
    },
    isTrial: {
      type: Boolean,
      default: false,
    },
    // Idempotency guard so the Meta conversion event (StartTrial / Purchase)
    // fires at most once per hosting, even across sync + async + cron
    // provisioning paths.
    conversionEventSent: {
      type: Boolean,
      default: false,
    },
    lastSyncedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for common queries
HostingSchema.index({ userId: 1, domainName: 1 }, { unique: true, sparse: true });
HostingSchema.index({ userId: 1, status: 1 });
HostingSchema.index({ expiryDate: 1 });
HostingSchema.index({ next_action_at: 1 });
HostingSchema.index({ userId: 1, isTrial: 1 });

export default mongoose.models.Hosting ||
  mongoose.model<IHosting>("Hosting", HostingSchema);
