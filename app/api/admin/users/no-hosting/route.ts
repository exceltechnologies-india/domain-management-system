import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import User from "@/models/User";
import connectDB from "@/lib/mongodb";

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users/no-hosting
 * Fetches all users who do not have a DirectAdmin hosting account yet.
 * Restricted to Admins only.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    await connectDB();
    
    // 2. Find all standard users (role: 'user')
    // We fetch ALL users so admins can provision multiple accounts for the same user.
    // The "no-hosting" route name is legacy but now serves "eligible-for-hosting".
    const users = await User.find({ 
      role: 'user' 
    }).select('firstName lastName email _id role').sort({ createdAt: -1 });

    const formattedUsers = users.map(u => ({
        id: u._id,
        name: `${u.firstName} ${u.lastName}`,
        email: u.email
    }));

    return secureJsonResponse({ 
      success: true, 
      data: formattedUsers
    });

  } catch (error: any) {
    serverLogger.error(`Admin Users No-Hosting Error:`, error.message);
    return secureErrorResponse(
      "Failed to fetch users",
      500,
      "USERS_FETCH_FAILED"
    );
  }
}
