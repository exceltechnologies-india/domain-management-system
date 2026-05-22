import mongoose, { Schema, Document } from "mongoose";

/**
 * Mongoose Domain Document Interface
 * 
 * Represents an active, pending, or failed individual domain registration 
 * associated with a user account. Bridges the local database state with the
 * upstream registrar (e.g., ResellerClub).
 */
export interface IDomain extends Document {
  domainName: string;
  status: "available" | "registered" | "expiring_soon" | "grace" | "suspended" | "pending" | "failed";
  dnsProvider: "resellerclub" | "directadmin";
  price: number;
  currency: string;
  registrationPeriod: number;
  userId: string | mongoose.Types.ObjectId;
  orderId?: string;
  resellerClubOrderId?: string;
  registeredAt?: Date;
  expiresAt?: Date;
  autoRenew?: boolean;
  next_action_at?: Date;
  last_reminder_sent?: number | null;
  lastRenewalReminder?: Date | null;
  processing_until?: Date | null; // Distributed lock: null = unlocked
  privacyProtection?: boolean;
  nameservers?: string[];
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Mongoose Schema definition for the Domain entity.
 * 
 * Stores the specific configuration of a domain (auto-renew status, privacy protection,
 * nameservers) and handles tracking expiration dates for renewal cycles.
 */
const DomainSchema = new Schema<IDomain>(
  {
    domainName: {
      type: String,
      required: [true, "Domain name is required"],
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ["available", "registered", "expiring_soon", "grace", "suspended", "pending", "failed"],
      default: "available",
    },
    dnsProvider: {
      type: String,
      enum: ["resellerclub", "directadmin"],
      required: true,
      default: "resellerclub", 
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: 0,
    },
    currency: {
      type: String,
      required: [true, "Currency is required"],
      default: "INR",
    },
    registrationPeriod: {
      type: Number,
      required: [true, "Registration period is required"],
      min: 1,
      max: 10,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
      index: true,
    },
    orderId: {
      type: String,
      unique: true,
      sparse: true,
    },
    resellerClubOrderId: {
      type: String,
      unique: true,
      sparse: true,
    },
    registeredAt: {
      type: Date,
    },
    expiresAt: {
      type: Date,
    },
    next_action_at: {
      type: Date,
    },
    last_reminder_sent: {
      type: Number,
      default: null,
    },
    lastRenewalReminder: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    processing_until: {
      type: Date,
      default: null,
      index: true, // Enables fast lock queries
    },
    autoRenew: {
      type: Boolean,
      default: false,
    },
    privacyProtection: {
      type: Boolean,
      default: false,
    },
    nameservers: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
// Partial unique index: only one active record per domain name (deletedAt: null).
// Soft-deleted records (deletedAt != null) are excluded so they don't block re-registration.
DomainSchema.index(
  { domainName: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);
// Daily-scheduler eligibility query — `next_action_at <= now AND processing_until
// IS NULL OR < now`. Mirrors the Hosting schema's compound index so the
// scheduler doesn't COLLSCAN the Domain side of the loop. Mongo plans
// prefix-only queries against this compound, so a separate
// `{ next_action_at: 1 }` index is redundant.
DomainSchema.index({ next_action_at: 1, processing_until: 1 });

// Compound indexes for high-frequency query patterns. The renewal-queries
// compound also covers `(userId, status)` lookups as a prefix, so the
// standalone `{ userId: 1, status: 1 }` index is redundant.
DomainSchema.index({ userId: 1, status: 1, expiresAt: 1 }); // renewal queries
DomainSchema.index({ userId: 1, expiresAt: 1 });             // expiry notifications
DomainSchema.index({ domainName: 'text' });                  // full-text search
DomainSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 7776000 }); // 90-day soft-delete TTL

// Check if the model already exists
let Domain: mongoose.Model<IDomain>;

try {
  Domain = mongoose.model<IDomain>("Domain");
} catch (error) {
  // Model doesn't exist, create it
  Domain = mongoose.model<IDomain>("Domain", DomainSchema);
}

export default Domain;
