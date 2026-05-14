import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { promisify } from "util";
import dns from "dns";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import Domain from "@/models/Domain";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const domainName = searchParams.get("domainName");
  
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!domainName) {
      return NextResponse.json(
        { error: "Domain name is required" },
        { status: 400 }
      );
    }

    // Validate domain name format
    const domainRegex =
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
    if (!domainRegex.test(domainName)) {
      return NextResponse.json(
        { error: "Invalid domain name format" },
        { status: 400 }
      );
    }

    if (!domainRegex.test(domainName)) {
      return NextResponse.json(
        { error: "Invalid domain name format" },
        { status: 400 }
      );
    }

    let nameservers: string[] = [];
    let whoisData: any = {};
    let method = "unknown";

    // Method 1: Try ResellerClub API first (Most accurate for account data)
    try {
      const apiNameservers = await ResellerClubWrapper.getNameservers(domainName);
      
      if (apiNameservers && apiNameservers.length > 0) {
        nameservers = apiNameservers;
        method = "api";
        
        // We can also try to get whois data from API if needed, but for now we'll skip it 
        // or set basic data since we have the nameservers which is the main goal
        whoisData = {
          registrar: "Anutech Digital",
          status: "Active", // Assumption since we got data
        };
      }
    } catch (apiError) {
      // API lookup failed, suppress error
    }

    // Method 2: Try RDAP (Registration Data Access Protocol) if API failed
    if (nameservers.length === 0) {
      try {

        // Extract TLD from domain
        const tld = domainName.split(".").slice(-2).join(".");

        // Try RDAP bootstrap service first
        let rdapData = null;
        let rdapServer = "";

        try {
          // Try IANA RDAP bootstrap
          const bootstrapResponse = await fetch(
            `https://data.iana.org/rdap/dns.json`,
            {
              headers: {
                Accept: "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; DomainManager/1.0)",
              },
            }
          );

          if (bootstrapResponse.ok) {
            const bootstrapData = await bootstrapResponse.json();

            // Find RDAP server for this TLD
            const tldEntry = bootstrapData.services?.find((service: any) =>
              service[0]?.some(
                (pattern: string) =>
                  pattern === tld ||
                  pattern === `*.${tld}` ||
                  domainName.endsWith(pattern)
              )
            );

            if (tldEntry && tldEntry[1]?.length > 0) {
              const rdapUrl = tldEntry[1][0];

              const rdapResponse = await fetch(
                `${rdapUrl}/domain/${domainName}`,
                {
                  headers: {
                    Accept: "application/rdap+json",
                    "User-Agent": "Mozilla/5.0 (compatible; DomainManager/1.0)",
                  },
                }
              );

              if (rdapResponse.ok) {
                rdapData = await rdapResponse.json();
                rdapServer = rdapUrl;
              }
            }
          }
        } catch (bootstrapError) {
          // Bootstrap failed, ignore
        }

        // Fallback to direct RDAP servers if bootstrap fails
        if (!rdapData) {
          const directServers = [
            `https://rdap.verisign.com/domain/${domainName}`,
            `https://rdap.arin.net/registry/domain/${domainName}`,
            `https://rdap.afilias.net/rdap/domain/${domainName}`,
            `https://rdap.nic.in/domain/${domainName}`,
            `https://rdap.registry.in/domain/${domainName}`,
          ];

          for (const server of directServers) {
            try {
              const rdapResponse = await fetch(server, {
                headers: {
                  Accept: "application/rdap+json",
                  "User-Agent": "Mozilla/5.0 (compatible; DomainManager/1.0)",
                },
              });

              if (rdapResponse.ok) {
                rdapData = await rdapResponse.json();
                rdapServer = server;
                break;
              }

            } catch (serverError) {
              continue;
            }
          }
        }

        if (rdapData) {
          method = "rdap";

          // Extract nameservers from RDAP data
          if (rdapData.nameservers && Array.isArray(rdapData.nameservers)) {
            nameservers = rdapData.nameservers
              .map((ns: any) => {
                if (typeof ns === "string") return ns;
                if (ns.ldhName) return ns.ldhName;
                if (ns.name) return ns.name;
                return ns;
              })
              .filter((ns: string) => ns && ns.includes(".") && ns.length > 3);
          }

          // Extract additional domain information from RDAP
          whoisData = {
            registrar:
              rdapData.registrar?.name || rdapData.registrar?.value || "Unknown",
            creationDate:
              rdapData.events?.find((e: any) => e.eventAction === "registration")
                ?.eventDate || null,
            expirationDate:
              rdapData.events?.find((e: any) => e.eventAction === "expiration")
                ?.eventDate || null,
            lastUpdated:
              rdapData.events?.find((e: any) => e.eventAction === "last changed")
                ?.eventDate || null,
            status: rdapData.status?.join(", ") || "Unknown",
          };


        } else {
          throw new Error("No RDAP server responded successfully");
        }
      } catch (rdapError) {

        // Method 3: Try DNS lookup as fallback
        try {
          const resolveNs = promisify(dns.resolveNs);
          const nsRecords = await resolveNs(domainName);

          if (nsRecords && nsRecords.length > 0) {
            nameservers = nsRecords;
            method = "dns";
          }

          whoisData = {
            registrar: "Unknown",
            creationDate: null,
            expirationDate: null,
            lastUpdated: null,
            status: "Unknown",
          };
        } catch (dnsError) {
          serverLogger.error(`❌ [DNS] Also failed: ${(dnsError as any).message}`);

          // All lookup methods failed - throw error
          throw new Error(
            `Unable to retrieve nameserver information for ${domainName}. All lookups failed.`
          );
        }
      }
    }

    // Clean up nameservers
    nameservers = Array.from(new Set(nameservers))
      .map((ns) => ns.toLowerCase().trim())
      .filter((ns) => {
        return (
          ns.length > 0 &&
          ns.includes(".") &&
          !ns.includes(" ") &&
          /^[a-zA-Z0-9.-]+$/.test(ns) &&
          !ns.includes("name")
        );
      });



    // Determine if using default or custom nameservers
    // Default nameservers typically contain patterns like:
    // - dns1.registrar-servers.com, dns2.registrar-servers.com (common default)
    // - ns1.example-registrar.com, ns2.example-registrar.com
    // Custom nameservers are anything else (cloudflare, route53, etc.)
    const defaultPatterns = [
      'registrar-servers.com',
      'orderbox-dns.com',
      'resellerclub.com',
      'publicdomainregistry.com'
    ];
    
    const isDefaultNameserver = nameservers.some(ns => 
      defaultPatterns.some(pattern => ns.includes(pattern))
    );
    
    const nameserverMethod = isDefaultNameserver ? 'default' : 'custom';

    return NextResponse.json({
      success: true,
      domainName,
      nameservers,
      count: nameservers.length,
      method: nameserverMethod,
      whoisData,
      lastChecked: new Date().toISOString(),
    });
  } catch (error: any) {
    serverLogger.error("Nameserver lookup error:", error);

    // Check if it's a nameserver lookup failure
    if (
      error.message &&
      error.message.includes("Unable to retrieve nameserver information")
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Nameserver lookup failed",
          message: error.message,
          domainName: domainName,
          nameservers: [],
          count: 0,
          lastChecked: new Date().toISOString(),
        },
        { status: 404 }
      );
    }

    // Generic server error
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        message: error.message || "An unexpected error occurred",
        domainName: domainName,
        nameservers: [],
        count: 0,
        lastChecked: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { domainName, method, nameservers } = await request.json();

    if (!domainName || !method) {
      return NextResponse.json({ error: "Domain name and method are required" }, { status: 400 });
    }

    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
    if (!domainRegex.test(domainName)) {
      return NextResponse.json({ error: "Invalid domain name format" }, { status: 400 });
    }

    await connectDB();

    const order = await Order.findOne({ "domains.domainName": domainName, userId: user._id, isDeleted: { $ne: true } });
    if (!order) {
      return NextResponse.json({ error: "Domain not found for this user" }, { status: 404 });
    }

    const domain = order.domains.find((d: any) => d.domainName === domainName);
    if (!domain) {
      return NextResponse.json({ error: "Domain not found in order" }, { status: 404 });
    }

    if (!domain.resellerClubOrderId) {
      return NextResponse.json({ error: "Registrar order reference not found for this domain. Please contact support." }, { status: 404 });
    }

    const orderId = domain.resellerClubOrderId;

    let apiResult;
    if (method === "default") {
      apiResult = await ResellerClubWrapper.setDefaultNameservers(orderId);
    } else if (method === "custom") {
      if (!Array.isArray(nameservers) || nameservers.length < 2) {
        return NextResponse.json({ error: "At least two nameservers are required" }, { status: 400 });
      }
      const normalized = nameservers
        .map((ns) => String(ns).toLowerCase().trim())
        .filter((ns) => ns.length > 0);
      if (normalized.length < 2) {
        return NextResponse.json({ error: "At least two nameservers are required" }, { status: 400 });
      }
      const nsRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      for (const ns of normalized) {
        if (!nsRegex.test(ns)) {
          return NextResponse.json({ error: "Invalid nameserver format" }, { status: 400 });
        }
      }
      const resolve4 = promisify(dns.resolve4);
      for (const ns of normalized) {
        try {
          await resolve4(ns);
        } catch (e) {
          return NextResponse.json({ error: `Nameserver does not resolve: ${ns}` }, { status: 400 });
        }
      }
      apiResult = await ResellerClubWrapper.setCustomNameservers(orderId, normalized);
    } else {
      return NextResponse.json({ error: "Invalid method" }, { status: 400 });
    }

    if (apiResult.status !== "success") {
      return NextResponse.json({ error: apiResult.message || "Failed to update nameservers" }, { status: 502 });
    }

    // Persist the effective nameservers to the Domain record so DB stays in sync with the registrar
    const effectiveNameservers =
      method === "default"
        ? ["ns1.registrar-servers.com", "ns2.registrar-servers.com"]
        : nameservers.map((ns: string) => String(ns).toLowerCase().trim());

    try {
      await Domain.updateOne(
        { domainName, deletedAt: null },
        { $set: { nameservers: effectiveNameservers } }
      );
    } catch (dbErr) {
      // Non-fatal: log but don't fail — registrar update already succeeded
      serverLogger.error(`[nameservers] Failed to persist nameservers to DB for ${domainName}:`, dbErr);
    }

    return NextResponse.json({ success: true, message: "Nameservers updated successfully", nameservers: effectiveNameservers });
  } catch (error) {
    return NextResponse.json({ error: "Failed to update nameservers" }, { status: 500 });
  }
}
