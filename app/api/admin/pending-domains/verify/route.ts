import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import { DomainVerificationService } from "@/lib/domain-verification";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const verifyPendingDomainsSchema = z.object({
  domainIds: z
    .array(z.string().min(1))
    .min(1, "Domain IDs array is required")
    .max(100, "Cannot verify more than 100 pending domains in a single request"),
});

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, verifyPendingDomainsSchema);
    if (!validation.ok) return validation.response;
    const { domainIds } = validation.data;

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
