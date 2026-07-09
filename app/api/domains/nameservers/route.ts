import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { promisify } from "util";
import dns from "dns";
import Domain from "@/models/Domain";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByDomainForUser, findOrderDomain } from "@/lib/services/orders";
import { validatedBody, z } from "@/lib/api-validation";

const domainNameRegex =
  /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
const nameserverRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const nameserversPostSchema = z
  .object({
    domainName: z.string().trim().regex(domainNameRegex, "Invalid domain name format"),
    method: z.enum(["default", "custom"]),
    nameservers: z
      .array(z.string().trim().toLowerCase().regex(nameserverRegex, "Invalid nameserver format"))
      .min(2, "At least two nameservers are required")
      .optional(),
  })
  .refine(
    (d) =>
      d.method === "default" || (d.nameservers !== undefined && d.nameservers.length >= 2),
    {
      message: "At least two nameservers are required for custom method",
      path: ["nameservers"],
    }
  );

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

// Placeholder / invalid nameserver values that some registrars leave on a
// domain that has never had real nameservers assigned (e.g. sgweb.biz was
// delegated to 127.0.0.1 — "private name servers, no query sent"). These are
// NOT usable nameservers and must be treated as "unset" so the UI nudges the
// customer to Apply Defaults instead of showing a scary error.
const PLACEHOLDER_NS = new Set(["127.0.0.1", "0.0.0.0", "localhost", "::1"]);
const isIpv4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/**
 * Resolve NS records via DNS-over-HTTPS (Google). More reliable from
 * serverless egress than the container's system resolver (`dns.resolveNs`),
 * and it lets us read the delegation state — a `responded:true` with an empty
 * list means "the domain resolves but has no valid public NS" (unset), which
 * we distinguish from a total lookup failure.
 */
