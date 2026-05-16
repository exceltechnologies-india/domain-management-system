import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import { getPendingDomainByName } from "@/lib/services/pending-domains";
import Order from "@/models/Order";
import { getUserByIdSafe } from "@/lib/services/users";
import { getToken } from "next-auth/jwt";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    // Verify admin authentication - Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await getUserByIdSafe(token.id);
        
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check if user is admin
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get query parameters
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const search = searchParams.get("search");
    const archived = searchParams.get("archived") === "true"; // Show archived domains if true

    // STEP 1: Get domains from PendingDomain collection
    const pendingDomainQuery: any = {};
    
    // Filter by archived status
    if (archived) {
      // Show only archived domains
      pendingDomainQuery.isArchived = true;
    } else {
      // Show only active (non-archived) domains
      pendingDomainQuery.isArchived = { $ne: true };
    }
    if (status && status !== "all") {
      pendingDomainQuery.status = status;
    }
    if (search) {
      pendingDomainQuery.$or = [
        { domainName: { $regex: search, $options: "i" } },
        { orderId: { $regex: search, $options: "i" } },
      ];
    }

    const pendingDomainsFromCollection = await PendingDomain.find(
      pendingDomainQuery
    )
      .populate("userId", "firstName lastName email phone companyName")
      .sort({ createdAt: -1 })
      .lean();

    // STEP 2: Get domains from Orders with pending/processing status
    // Only fetch from orders if NOT showing archived domains (archived domains are only in PendingDomain collection)
    const pendingDomainsFromOrders: any[] = [];
    
    if (!archived) {
      const orderQuery: any = {
        isDeleted: { $ne: true },
        "domains.status": { $in: ["pending", "processing"] },
      };

      const ordersWithPendingDomains = await Order.find(orderQuery)
        .populate("userId", "firstName lastName email phone companyName")
        .sort({ createdAt: -1 })
        .lean();

      // Extract pending/processing domains from orders
      for (const order of ordersWithPendingDomains) {
        for (const domain of order.domains) {
          // Skip if domain status is not pending/processing OR if it's a hosting item
          if ((domain.status !== "pending" && domain.status !== "processing") || domain.itemType === 'hosting') {
            continue;
          }
          // Check if this domain is already in PendingDomain collection
          const existsInCollection = pendingDomainsFromCollection.some(
            (pd: any) =>
              pd.domainName.toLowerCase() === domain.domainName.toLowerCase()
          );

          // Only add if not already in PendingDomain collection
          if (!existsInCollection) {
            // Apply status filter if specified
            if (status && status !== "all" && domain.status !== status) {
              continue;
            }

            // Apply search filter if specified
            if (search) {
              const searchLower = search.toLowerCase();
              if (
                !domain.domainName.toLowerCase().includes(searchLower) &&
                !order.orderId.toLowerCase().includes(searchLower)
              ) {
                continue;
              }
            }

            // Transform Order domain to match PendingDomain structure
            pendingDomainsFromOrders.push({
              _id: `order_${order._id}_${domain.domainName}`, // Synthetic ID
              domainName: domain.domainName,
              price: domain.price,
              currency: domain.currency,
              registrationPeriod: domain.registrationPeriod,
              userId: order.userId,
              orderId: order.orderId,
              customerId: domain.resellerClubCustomerId || 0,
              contactId: domain.resellerClubContactId || 0,
              status: domain.status,
              reason: domain.error || "Domain registration in progress",
              verificationAttempts: 0,
              resellerClubOrderId: domain.resellerClubOrderId,
              createdAt: order.createdAt,
              updatedAt: order.updatedAt,
              source: "order", // Mark as coming from Order collection
            });
        }
      }
      }
    }

    // STEP 3: Merge both sources
    const allPendingDomains = [
      ...pendingDomainsFromCollection.map((pd: any) => ({
        ...pd,
        source: "pending_domain",
      })),
      ...pendingDomainsFromOrders,
    ].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // STEP 4: Apply pagination
    const skip = (page - 1) * limit;
    const paginatedDomains = allPendingDomains.slice(skip, skip + limit);
    const total = allPendingDomains.length;

    // STEP 5: Calculate status counts from all sources
    const statusSummary = {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    allPendingDomains.forEach((domain: any) => {
      const domainStatus = domain.status;
      if (domainStatus in statusSummary) {
        statusSummary[domainStatus as keyof typeof statusSummary]++;
        statusSummary.total++;
      }
    });

    return NextResponse.json({
      success: true,
      pendingDomains: paginatedDomains,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      statusSummary,
    });
  } catch (error) {
    // Log detailed error server-side only
    serverLogger.error("[ADMIN-PENDING-DOMAINS] Error fetching pending domains:", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });

    // Return generic error to client (don't expose internal details)
    return NextResponse.json(
      {
        success: false,
        error: "Unable to fetch pending domains. Please try again later.",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    // Verify admin authentication - Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await getUserByIdSafe(token.id);
        
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check if user is admin
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      domainName,
      price,
      currency,
      registrationPeriod,
      userId,
      orderId,
      customerId,
      contactId,
      nameServers,
      adminContactId,
      techContactId,
      billingContactId,
      reason,
    } = body;

    // Validate required fields
    if (
      !domainName ||
      !price ||
      !userId ||
      !orderId ||
      !customerId ||
      !contactId
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Check if domain already exists in pending domains
    const existingPending = await getPendingDomainByName(domainName);
    if (existingPending) {
      return NextResponse.json(
        { error: "Domain already exists in pending domains" },
        { status: 400 }
      );
    }

    // Create new pending domain
    const pendingDomain = new PendingDomain({
      domainName,
      price,
      currency: currency || "INR",
      registrationPeriod: registrationPeriod || 1,
      userId,
      orderId,
      customerId,
      contactId,
      nameServers,
      adminContactId,
      techContactId,
      billingContactId,
      reason:
        reason ||
        "Domain registration failed - likely due to insufficient funds",
      status: "pending",
      verificationAttempts: 0,
    });

    await pendingDomain.save();

    return NextResponse.json({
      success: true,
      message: "Pending domain created successfully",
      pendingDomain,
    });
  } catch (error) {
    // Log detailed error server-side only
    serverLogger.error("[ADMIN-PENDING-DOMAINS] Error creating pending domain:", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });

    // Return generic error to client (don't expose internal details)
    return NextResponse.json(
      {
        success: false,
        error: "Unable to create pending domain. Please try again later.",
      },
      { status: 500 }
    );
  }
}
