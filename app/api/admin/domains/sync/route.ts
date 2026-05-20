import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { DomainVerificationService } from "@/lib/domain-verification";
import { getToken } from "next-auth/jwt";
import { getUserByIdSafe } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    // 1. Verify admin authentication
    let user = await AuthService.getUserFromRequest(request);
    
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        user = await getUserByIdSafe(token.id);
      }
    }

    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { domainName, domainNames } = await request.json();

    // 2. Handle single domain sync
    if (domainName) {
      const result = await DomainVerificationService.syncDomainWithRegistrar(domainName);
      return NextResponse.json(result);
    }

    // 3. Handle batch domain sync
    if (domainNames && Array.isArray(domainNames)) {
      const results = [];
      for (const name of domainNames) {
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = await DomainVerificationService.syncDomainWithRegistrar(name);
        results.push(result);
      }
      return NextResponse.json({
        success: true,
        results,
      });
    }

    return NextResponse.json({ error: "No domain name provided" }, { status: 400 });
  } catch (error: unknown) {
    serverLogger.error("Admin domain sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync domain registrar information" },
      { status: 500 }
    );
  }
}
