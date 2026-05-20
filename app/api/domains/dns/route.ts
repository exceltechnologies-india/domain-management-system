import { NextRequest, NextResponse } from "next/server";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order, { type IOrder } from "@/models/Order";
import { Schemas } from "@/lib/validation";
import { SecurityValidator } from "@/lib/security";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { z } from "zod";
import { findOrderDomain } from "@/lib/services/orders";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 1 - Authorization
     */
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { searchParams } = new URL(request.url);
    const domainNameRaw = searchParams.get("domainName");

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Input Validation
     * Strictly validates the domain name format.
     */
    const domainResult = Schemas.domainName.safeParse(domainNameRaw);
    if (!domainResult.success) {
      return secureErrorResponse("Invalid domain name", 400, "VALIDATION_ERROR");
    }
    const domainName = domainResult.data;

    await connectDB();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Resource Ownership (Broken Access Control Prevention)
     * Verifies that the requested domain actually belongs to the authenticated user.
     * defense: prevents IDOR (Insecure Direct Object Reference) attacks.
     */
    const order = await Order.findOne({
      "domains.domainName": domainName,
      userId: user._id,
    });

    if (!order) {
      return secureErrorResponse("Domain not found or unauthorized", 404, "NOT_FOUND");
    }

    const domain = findOrderDomain(order, domainName);

    if (!domain || !domain.resellerClubCustomerId) {
      return secureErrorResponse("Domain configuration missing", 404, "NOT_FOUND");
    }

    // 4. Get DNS records
    const result = await ResellerClubWrapper.getDNSRecords(
      domainName,
      domain.resellerClubCustomerId
    );

    if (result.status === "error") {
      const statusCode = result.message?.includes("404") ? 404 : 500;
      return secureErrorResponse(result.message || "Failed to fetch DNS records", statusCode, "PROVISIONER_ERROR");
    }

    return secureJsonResponse({
      success: true,
      domainName,
      records: result.data?.records || [],
    });
  } catch (error) {
    return secureErrorResponse("DNS records fetch error", 500, "SERVER_ERROR", error);
  }
}

export async function POST(request: NextRequest) {
  try {
    // 1. CSRF and Auth
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      return secureErrorResponse(csrfCheck.error || "CSRF Validation Failed", 403, "CSRF_ERROR");
    }

    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = await request.json();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Schema Validation
     * Strictly validates the domain name and the DNS record object.
     */
    const requestSchema = z.object({
      domainName: Schemas.domainName,
      recordData: Schemas.dnsRecord,
    });

    const result = requestSchema.safeParse(body);
    if (!result.success) {
      return secureErrorResponse("Invalid DNS data", 400, "VALIDATION_ERROR", result.error.format());
    }

    const { domainName, recordData } = result.data;

    await connectDB();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Resource Ownership
     * Validates that the user has the right to modify the specified domain.
     */
    const order = await Order.findOne({
      "domains.domainName": domainName,
      userId: user._id,
    });

    if (!order) {
      return secureErrorResponse("Domain not found", 404, "NOT_FOUND");
    }

    const domain = findOrderDomain(order, domainName);
    if (!domain || !domain.resellerClubCustomerId) {
      return secureErrorResponse("DNS management not active", 404, "NOT_FOUND");
    }

    // 4. Operation
    const provisionResult = await ResellerClubWrapper.addDNSRecord(
      domainName,
      domain.resellerClubCustomerId,
      recordData
    );

    if (provisionResult.status === "error") {
      return secureErrorResponse(provisionResult.message || "Failed to add record", 500, "PROVISIONER_ERROR");
    }

    return secureJsonResponse({
      message: "DNS record added successfully",
      recordId: provisionResult.data?.recordid,
    });
  } catch (error) {
    return secureErrorResponse("DNS update failed", 500, "SERVER_ERROR", error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    // 1. CSRF and Auth
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      return secureErrorResponse(csrfCheck.error || "CSRF Validation Failed", 403, "CSRF_ERROR");
    }

    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const body = await request.json();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Schema Validation
     */
    const updateSchema = z.object({
      domainName: Schemas.domainName,
      recordId: z.string().min(1),
      recordData: Schemas.dnsRecord,
    });

    const result = updateSchema.safeParse(body);
    if (!result.success) {
      return secureErrorResponse("Invalid update data", 400, "VALIDATION_ERROR", result.error.format());
    }

    const { domainName, recordId, recordData } = result.data;

    await connectDB();
    
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Resource Ownership
     */
    const order = await Order.findOne({
      "domains.domainName": domainName,
      userId: user._id,
    });

    if (!order) {
      return secureErrorResponse("Unauthorized modification attempt", 403, "UNAUTHORIZED");
    }

    const provisionResult = await ResellerClubWrapper.updateDNSRecord(
      domainName,
      recordId,
      recordData
    );

    if (provisionResult.status === "error") {
      return secureErrorResponse(provisionResult.message || "Update failed", 500, "PROVISIONER_ERROR");
    }

    return secureJsonResponse({ message: "DNS record updated successfully" });
  } catch (error) {
    return secureErrorResponse("DNS update error", 500, "SERVER_ERROR", error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // 1. CSRF and Auth
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      return secureErrorResponse(csrfCheck.error || "CSRF Validation Failed", 403, "CSRF_ERROR");
    }

    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domainName");
    const recordId = searchParams.get("recordId");
    
    const body = await request.json();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Schema Validation
     */
    const deleteSchema = z.object({
      domainName: Schemas.domainName,
      recordId: z.string().min(1),
      recordData: Schemas.dnsRecord, // RC often needs full record info to delete
    });

    const result = deleteSchema.safeParse({ domainName, recordId, ...body });
    if (!result.success) {
      return secureErrorResponse("Invalid delete request", 400, "VALIDATION_ERROR", result.error.format());
    }

    await connectDB();
    
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Resource Ownership
     */
    const order = await Order.findOne({
      "domains.domainName": result.data.domainName,
      userId: user._id,
    });

    if (!order) {
      return secureErrorResponse("Unauthorized deletion attempt", 403, "UNAUTHORIZED");
    }

    const provisionResult = await ResellerClubWrapper.deleteDNSRecord(
      result.data.domainName,
      result.data.recordId,
      result.data.recordData
    );

    if (provisionResult.status === "error") {
      return secureErrorResponse(provisionResult.message || "Delete failed", 500, "PROVISIONER_ERROR");
    }

    return secureJsonResponse({ message: "DNS record deleted successfully" });
  } catch (error) {
    return secureErrorResponse("DNS deletion error", 500, "SERVER_ERROR", error);
  }
}
