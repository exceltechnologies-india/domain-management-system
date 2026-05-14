import mongoose, { Schema, Document } from "mongoose";

export interface IDNSRecord extends Document {
  domainId: string;
  recordType: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

const DNSRecordSchema = new Schema<IDNSRecord>(
  {
    domainId: {
      type: String,
      required: [true, "Domain ID is required"],
    },
    recordType: {
      type: String,
      enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS"],
      required: [true, "Record type is required"],
    },
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    value: {
      type: String,
      required: [true, "Value is required"],
      trim: true,
    },
    ttl: {
      type: Number,
      required: [true, "TTL is required"],
      min: 300,
      max: 86400,
      default: 3600,
    },
    priority: {
      type: Number,
      min: 0,
      max: 65535,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
DNSRecordSchema.index({ domainId: 1, recordType: 1 });
DNSRecordSchema.index({ domainId: 1 });

// Check if the model already exists
let DNSRecord: mongoose.Model<IDNSRecord>;

try {
  DNSRecord = mongoose.model<IDNSRecord>("DNSRecord");
} catch (error) {
  // Model doesn't exist, create it
  DNSRecord = mongoose.model<IDNSRecord>("DNSRecord", DNSRecordSchema);
}

export default DNSRecord;
