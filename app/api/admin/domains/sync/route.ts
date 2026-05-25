import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { DomainVerificationService } from "@/lib/domain-verification";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const syncDomainsSchema = z
  .object({
    domainName: z.string().trim().toLowerCase().min(3).max(253).optional(),
    domainNames: z
      .array(z.string().trim().toLowerCase().min(3).max(253))
      .min(1)
      .max(100, "Cannot sync more than 100 domains in a single request")
      .optional(),
  })
  .refine((d) => Boolean(d.domainName || d.domainNames), {
    message: "Either domainName or domainNames is required",
    path: ["domainName"],
  });

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, syncDomainsSchema);
    if (!validation.ok) return validation.response;
    const { domainName, domainNames } = validation.data;

    // Single-domain sync
    if (domainName) {
      const result = await DomainVerificationService.syncDomainWithRegistrar(domainName);
      return NextResponse.json(result);
    }

    // Batch sync — Zod refine guarantees domainNames is present here
    const results = [];
    for (const name of domainNames!) {
      // Add small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await DomainVerificationService.syncDomainWithRegistrar(name);
      results.push(result);
    }
    return NextResponse.json({
      success: true,
      results,
    });
  } catch (error: unknown) {
    serverLogger.error("Admin domain sync error:", error);
    return NextResponse.json(
      { error: "Failed to sync domain registrar information" },
      { status: 500 }
    );
  }
}
