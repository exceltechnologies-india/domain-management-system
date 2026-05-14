import mongoose, { Schema, Document, Types } from "mongoose";
import crypto from "crypto";

export interface IAttachment {
  filename: string;
  mimeType: string;     // image/jpeg, image/png, image/webp, image/gif
  size: number;         // bytes
  dataUrl: string;      // full data:image/...;base64,<payload>
}

export interface IMessage {
  content: string;
  authorId: Types.ObjectId;
  authorRole: "user" | "admin";
  authorName: string;
  attachments?: IAttachment[];
  createdAt: Date;
}

export interface ISupportTicket extends Document {
  ticketNumber: string;
  userId: Types.ObjectId;
  userEmail: string;
  userName: string;
  subject: string;
  category: "domain" | "hosting" | "billing" | "technical" | "other";
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: "low" | "medium" | "high";
  messages: IMessage[];
  resolvedAt?: Date;
}

const AttachmentSchema = new Schema<IAttachment>(
  {
    filename: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    dataUrl: { type: String, required: true },
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    content: { type: String, required: true, trim: true, maxlength: 5000 },
    authorId: { type: Schema.Types.ObjectId, required: true },
    authorRole: { type: String, enum: ["user", "admin"], required: true },
    authorName: { type: String, required: true, trim: true },
    attachments: { type: [AttachmentSchema], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const SupportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketNumber: { type: String, unique: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userEmail: { type: String, required: true, lowercase: true, trim: true },
    userName: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    category: {
      type: String,
      enum: ["domain", "hosting", "billing", "technical", "other"],
      default: "other",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    messages: [MessageSchema],
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

// Admin queue: list tickets by status sorted by recency.
SupportTicketSchema.index({ status: 1, createdAt: -1 });

SupportTicketSchema.pre("save", function (next) {
  if (!this.ticketNumber) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
    this.ticketNumber = `TKT-${date}-${rand}`;
  }
  next();
});

let SupportTicket: mongoose.Model<ISupportTicket>;
try {
  SupportTicket = mongoose.model<ISupportTicket>("SupportTicket");
} catch {
  SupportTicket = mongoose.model<ISupportTicket>("SupportTicket", SupportTicketSchema);
}

export default SupportTicket;
