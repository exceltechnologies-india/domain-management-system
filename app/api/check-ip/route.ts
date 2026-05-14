import { NextRequest, NextResponse } from "next/server";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // Check IP using multiple services for reliability
    const ipServices = [
      "https://api.ipify.org",
      "https://ipinfo.io/ip",
      "https://api.ipify.org?format=json",
      "https://httpbin.org/ip",
    ];

    const results: any = {
      timestamp: new Date().toISOString(),
      services: {},
      primaryIP: null,
      allIPs: [],
      serverInfo: {
        userAgent: request.headers.get("user-agent"),
        host: request.headers.get("host"),
        forwarded: request.headers.get("x-forwarded-for"),
        realIP: request.headers.get("x-real-ip"),
      },
    };

    // Try each service
    for (const service of ipServices) {
      try {
        const response = await fetch(service, {
          method: "GET",
          headers: {
            "User-Agent": "Domain-Management-System/1.0",
          },
        });

        if (response.ok) {
          const data = await response.text();
          let ip = data.trim();

          // Handle JSON responses
          if (service.includes("format=json") || service.includes("httpbin")) {
            try {
              const jsonData = JSON.parse(data);
              ip = jsonData.ip || jsonData.origin || data;
            } catch (e) {
              // Keep as text if JSON parsing fails
            }
          }

          results.services[service] = {
            status: "success",
            ip: ip,
            responseTime: response.headers.get("x-response-time") || "unknown",
          };

          if (!results.primaryIP) {
            results.primaryIP = ip;
          }

          if (!results.allIPs.includes(ip)) {
            results.allIPs.push(ip);
          }
        } else {
          results.services[service] = {
            status: "error",
            error: `HTTP ${response.status}`,
            responseTime: "unknown",
          };
        }
      } catch (error) {
        results.services[service] = {
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
          responseTime: "unknown",
        };
      }
    }

    // Determine the most likely outbound IP
    if (results.allIPs.length > 0) {
      // Use the most common IP if there are multiple
      const ipCounts = results.allIPs.reduce((acc: any, ip: string) => {
        acc[ip] = (acc[ip] || 0) + 1;
        return acc;
      }, {});

      results.primaryIP = Object.keys(ipCounts).reduce((a, b) =>
        ipCounts[a] > ipCounts[b] ? a : b
      );
    }

    // Only log once at the end
    serverLogger.info(`✅ [CHECK-IP] Primary outbound IP: ${results.primaryIP}`);

    return NextResponse.json({
      success: true,
      message: "Outbound IP check completed",
      data: results,
    });
  } catch (error) {
    serverLogger.error("❌ [CHECK-IP] Error checking outbound IP:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Failed to check outbound IP",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
