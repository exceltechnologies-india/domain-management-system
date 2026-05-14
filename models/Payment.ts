import mongoose, { Schema, Document } from "mongoose";

export interface IPayment extends Document {
  userId: string;
  orderId: string;
  razorpayPaymentId: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed" | "refunded";
  domainIds: string[];
}

const PaymentSchema = new Schema<IPayment>(
  {
    userId: {
      type: String,
      required: [true, "User ID is required"],
    },
    orderId: {
      type: String,
      required: [true, "Order ID is required"],
      unique: true,
    },
    razorpayPaymentId: {
      type: String,
      required: [true, "Razorpay Payment ID is required"],
      unique: true,
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: 0,
    },
    currency: {
      type: String,
      required: [true, "Currency is required"],
      default: "INR",
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded"],
      default: "pending",
    },
    domainIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "Domain",
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
PaymentSchema.index({ userId: 1, status: 1 });

// Check if the model already exists
let Payment: mongoose.Model<IPayment>;

try {
  Payment = mongoose.model<IPayment>("Payment");
} catch (error) {
  // Model doesn't exist, create it
  Payment = mongoose.model<IPayment>("Payment", PaymentSchema);
}

export default Payment;
