import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { findUsersByIds } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

interface OrderSlim {
  _id: string;
  orderId: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  status: string;
  amount: number;
  invoiceNumber?: string;
  zohoInvoiceId?: string;
  razorpayPaymentId?: string;
  createdAt: string;
  isDeleted?: boolean;
}

function slim(order: any, user: any): OrderSlim {
  return {
    _id: String(order._id),
    orderId: order.orderId,
    userId: String(order.userId),
    userEmail: user?.email,
    userName: user
      ? `${user.firstName || ""} ${user.lastName || ""}`.trim()
      : undefined,
    status: order.status,
    amount: order.amount,
    invoiceNumber: order.invoiceNumber,
    zohoInvoiceId: order.zohoInvoiceId,
    razorpayPaymentId: order.razorpayPaymentId,
    createdAt: (order.createdAt as Date)?.toISOString?.() || "",
    isDeleted: order.isDeleted,
  };
}

/**
 * GET /api/admin/orders/invoice-conflicts
 *
 * Diagnostic for the Zoho-invoice reconciliation flow. Surfaces two classes
 * of bad state that cause the user-facing "Generating invoice…" pill or
 * E11000 duplicate-key errors during retries:
 *
 *  1. invoiceNumber collisions — two or more Order docs share the same
 *     invoiceNumber (the unique index trips when reconciling).
 *  2. Stuck orders — paid orders whose zohoInvoiceId never resolved (missing
 *     or stuck at "creation_failed" / "pending_creation").
 */
export async function GET(request: NextRequest) {
  try {
    const adminUser = await AuthService.getUserFromRequest(request);
    if (!adminUser || adminUser.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectDB();

    // --- 1. Find invoiceNumber values held by more than one Order doc ---
    const dupes = await Order.aggregate([
      { $match: { invoiceNumber: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: "$invoiceNumber",
          count: { $sum: 1 },
          orderIds: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 100 },
    ]);

    const allOrderIds = dupes.flatMap((d) => d.orderIds);
    const dupeOrders = allOrderIds.length
      ? await Order.find({ _id: { $in: allOrderIds } })
          .select(
            "_id orderId userId userEmail userName status amount invoiceNumber zohoInvoiceId razorpayPaymentId createdAt isDeleted"
          )
          .lean()
      : [];

    const userIds = [
      ...new Set(dupeOrders.map((o: any) => String(o.userId))),
    ];
    const users = await findUsersByIds(userIds);
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const ordersBy_Id = new Map(
      dupeOrders.map((o: any) => [String(o._id), o])
    );

    const conflicts = dupes.map((d) => ({
      invoiceNumber: d._id as string,
      count: d.count as number,
      orders: (d.orderIds as any[])
        .map((id) => ordersBy_Id.get(String(id)))
        .filter(Boolean)
        .map((o: any) => slim(o, userById.get(String(o.userId)))),
    }));

    // --- 2. Find paid orders whose Zoho invoice never resolved ---
    const stuckDocs = await Order.find({
      status: { $in: ["completed", "paid"] },
      isDeleted: { $ne: true },
      $or: [
        { zohoInvoiceId: { $exists: false } },
        { zohoInvoiceId: null },
        { zohoInvoiceId: "" },
        { zohoInvoiceId: "creation_failed" },
        { zohoInvoiceId: "pending_creation" },
      ],
    })
      .select(
        "_id orderId userId userEmail userName status amount invoiceNumber zohoInvoiceId razorpayPaymentId createdAt isDeleted"
      )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const stuckUserIds = [
      ...new Set(stuckDocs.map((o: any) => String(o.userId))),
    ];
    const stuckUsersExtra = await findUsersByIds(
      stuckUserIds.filter((id) => !userById.has(id))
    );
    for (const u of stuckUsersExtra) {
      userById.set(String(u._id), u);
    }

    const stuckOrders = stuckDocs.map((o: any) =>
      slim(o, userById.get(String(o.userId)))
    );

    return NextResponse.json({
      success: true,
      conflicts,
      stuckOrders,
      summary: {
        conflictGroups: conflicts.length,
        conflictedOrders: conflicts.reduce((s, c) => s + c.orders.length, 0),
        stuckOrders: stuckOrders.length,
      },
    });
  } catch (err: any) {
    serverLogger.error("[InvoiceConflicts] Failed:", err);
    return NextResponse.json(
      { error: err?.message || "Diagnostics failed" },
      { status: 500 }
    );
  }
}
