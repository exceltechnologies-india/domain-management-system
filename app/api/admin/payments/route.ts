import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayPaymentsService } from "@/lib/razorpay-payments";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import User from "@/models/User";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // Check admin authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Connect to database
    await connectDB();

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "5");
    const skip = parseInt(searchParams.get("skip") || "0");
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    // For the latest transactions, we'll fetch a reasonable number to ensure we have enough domain payments
    // Since we want only the latest 5, we'll fetch more to filter domain payments and include failed payments
    const fetchLimit = Math.max(limit * 5, 25); // Fetch 5x the requested limit or minimum 25 for better filtering
    const fetchSkip = 0; // Always start from the beginning to get the latest payments

    let razorpayPayments;

    // Fetch payments from Razorpay
    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      razorpayPayments = await RazorpayPaymentsService.getPaymentsByDateRange(
        fromDate,
        toDate,
        fetchLimit,
        fetchSkip
      );
    } else {
      razorpayPayments = await RazorpayPaymentsService.getAllPayments(
        fetchLimit,
        fetchSkip
      );
    }

    // Filter only domain-related payments
    const allDomainPayments = RazorpayPaymentsService.filterDomainPayments(
      razorpayPayments.items
    );

    // Get our order data to match with Razorpay payments
    const ourOrders = await Order.find({
      razorpayPaymentId: { $in: allDomainPayments.map((p) => p.id) },
    }).populate("userId", "firstName lastName email");

    // Create a map of Razorpay payment ID to our order data
    const orderMap = new Map();
    ourOrders.forEach((order) => {
      orderMap.set(order.razorpayPaymentId, order);
    });

    // Get all unique email addresses from payments to look up users
    const uniqueEmails = Array.from(
      new Set(allDomainPayments.map((p) => p.email))
    );
    const usersByEmail = await User.find({
      email: { $in: uniqueEmails },
    }).select("email firstName lastName");

    // Create a map of email to user data
    const userMap = new Map();
    usersByEmail.forEach((user) => {
      userMap.set(user.email, user);
    });

    // Combine Razorpay payment data with our order data
    const allEnrichedPayments = await Promise.all(
      allDomainPayments.map(async (razorpayPayment) => {
        const orderData = orderMap.get(razorpayPayment.id);
        const paymentDetails =
          await RazorpayPaymentsService.getDomainPaymentDetails(
            razorpayPayment
          );

        // Get customer name from order data, payment details, or user lookup
        let customerName = "Unknown";
        if (orderData?.userId) {
          customerName =
            `${orderData.userId.firstName || ""} ${
              orderData.userId.lastName || ""
            }`.trim() || "Unknown";
        } else if (paymentDetails.customerName) {
          customerName = paymentDetails.customerName;
        } else {
          // Look up user by email
          const userByEmail = userMap.get(razorpayPayment.email);
          if (userByEmail) {
            customerName =
              `${userByEmail.firstName || ""} ${
                userByEmail.lastName || ""
              }`.trim() || "Unknown";
          }
        }

        return {
          id: razorpayPayment.id,
          transactionId: razorpayPayment.id,
          amount: razorpayPayment.amount / 100, // Convert from paise to rupees
          currency: razorpayPayment.currency.toUpperCase(),
          status: razorpayPayment.status,
          paymentMethod: razorpayPayment.method || "Unknown",
          customerName,
          customerEmail:
            orderData?.userId?.email ||
            paymentDetails.customerEmail ||
            razorpayPayment.email,
          domainNames:
            orderData?.domains?.map((d: any) => d.domainName) ||
            paymentDetails.domainNames ||
            [],
          orderId: orderData?.orderId || paymentDetails.orderId,
          invoiceNumber: orderData?.invoiceNumber,
          createdAt: razorpayPayment.created_at
            ? new Date(razorpayPayment.created_at * 1000).toISOString()
            : new Date().toISOString(),
          processedAt:
            razorpayPayment.captured && razorpayPayment.updated_at
              ? new Date(razorpayPayment.updated_at * 1000).toISOString()
              : undefined,
          refunded: razorpayPayment.amount_refunded > 0,
          refundAmount: razorpayPayment.amount_refunded / 100,
          refundStatus: razorpayPayment.refund_status,
          fee: razorpayPayment.fee ? razorpayPayment.fee / 100 : 0,
          tax: razorpayPayment.tax ? razorpayPayment.tax / 100 : 0,
          errorCode: razorpayPayment.error_code,
          errorDescription: razorpayPayment.error_description,
          notes: razorpayPayment.notes,
        };
      })
    );

    // Sort by creation date (newest first)
    allEnrichedPayments.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Apply pagination to the filtered and enriched results
    // Since we're fetching from the beginning, we need to adjust pagination
    const startIndex = skip;
    const endIndex = skip + limit;
    const paginatedPayments = allEnrichedPayments.slice(startIndex, endIndex);

    // For total count, we need to get the actual count of domain payments
    // Since we're filtering payments, we need to fetch more to get an accurate count
    // In a production environment, you might want to store this count in your database
    let totalDomainPayments = allEnrichedPayments.length;

    // If we have more payments available from Razorpay, we need to estimate the total
    if (razorpayPayments.count > fetchLimit + fetchSkip) {
      // Estimate based on the ratio of domain payments to total payments fetched
      const domainRatio =
        allDomainPayments.length / razorpayPayments.items.length;
      totalDomainPayments = Math.ceil(razorpayPayments.count * domainRatio);
    }

    return NextResponse.json({
      success: true,
      payments: paginatedPayments,
      total: totalDomainPayments,
      hasMore:
        paginatedPayments.length === limit &&
        endIndex < allEnrichedPayments.length,
    });
  } catch (error) {
    serverLogger.error("Failed to fetch admin payments:", error);
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 }
    );
  }
}
