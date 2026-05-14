import { NextRequest, NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/admin-auth";

/**
 * Middleware to protect admin API routes
 * This should be used in the main middleware.ts file
 */
export async function protectAdminRoutes(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Check if the request is to an admin API route
  if (pathname.startsWith("/api/admin/")) {
    const authResult = await verifyAdminAuth(request);

    if (!authResult.valid) {
      return NextResponse.json(
        {
          error: authResult.error || "Access denied",
          code: "ADMIN_ACCESS_DENIED",
        },
        { status: 401 }
      );
    }
  }

  return NextResponse.next();
}
