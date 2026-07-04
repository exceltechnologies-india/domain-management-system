import mongoose, { Document, Schema } from "mongoose";

/**
 * WhatsApp outbound message delivery audit.
 *
 * One row per outbound template send, keyed on the Meta message id (wamid).
 * The send path inserts a row with status='sent'; the inbound webhook's
 * delivery-status callbacks update it to delivered/read/failed. Gives the
 * operator a "did the day-14 reminder actually reach the customer?" trail
 * that raw fire-and-forget sends can't answer.
 *
 * A regular (not capped) collection with a TTL index — capped collections
 * reject updates that grow the doc, and our status-transition updates add
 * an `error` string, which would violate that. TTL auto-rotates rows after
 * 90 days so the collection stays bounded without a capped size.
 */
export interface IWhatsAppMessageLog extends Document {
  messageId: string; // Meta wamid
  to: string; // recipient phone (as Meta reports it)
  template?: string; // template name used
  status: "sent" | "delivered" | "read" | "failed" | "unknown";
  error?: string; // populated when status='failed'
  createdAt: Date;
  updatedAt: Date;
}

const WhatsAppMessageLogSchema = new Schema<IWhatsAppMessageLog>({
  messageId: { type: String, required: true, index: true },
  to: { type: String, required: true },
  template: { type: String },
  status: {
    type: String,
    enum: ["sent", "delivered", "read", "failed", "unknown"],
    default: "sent",
  },
  error: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// TTL — auto-expire rows 90 days after creation. Keeps the audit bounded.
WhatsAppMessageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
// Recent-first listing for the admin read.
WhatsAppMessageLogSchema.index({ createdAt: -1 });

export default mongoose.models.WhatsAppMessageLog ||
  mongoose.model<IWhatsAppMessageLog>("WhatsAppMessageLog", WhatsAppMessageLogSchema);
