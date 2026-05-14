import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import User from "@/models/User";
import { getToken } from "next-auth/jwt";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    
    // Try to get user from JWT token first
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");
        
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check admin authentication
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const archived = searchParams.get("archived");

    const page = parseInt(searchParams.get("page") || "1");
    const perPage = parseInt(searchParams.get("per_page") || "100");
    const skip = (page - 1) * perPage;

    let query = {};
    if (archived === "true") {
      // Fetch only archived orders
      query = { isDeleted: true };
    } else {
      // Fetch only active orders (default behavior)
      query = { isDeleted: { $ne: true } };
    }

    // Fetch orders with user details
    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate("userId", "firstName lastName email", User);

    const total = await Order.countDocuments(query);
    const hasMore = skip + orders.length < total;

    return NextResponse.json({
      success: true,
      orders: orders.map(order => {
        const orderObj = order.toObject();
        // If userId population failed (user deleted) or is missing, use the snapshot
        if (!orderObj.userId && (orderObj.userName || orderObj.userEmail)) {
          orderObj.userId = {
            firstName: orderObj.userName?.split(' ')[0] || 'Unknown',
            lastName: orderObj.userName?.split(' ').slice(1).join(' ') || '',
            email: orderObj.userEmail || 'Deleted User',
            _id: null,
            isDeleted: true
          };
        }
        return orderObj;
      }),
      page_context: {
        has_more_page: hasMore,
        page,
        per_page: perPage,
        total
      }
    });
  } catch (error) {
    serverLogger.error("Failed to fetch admin orders:", error);
    return NextResponse.json(
      { error: "Failed to fetch orders" },
      { status: 500 }
    );
  }
}
