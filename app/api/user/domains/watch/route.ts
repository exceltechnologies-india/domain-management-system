import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import DomainWatch from "@/models/DomainWatch";

export const dynamic = "force-dynamic";

// GET /api/user/domains/watch — list watched domains for the current user
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const watches = await DomainWatch.find({ userId: user._id })
      .select("domainName lastCheckedAt lastStatus notifiedAt createdAt")
      .sort({ createdAt: -1 })
      .lean();

    return secureJsonResponse({ watches });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

// POST /api/user/domains/watch — add a domain to watch list
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const body = await request.json();
    const domainName = typeof body.domainName === "string" ? body.domainName.trim().toLowerCase() : "";

    if (!domainName || domainName.length < 3 || domainName.length > 253) {
      return secureErrorResponse("Invalid domain name", 400, "INVALID_DOMAIN");
    }

    // Enforce per-user limit to prevent abuse
    const MAX_WATCHES = 20;
    const count = await DomainWatch.countDocuments({ userId: user._id });
    if (count >= MAX_WATCHES) {
      return secureErrorResponse(
        `Watch list limit reached (max ${MAX_WATCHES})`,
        400,
        "WATCH_LIMIT_EXCEEDED"
      );
    }

    const watch = await DomainWatch.findOneAndUpdate(
      { userId: user._id, domainName },
      { userId: user._id, domainName, lastStatus: "unknown" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return secureJsonResponse({ watch }, 201);
  } catch (error: any) {
    if (error.code === 11000) {
      return secureErrorResponse("Domain already in watch list", 409, "ALREADY_WATCHING");
    }
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

// DELETE /api/user/domains/watch — remove a domain from watch list
export async function DELETE(request: NextRequest) {
  try {
    await connectDB();
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domain")?.trim().toLowerCase();

    if (!domainName) {
      return secureErrorResponse("Missing domain parameter", 400, "MISSING_DOMAIN");
    }

    const result = await DomainWatch.deleteOne({ userId: user._id, domainName });
    if (result.deletedCount === 0) {
      return secureErrorResponse("Watch not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({ success: true });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
