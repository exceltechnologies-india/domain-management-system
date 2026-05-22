import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import connectDB from "@/lib/mongodb";
import { getUserById, userHasPassword } from "@/lib/services/users";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await getUserById(token.id);

        if (!user || !user.isActive) {
          return secureErrorResponse("Not authenticated", 401, "UNAUTHORIZED");
        }
      }
    }

    if (!user) {
      return secureErrorResponse("Not authenticated", 401, "UNAUTHORIZED");
    }

    // `user.password` is select:false on the model. Check via the service
    // helper so the bcrypt hash never enters this handler's scope.
    const hasPassword = await userHasPassword(user._id);
    
    // Ensure profileCompleted is a strict boolean (true/false)
    // MongoDB might return it as undefined or other values
    const profileCompleted = user.profileCompleted === true ? true : false;

    return secureJsonResponse({
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActivated: user.isActivated,
        isActive: user.isActive,
        profileCompleted: profileCompleted, // Always return strict boolean
        provider: user.provider,
        password: hasPassword, // Boolean indicating if password exists
        // Include complete profile data to prevent data loss
        phone: user.phone,
        phoneCc: user.phoneCc,
        companyName: user.companyName,
        address: user.address,
      },
    });
  } catch (error) {
    serverLogger.error("Get user error:", error);
    return secureErrorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
}