async function resolveNsViaDoH(
  domainName: string
): Promise<{ nameservers: string[]; responded: boolean }> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domainName)}&type=NS`,
      { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return { nameservers: [], responded: false };
    const data = (await res.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    const ns = (data.Answer ?? [])
      .filter((a) => a.type === 2 && a.data)
      .map((a) => a.data!.replace(/\.$/, "").toLowerCase());
    return { nameservers: ns, responded: true };
  } catch {
    return { nameservers: [], responded: false };
  }
}

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

    interface WhoisData {
      registrar?: string;
      status?: string;
      creationDate?: string | null;
      expirationDate?: string | null;
      lastUpdated?: string | null;
    }
    let nameservers: string[] = [];
    let whoisData: WhoisData = {};
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
            type IanaService = [string[], string[]];
            const services = bootstrapData.services as IanaService[] | undefined;
            const tldEntry = services?.find((service) =>
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
          interface RdapNameserver { ldhName?: string; name?: string }
          interface RdapEvent { eventAction?: string; eventDate?: string }
          if (rdapData.nameservers && Array.isArray(rdapData.nameservers)) {
            nameservers = (rdapData.nameservers as Array<string | RdapNameserver>)
              .map((ns) => {
                if (typeof ns === "string") return ns;
                if (ns.ldhName) return ns.ldhName;
                if (ns.name) return ns.name;
                return "";
              })
              .filter((ns: string) => ns && ns.includes(".") && ns.length > 3);
          }

          // Extract additional domain information from RDAP
          const events = (rdapData.events ?? []) as RdapEvent[];
          whoisData = {
            registrar:
              rdapData.registrar?.name || rdapData.registrar?.value || "Unknown",
            creationDate:
              events.find((e) => e.eventAction === "registration")?.eventDate || null,
            expirationDate:
              events.find((e) => e.eventAction === "expiration")?.eventDate || null,
            lastUpdated:
              events.find((e) => e.eventAction === "last changed")?.eventDate || null,
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
        } catch (dnsError: unknown) {
          const dnsMessage = dnsError instanceof Error ? dnsError.message : String(dnsError);
          serverLogger.warn(`[DNS] resolveNs failed for ${domainName}: ${dnsMessage} — falling through to DoH`);
          // Do NOT throw here — fall through to the DoH fallback + the
          // "unset vs error" classification below. A domain with a broken
          // delegation (e.g. NS = 127.0.0.1) should guide the user to Apply
          // Defaults, not show a hard error.
        }
      }
    }

    // Method 4: DNS-over-HTTPS fallback (reliable from serverless egress).
    // Runs whenever the earlier methods produced no nameservers. `dohResponded`
    // lets us tell "domain resolves but has no valid NS" (unset) apart from a
    // total lookup failure (error).
    let dohResponded = false;
    if (nameservers.length === 0) {
      const doh = await resolveNsViaDoH(domainName);
      dohResponded = doh.responded;
      if (doh.nameservers.length > 0) {
        nameservers = doh.nameservers;
        method = "doh";
      }
    }

    // Clean up nameservers — also strip placeholder/invalid delegations
    // (127.0.0.1 etc.) and bare IPs, which are not real nameservers.
    nameservers = Array.from(new Set(nameservers))
      .map((ns) => ns.toLowerCase().trim())
      .filter((ns) => {
        return (
          ns.length > 0 &&
          ns.includes(".") &&
          !ns.includes(" ") &&
          /^[a-zA-Z0-9.-]+$/.test(ns) &&
          !ns.includes("name") &&
          !PLACEHOLDER_NS.has(ns) &&
          !isIpv4(ns)
        );
      });

    // No valid nameservers found. Distinguish "domain exists but has no NS
    // set" (unset — guide the user to Apply Defaults) from a genuine lookup
    // failure (error). RDAP data or a DoH response both confirm the domain
    // resolves, so those → unset; nothing responding at all → error.
    if (nameservers.length === 0) {
      const domainConfirmed = Boolean(whoisData.registrar) || dohResponded;
      return NextResponse.json({
        success: true,
        domainName,
        nameservers: [],
        count: 0,
        method: "none",
        nameserverStatus: domainConfirmed ? "unset" : "error",
        whoisData,
        lastChecked: new Date().toISOString(),
      });
    }



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
      nameserverStatus: "ok",
      whoisData,
      lastChecked: new Date().toISOString(),
    });
  } catch (error: unknown) {
    serverLogger.error("Nameserver lookup error:", error);
    const message = error instanceof Error ? error.message : String(error);

    // Check if it's a nameserver lookup failure
    if (message.includes("Unable to retrieve nameserver information")) {
      return NextResponse.json(
        {
          success: false,
          error: "Nameserver lookup failed",
          message,
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
        message: message || "An unexpected error occurred",
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

    const validation = await validatedBody(request, nameserversPostSchema);
    if (!validation.ok) return validation.response;
    const { domainName, method, nameservers } = validation.data;

    const order = await findOrderByDomainForUser(user._id, domainName);
    if (!order) {
      return NextResponse.json({ error: "Domain not found for this user" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);
    if (!domain) {
      return NextResponse.json({ error: "Domain not found in order" }, { status: 404 });
    }

    if (!domain.resellerClubOrderId) {
      return NextResponse.json({ error: "Registrar order reference not found for this domain. Please contact support." }, { status: 404 });
    }

    const orderId = domain.resellerClubOrderId;

    // Shape guaranteed by the Zod refine: method=custom ⇒ ≥2 valid NSs.
    // We still do a live DNS resolution check for custom — the route's
    // historical guarantee is "every nameserver we hand to RC actually
    // resolves at submit time."
    let apiResult;
    if (method === "default") {
      apiResult = await ResellerClubWrapper.setDefaultNameservers(orderId);
    } else {
      const resolve4 = promisify(dns.resolve4);
      for (const ns of nameservers!) {
        try {
          await resolve4(ns);
        } catch (e) {
          return NextResponse.json({ error: `Nameserver does not resolve: ${ns}` }, { status: 400 });
        }
      }
      apiResult = await ResellerClubWrapper.setCustomNameservers(orderId, nameservers!);
    }

    if (apiResult.status !== "success") {
      return NextResponse.json({ error: apiResult.message || "Failed to update nameservers" }, { status: 502 });
    }

    // Persist the effective nameservers to the Domain record so DB stays in sync with the registrar.
    // Zod refine guarantees `nameservers` is defined when method === "custom".
    const effectiveNameservers =
      method === "default"
        ? ["ns1.registrar-servers.com", "ns2.registrar-servers.com"]
        : nameservers!;

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
