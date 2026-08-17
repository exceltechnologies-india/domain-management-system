import mongoose, { Schema, Document } from "mongoose";

/**
 * Reseller (sub-reseller feature — Model A, Phase 1).
 *
 * A Reseller is a white-label tenant: a customer who resells our domains/hosting
 * to their OWN end-customers through our UI. Each Reseller is backed by a normal
 * login `User` (role `"reseller"`) referenced via `ownerUserId`.
 *
 * Phase 1 wires only identity + lifecycle status. The commercial fields
 * (`walletBalance`, `markupPercent`, `branding`) are present in the schema now —
 * so later phases (markup engine, prepaid wallet, light branding) need no
 * migration — but carry safe defaults and are otherwise DORMANT until then.
 */

export const RESELLER_STATUSES = ["pending", "approved", "suspended"] as const;
export type ResellerStatus = (typeof RESELLER_STATUSES)[number];

export interface IReseller extends Document {
  /** The login account that owns this reseller tenant (role "reseller"). */
  ownerUserId: Schema.Types.ObjectId;
  businessName: string;
  /** URL-safe unique handle derived from businessName (future white-label routing). */
  slug: string;
  status: ResellerStatus;

  // ── Dormant until later phases (schema-ready, default-safe) ──
  /** Prepaid settlement balance (Phase 3). */
  walletBalance: number;
  /** Margin the reseller adds over our wholesale price, in percent (Phase 3). */
  markupPercent: number;
  /** Light white-label branding (Phase 5). */
  branding?: {
    displayName?: string;
    logoUrl?: string;
    supportEmail?: string;
  };

  // ── Audit ──
  approvedAt?: Date | null;
  approvedBy?: Schema.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const ResellerSchema = new Schema<IReseller>(
  {
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    businessName: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    status: {
      type: String,
      enum: [...RESELLER_STATUSES],
      default: "pending",
      index: true,
    },
    walletBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    markupPercent: {
      type: Number,
      default: 0,
      min: 0,
    },
    branding: {
      displayName: { type: String, trim: true },
      logoUrl: { type: String, trim: true },
      supportEmail: { type: String, trim: true, lowercase: true },
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

export default (mongoose.models.Reseller as mongoose.Model<IReseller>) ||
  mongoose.model<IReseller>("Reseller", ResellerSchema);
