import mongoose, { Document, Schema } from "mongoose";

export interface IPendingDomain extends Document<mongoose.Types.ObjectId> {
  _id: mongoose.Types.ObjectId;
  domainName: string;
  price: number;
  currency: string;
  registrationPeriod: number;
  userId: mongoose.Types.ObjectId | string;
  orderId: string;
  customerId: number; // ResellerClub customer ID
  contactId: number; // ResellerClub contact ID
  nameServers?: string[];
  adminContactId?: number;
  techContactId?: number;
  billingContactId?: number;
  status: "pending" | "processing" | "completed" | "failed";
  reason: string;
  verificationAttempts: number;
  lastVerifiedAt?: Date;
  registeredAt?: Date;
  expiresAt?: Date;
  resellerClubOrderId?: string;
  adminNotes?: string;
  isArchived?: boolean;
  archivedAt?: Date;
  archivedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PendingDomainSchema = new Schema<IPendingDomain>(
  {
    // _id: default Mongoose ObjectId (auto-generated). Tightened 2026-08-01 from
    // the legacy `Schema.Types.Mixed` ("support both ObjectId and String IDs") —
    // a one-time audit confirmed the collection holds ONLY ObjectId _ids (the
    // only string ids were synthetic, order-derived list rows that are never
    // persisted through this model). See getPendingDomainById for the matching
    // lookup hardening.
    domainName: {
      type: String,
      required: [true, "Domain name is required"],
      trim: true,
      lowercase: true,
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
    },
    orderId: {
      type: String,
      required: [true, "Order ID is required"],
    },
    customerId: {
      type: Number,
      required: [true, "ResellerClub customer ID is required"],
    },
    contactId: {
      type: Number,
      required: [true, "ResellerClub contact ID is required"],
    },
    nameServers: {
      type: [String],
      default: undefined,
    },
    adminContactId: {
      type: Number,
      default: undefined,
    },
    techContactId: {
      type: Number,
      default: undefined,
    },
    billingContactId: {
      type: Number,
      default: undefined,
    },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    reason: {
      type: String,
      required: [true, "Reason is required"],
      default: "Domain registration failed - likely due to insufficient funds",
    },
    verificationAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastVerifiedAt: {
      type: Date,
      default: undefined,
    },
    registeredAt: {
      type: Date,
      default: undefined,
    },
    expiresAt: {
      type: Date,
      default: undefined,
    },
    resellerClubOrderId: {
      type: String,
      default: undefined,
    },
    adminNotes: {
      type: String,
      default: undefined,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
    archivedAt: {
      type: Date,
      default: undefined,
    },
    archivedBy: {
      type: String,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
// Partial unique index scoped to (domainName, userId): keeps two users' failed
// registrations for the same name as separate audit rows. The bulk-upsert in
// lib/services/payment/provisioner-verification.ts filters on
// (domainName, userId). Archived rows are excluded so a soft-deleted record
// doesn't block re-registration.
//
// `isArchived: false` (rather than `$ne: true`) because MongoDB partial-index
// expressions only support $eq/$gt/$gte/$lt/$lte/$exists/$type/$and — the
// previous `$ne: true` spec was silently rejected, so this unique index never
// actually existed in prod. The schema field has `default: false` so new rows
// always get the literal value.
PendingDomainSchema.index(
  { domainName: 1, userId: 1 },
  { unique: true, partialFilterExpression: { isArchived: false } }
);
PendingDomainSchema.index({ userId: 1, status: 1 });
PendingDomainSchema.index({ orderId: 1 });
PendingDomainSchema.index({ status: 1, createdAt: -1 });
PendingDomainSchema.index({ lastVerifiedAt: 1 });

// Virtual for customer information (will be populated)
PendingDomainSchema.virtual("customer", {
  ref: "User",
  localField: "userId",
  foreignField: "_id",
  justOne: true,
});

// Ensure virtual fields are serialized
PendingDomainSchema.set("toJSON", { virtuals: true });
PendingDomainSchema.set("toObject", { virtuals: true });

export default mongoose.models.PendingDomain ||
  mongoose.model<IPendingDomain>("PendingDomain", PendingDomainSchema);
