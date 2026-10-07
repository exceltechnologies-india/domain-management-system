import mongoose, { Document, Schema } from "mongoose";

/**
 * One row per email DMS tries to send (7 Oct 2026, Pawan). Until now DMS sent mail without a
 * trace — no log line in production, no row — so "did the customer's 'Your Customer Portal is
 * ready' email leave?" could not be answered without sending a test. ResellerOS keeps the same
 * kind of record in its email_log table.
 *
 * What is kept: who it went to, the subject, whether the mail server ACCEPTED it (not whether
 * it reached the inbox — no SMTP send can know that), its message id and the server's reply,
 * or the error. Never the body: account emails carry one-time passwords.
 */
export interface IEmailLog extends Document {
  to: string;
  subject: string;
  status: "sent" | "failed" | "skipped";
  messageId?: string;
  response?: string;
  error?: string;
  createdAt: Date;
}

const EmailLogSchema = new Schema<IEmailLog>(
  {
    to: { type: String, required: true },
    subject: { type: String, required: true },
    status: { type: String, enum: ["sent", "failed", "skipped"], required: true },
    messageId: { type: String },
    response: { type: String },
    error: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

EmailLogSchema.index({ to: 1, createdAt: -1 });
// Kept 180 days, then removed by Mongo on its own.
EmailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export default mongoose.models.EmailLog || mongoose.model<IEmailLog>("EmailLog", EmailLogSchema);
