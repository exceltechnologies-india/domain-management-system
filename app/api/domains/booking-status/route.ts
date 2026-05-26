import { NextRequest, NextResponse } from "next/server";
import type { IOrder } from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";
import {
  findOrderByDomain,
  findOrderDomain,
  getOrderByOrderId,
} from "@/lib/services/orders";
import { validatedBody, validatedQuery, z } from "@/lib/api-validation";

const bookingStatusQuerySchema = z
  .object({
    orderId: z.string().optional(),
    domainName: z.string().trim().toLowerCase().min(3).max(253).optional(),
  })
  .refine((d) => Boolean(d.orderId || d.domainName), {
    message: "Order ID or domain name is required",
    path: ["orderId"],
  });

// step is a fixed enum at the model layer (Order.domains.bookingStatus.step).
// Mirror it here so the model save doesn't reject a free-form string later.
const bookingStepSchema = z.enum([
  "dns_activated",
  "payment_verified",
  "customer_created",
  "contact_created",
  "domain_registering",
  "domain_pending",
  "domain_registered",
  "domain_failed",
  "hosting_deferred",
]);

const bookingStatusPostSchema = z.object({
  orderId: z.string().min(1),
  domainName: z.string().trim().toLowerCase().min(3).max(253),
  step: bookingStepSchema,
  message: z.string().min(1).max(2000),
  progress: z.number().int().min(0).max(100),
});

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const validation = validatedQuery(request, bookingStatusQuerySchema);
    if (!validation.ok) return validation.response;
    const { orderId, domainName } = validation.data;

    const populate = { path: "userId", select: "email firstName lastName" };
    // orderId wins when both are supplied — matches the prior findOne behavior
    // (Mongo would pick whichever index it preferred); keep deterministic here.
    const order = orderId
      ? await getOrderByOrderId(orderId, { populate })
      : await findOrderByDomain(domainName!, { populate });

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Find the specific domain if domainName was provided
    let domainData = null;
    if (domainName) {
      domainData = findOrderDomain(order, domainName);
    } else {
      // Return all domains if only orderId was provided
      domainData = order.domains;
    }

    return NextResponse.json({
      success: true,
      orderId: order.orderId,
      status: order.status,
      domains: domainData,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    });
  } catch (error) {
    serverLogger.error("Error fetching domain booking status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const validation = await validatedBody(request, bookingStatusPostSchema);
    if (!validation.ok) return validation.response;
    const { orderId, domainName, step, message, progress } = validation.data;

    const order = await getOrderByOrderId(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const domainIndex = order.domains.findIndex(
      (d: IOrder['domains'][number]) => d.domainName === domainName
    );
    if (domainIndex === -1) {
      return NextResponse.json(
        { error: "Domain not found in order" },
        { status: 404 }
      );
    }

    // Add new booking status step
    order.domains[domainIndex].bookingStatus.push({
      step,
      message,
      timestamp: new Date(),
      progress,
    });

    // Update domain status based on step
    if (step === "domain_registered") {
      order.domains[domainIndex].status = "registered";
    } else if (step === "domain_failed") {
      order.domains[domainIndex].status = "failed";
    } else if (step === "domain_registering") {
      order.domains[domainIndex].status = "processing";
    }

    await order.save();

    return NextResponse.json({
      success: true,
      message: "Booking status updated successfully",
    });
  } catch (error) {
    serverLogger.error("Error updating domain booking status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
