import { NextRequest, NextResponse } from "next/server";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { getDNSRecords as rcGetDNSRecords } from "@/lib/integrations/resellerclub";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByDomain, findOrderDomain } from "@/lib/services/orders";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domainName");

    if (!domainName) {
      return NextResponse.json(
        { error: "Domain name is required" },
        { status: 400 }
      );
    }

    // Find the domain in the database (admin can access any domain)
    const order = await findOrderByDomain(domainName);

    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);

    if (!domain || !domain.resellerClubCustomerId) {
      return NextResponse.json(
        { error: "ResellerClub Customer ID not found for this domain" },
        { status: 404 }
      );
    }

    const outcome = await rcGetDNSRecords({
      domainName,
      customerId: domain.resellerClubCustomerId,
    });

    if (outcome.kind === "not_found") {
      return NextResponse.json(
        { error: "Domain not found in ResellerClub" },
        { status: 404 }
      );
    }
    if (outcome.kind === "hard_failure") {
      return NextResponse.json({ error: outcome.reason }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      domainName,
      records: outcome.records,
    });
  } catch (error: unknown) {
    serverLogger.error("Error in admin DNS GET:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const { domainName, recordData } = await request.json();

    if (!domainName || !recordData) {
      return NextResponse.json(
        { error: "Domain name and record data are required" },
        { status: 400 }
      );
    }

    // Find the domain in the database (admin can access any domain)
    const order = await findOrderByDomain(domainName);

    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);

    if (!domain || !domain.resellerClubCustomerId) {
      return NextResponse.json(
        { error: "ResellerClub Customer ID not found for this domain" },
        { status: 404 }
      );
    }

    // Add DNS record
    const result = await ResellerClubWrapper.addDNSRecord(
      domainName,
      domain.resellerClubCustomerId,
      recordData
    );

    if (result.status === "success") {
      return NextResponse.json({
        success: true,
        message: "DNS record added successfully",
        recordId:
          (result.data as { recordid?: string; recordId?: string } | undefined)?.recordid ||
          (result.data as { recordid?: string; recordId?: string } | undefined)?.recordId,
      });
    }
    return NextResponse.json(
      { error: result.message || "Failed to add DNS record" },
      { status: 500 }
    );
  } catch (error: unknown) {
    serverLogger.error("Error in admin DNS POST:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domainName");
    const recordId = searchParams.get("recordId");

    if (!domainName || !recordId) {
      return NextResponse.json(
        { error: "Domain name and record ID are required" },
        { status: 400 }
      );
    }

    // Get record data from request body
    const { recordData } = await request.json().catch(() => ({}));

    if (!recordData) {
      return NextResponse.json(
        { error: "Record data is required for deletion" },
        { status: 400 }
      );
    }

    // Find the domain in the database (admin can access any domain)
    const order = await findOrderByDomain(domainName);

    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);

    if (!domain || !domain.resellerClubCustomerId) {
      return NextResponse.json(
        { error: "ResellerClub Customer ID not found for this domain" },
        { status: 404 }
      );
    }

    // Delete DNS record
    const result = await ResellerClubWrapper.deleteDNSRecord(
      domainName,
      recordId,
      recordData
    );

    if (result.status === "success") {
      return NextResponse.json({
        success: true,
        message: "DNS record deleted successfully",
      });
    }
    return NextResponse.json(
      { error: result.message || "Failed to delete DNS record" },
      { status: 500 }
    );
  } catch (error: unknown) {
    serverLogger.error("Error in admin DNS DELETE:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
