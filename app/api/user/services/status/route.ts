import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import Order from "@/models/Order";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";

// Force dynamic rendering
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectDB();



    // Try to get user from JWT token first
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken
    if (!user) {
      const secret = AUTH_SECRET;
      const token = await getToken({ 
        req: request,
        secret,
        cookieName: "next-auth.session-token",
      }) || await getToken({ 
        req: request,
        secret,
      });
      
      if (token?.id) {
        user = await User.findById(token.id).select("-password");
        
        if (!user || !user.isActive) {
          serverLogger.warn(`[ServiceStatusAPI] User invalid: ${token.id}`);
          return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
        }
      }
    }
    
    if (!user) {
      serverLogger.warn("[ServiceStatusAPI] Auth failed");
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    // Get user's orders to check for active services
    const orders = await Order.find({
      userId: user._id,
      isDeleted: { $ne: true },
    }).select('domains amount status');

    // Check for active domains
    // A user has active domains if they have any order with domains that are NOT active hosting items
    // This is a bit complex because we need to check the domains array in each order
    
    // 1. Check for domains in orders
    const hasDomains = orders.some(order => 
      order.domains.some((item: any) => 
        // Must be a domain item (not hosting) OR explicitly marked as domain
        (item.itemType === 'domain' || !item.itemType) && 
        // Must NOT be cancelled/failed
        !['cancelled', 'failed', 'terminated'].includes(item.status)
      )
    );

    // 2. Check for hosting
    // A user has hosting if:
    // a) They have a directAdminUsername in their user profile (most reliable)
    // b) OR they have an order with itemType='hosting'
    
    let hasHosting = !!user.directAdminUsername;
    const hostedDomains: string[] = [];
    
    // Find all domains that have hosting associated with them
    orders.forEach(order => {
      order.domains.forEach((item: any) => {
        if (item.itemType === 'hosting' && !['cancelled', 'failed', 'terminated'].includes(item.status)) {
          hasHosting = true;
          if (item.domainName) {
            hostedDomains.push(item.domainName);
          }
        }
      });
    });

    // If we have a directAdminUsername but didn't find specific hosting orders (legacy/manual),
    // we might not know the exact domain easily without querying DA, but we at least know they have hosting.
    // However, for the purpose of the UI restriction, we primarily rely on the order data 
    // or if we can infer it. 
    
    return NextResponse.json({
      hasDomains,
      hasHosting,
      hostedDomains: Array.from(new Set(hostedDomains)) // Unique domains
    });

  } catch (error) {
    serverLogger.error("Service status API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
