import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByDomain, findOrderDomain } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

  const { domainName, method, nameservers } = await request.json();

  if (!domainName || !method) {
    return NextResponse.json({ error: "Domain name and method are required" }, { status: 400 });
  }

  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
  if (!domainRegex.test(domainName)) {
    return NextResponse.json({ error: "Invalid domain name format" }, { status: 400 });
  }

    // Admin can access any order
    const order = await findOrderByDomain(domainName);
    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);
    if (!domain) {
      return NextResponse.json({ error: "Domain not found in order" }, { status: 404 });
    }

    if (!domain.resellerClubOrderId) {
      return NextResponse.json({ error: "Domain does not have a ResellerClub Order ID" }, { status: 400 });
    }

    let apiResult;
    if (method === "default") {
      apiResult = await ResellerClubWrapper.setDefaultNameservers(domain.resellerClubOrderId);
    } else if (method === "custom") {
      if (!Array.isArray(nameservers) || nameservers.length < 2) {
        return NextResponse.json({ error: "At least two nameservers are required" }, { status: 400 });
      }
      const normalized = (nameservers as unknown[])
        .map((ns) => String(ns).toLowerCase().trim())
        .filter((ns: string) => ns.length > 0);
      if (normalized.length < 2) {
        return NextResponse.json({ error: "At least two nameservers are required" }, { status: 400 });
      }
      const nsRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      for (const ns of normalized) {
        if (!nsRegex.test(ns)) {
          return NextResponse.json({ error: "Invalid nameserver format" }, { status: 400 });
        }
      }
      apiResult = await ResellerClubWrapper.setCustomNameservers(domain.resellerClubOrderId, normalized);
    } else {
      return NextResponse.json({ error: "Invalid method" }, { status: 400 });
    }

    if (apiResult.status === "success") {
      return NextResponse.json({ success: true, message: "Nameservers updated successfully" });
    }

    return NextResponse.json({ error: apiResult.message || "Failed to update nameservers" }, { status: 500 });
  } catch (error) {
    serverLogger.error("Admin nameservers update error:", error);
    return NextResponse.json({ error: "Failed to update nameservers" }, { status: 500 });
  }
}