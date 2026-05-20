import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import {
  findInvoiceNumberConflicts,
  listOrdersByIds,
  listStuckZohoInvoiceOrdersAdmin,
} from "@/lib/services/orders";
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

interface LeanOrder {
  _id: unknown;
  orderId: string;
  userId: unknown;
  status: string;
  amount: number;
  invoiceNumber?: string;
  zohoInvoiceId?: string;
  razorpayPaymentId?: string;
  createdAt?: Date;
  isDeleted?: boolean;
}

interface LeanUser {
  _id: unknown;
  email?: string;
  firstName?: string;
  lastName?: string;
}

function slim(order: LeanOrder, user: LeanUser | undefined): OrderSlim {
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
    createdAt: order.createdAt?.toISOString?.() || "",
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

    // --- 1. Find invoiceNumber values held by more than one Order doc ---
    const dupes = await findInvoiceNumberConflicts();

    const allOrderIds = dupes.flatMap((d) => d.orderIds);
    const dupeOrders = await listOrdersByIds(
      allOrderIds,
      "_id orderId userId userEmail userName status amount invoiceNumber zohoInvoiceId razorpayPaymentId createdAt isDeleted"
    );

    const userIds = [
      ...new Set((dupeOrders as unknown as LeanOrder[]).map((o) => String(o.userId))),
    ];
    const users = (await findUsersByIds(userIds)) as unknown as LeanUser[];
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const ordersBy_Id = new Map(
      (dupeOrders as unknown as LeanOrder[]).map((o) => [String(o._id), o])
    );

    const conflicts = dupes.map((d) => ({
      invoiceNumber: d._id as string,
      count: d.count as number,
      orders: (d.orderIds as unknown[])
        .map((id) => ordersBy_Id.get(String(id)))
        .filter((o): o is LeanOrder => Boolean(o))
        .map((o) => slim(o, userById.get(String(o.userId)))),
    }));

    // --- 2. Find paid orders whose Zoho invoice never resolved ---
    const stuckDocs = await listStuckZohoInvoiceOrdersAdmin({
      limit: 100,
      select:
        "_id orderId userId userEmail userName status amount invoiceNumber zohoInvoiceId razorpayPaymentId createdAt isDeleted",
    });

    const stuckUserIds = [
      ...new Set((stuckDocs as unknown as LeanOrder[]).map((o) => String(o.userId))),
    ];
    const stuckUsersExtra = (await findUsersByIds(
      stuckUserIds.filter((id) => !userById.has(id))
    )) as unknown as LeanUser[];
    for (const u of stuckUsersExtra) {
      userById.set(String(u._id), u);
    }

    const stuckOrders = (stuckDocs as unknown as LeanOrder[]).map((o) =>
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
  } catch (err: unknown) {
    serverLogger.error("[InvoiceConflicts] Failed:", err);
    const message = err instanceof Error ? err.message : "Diagnostics failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
