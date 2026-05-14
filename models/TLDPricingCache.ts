import mongoose, { Schema, Document } from "mongoose";

export interface ITLDPricingCache extends Document {
  key: string; // Always 'tld_pricing_cache' for singleton pattern
  tldPricing: Array<{
    tld: string;
    customerPrice: number;
    resellerPrice: number;
    currency: string;
    category: string;
    description?: string;
    margin?: number;
  }>;
  totalCount: number;
  lastUpdated: string;
  pricingSource: string;
  cachedAt: Date;
  expiresAt: Date;
  ttlMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

const TLDPricingCacheSchema = new Schema<ITLDPricingCache>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "tld_pricing_cache",
    },
    tldPricing: [
      {
        tld: { type: String, required: true },
        customerPrice: { type: Number, required: true },
        resellerPrice: { type: Number, required: true },
        currency: { type: String, required: true },
        category: { type: String, required: true },
        description: { type: String },
        margin: { type: Number },
      },
    ],
    totalCount: {
      type: Number,
      required: true,
    },
    lastUpdated: {
      type: String,
      required: true,
    },
    pricingSource: {
      type: String,
      required: true,
    },
    cachedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    ttlMinutes: {
      type: Number,
      required: true,
      default: 60,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient lookup and TTL
TLDPricingCacheSchema.index({ expiresAt: 1 });

const TLDPricingCache =
  mongoose.models.TLDPricingCache ||
  mongoose.model<ITLDPricingCache>("TLDPricingCache", TLDPricingCacheSchema);

export default TLDPricingCache;
