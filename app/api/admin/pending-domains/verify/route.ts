import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import User from "@/models/User";
import { DomainVerificationService } from "@/lib/domain-verification";
import { getToken } from "next-auth/jwt";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

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
        user = await User.findById(token.id).select("-password");
        
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
    const { domainIds } = body;

    if (!domainIds || !Array.isArray(domainIds)) {
      return NextResponse.json(
        { error: "Domain IDs array is required" },
        { status: 400 }
      );
    }

    // Get pending domains
    const pendingDomains = await PendingDomain.find({
      _id: { $in: domainIds },
      status: "pending",
    });

    if (pendingDomains.length === 0) {
      return NextResponse.json(
        { error: "No pending domains found" },
        { status: 404 }
      );
    }

    // Extract domain names for verification
    const domainNames = pendingDomains.map((domain) => domain.domainName);

    // Verify domains
    const verificationResults =
      await DomainVerificationService.verifyMultipleDomains(domainNames);

    // Update pending domains based on verification results
    const updatedDomains = [];
    for (const result of verificationResults) {
      const pendingDomain = pendingDomains.find(
        (domain) => domain.domainName === result.domainName
      );

      if (pendingDomain) {
        // Update verification attempts and last verified date
        pendingDomain.verificationAttempts += 1;
        pendingDomain.lastVerifiedAt = new Date();

        // Update status based on verification result
        if (result.registrationStatus === "success") {
          pendingDomain.status = "completed";
          pendingDomain.reason =
            "Domain verification successful - registration completed";
        } else if (result.registrationStatus === "pending") {
          // Keep as pending, but update reason
          pendingDomain.reason = result.reason || pendingDomain.reason;
        } else {
          // Failed verification
          pendingDomain.status = "failed";
          pendingDomain.reason = result.reason || "Verification failed";
        }

        await pendingDomain.save();
        updatedDomains.push(pendingDomain);
      }
    }

    // Get summary
    const summary =
      DomainVerificationService.getVerificationSummary(verificationResults);

    return NextResponse.json({
      success: true,
      message: "Domain verification completed",
      verificationResults,
      updatedDomains,
      summary,
    });
  } catch (error) {
    serverLogger.error("Admin domain verification error:", error);
    return NextResponse.json(
      { error: "Failed to verify domains" },
      { status: 500 }
    );
  }
}
