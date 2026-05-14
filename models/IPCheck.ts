import mongoose, { Schema, Document } from "mongoose";

export interface IIPCheck extends Document {
  success: boolean;
  message: string;
  data?: {
    primaryIP: string;
    allIPs: string[];
    timestamp: string;
    services: Record<string, any>;
    serverInfo?: {
      userAgent?: string;
      host?: string;
      forwarded?: string;
      realIP?: string;
    };
  };
  error?: string;
  checkedBy: string; // Admin user ID who triggered the check
  checkedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const IPCheckSchema = new Schema<IIPCheck>(
  {
    success: {
      type: Boolean,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    data: {
      primaryIP: String,
      allIPs: [String],
      timestamp: String,
      services: Schema.Types.Mixed,
      serverInfo: {
        userAgent: String,
        host: String,
        forwarded: String,
        realIP: String,
      },
    },
    error: String,
    checkedBy: {
      type: String,
      required: true,
    },
    checkedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Create index for efficient queries
IPCheckSchema.index({ checkedAt: -1 });
IPCheckSchema.index({ checkedBy: 1 });

export default mongoose.models.IPCheck ||
  mongoose.model<IIPCheck>("IPCheck", IPCheckSchema);
