import { NextRequest, NextResponse } from "next/server";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { InputValidator } from "@/lib/validation";

import { isRestrictedTLD } from "@/lib/domainRequirements";
import { DirectAdminService } from "@/lib/directadmin";
import { redisCache } from "@/lib/redis";
import { SuggestionGenerator } from "@/lib/suggestion-generator";
import { rateLimiters } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import type { DomainSearchResult } from "@/lib/types";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  const startTime = Date.now();

  try {
    const rateLimit = await rateLimiters.domainSearch.isAllowed(request);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many search requests. Please slow down.", requestId },
        { status: 429 }
      );
    }

    const { domain, tlds, quick } = await request.json();

    // Basic validation: ensure a domain string is provided
    if (!domain || typeof domain !== "string") {
      return NextResponse.json(
        {
          success: false,
          error: "Domain name is required",
          requestId,
        },
        { status: 400 }
      );
    }

    serverLogger.info(`📝 [API-${requestId}] Received domain search request:`, {
      domain,
      tlds: tlds || "not specified",
      mode: tlds ? "multiple-tld" : "single-domain",
    });

    // Parse domain input to extract base domain and TLD
    const domainParts = domain.split(".");
    const hasTLD = domainParts.length > 1;

    let baseDomain: string;
    let searchTlds: string[];
    let userEnteredDomain: string | null = null;

    if (hasTLD) {
      // User entered a domain with TLD (e.g., "anutech.shop")
      baseDomain = domainParts[0];
      const userTLD = domainParts.slice(1).join("."); // Handle multi-level TLDs like "co.uk"
      userEnteredDomain = `${baseDomain}.${userTLD}`;

      serverLogger.info(`🔍 [API-${requestId}] Domain with TLD detected:`, {
        original: domain,
        baseDomain: baseDomain,
        userTLD: userTLD,
        fullDomain: userEnteredDomain,
      });

      // Check if the TLD is restricted
      if (isRestrictedTLD(userTLD)) {
        serverLogger.info(
          `🚫 [API-${requestId}] Restricted TLD detected: ${userTLD}`
        );
        return NextResponse.json({
          success: false,
          error: "restricted_tld",
          message: `Domain registration for .${userTLD} requires special permissions and additional documentation. Please contact our support team for assistance.`,
          domain: userEnteredDomain,
          tld: userTLD,
          supportContact: process.env.SUPPORT_EMAIL || "support@anutech.in",
          requestId,
        });
      }

      // Search only for the specific TLD the user entered
      searchTlds = [userTLD];
    } else {
      // User entered just a base domain (e.g., "anutech")
      baseDomain = domain;

      // Use provided TLDs or default to .com
      if (tlds && Array.isArray(tlds)) {
        // Frontend sends array of TLDs with dots like ['.com', '.net', '.org']
        searchTlds = tlds.map((tld) => tld.replace(/^\./, "").trim()); // Remove leading dots
        serverLogger.info(`📋 [API-${requestId}] Parsed TLDs from array:`, {
          received: tlds,
          parsed: searchTlds,
        });
      } else if (tlds && typeof tlds === "string") {
        // Handle comma-separated string for backward compatibility
        searchTlds = tlds
          .split(",")
          .map((tld) => tld.replace(/^\./, "").trim());
        serverLogger.info(`📋 [API-${requestId}] Parsed TLDs from string:`, {
          received: tlds,
          parsed: searchTlds,
        });
      } else {
        searchTlds = ["com"]; // Default to .com only
        serverLogger.info(`📋 [API-${requestId}] Using default TLD: com`);
      }

      // Filter out restricted TLDs and warn user
      const restrictedTlds = searchTlds.filter((tld) => isRestrictedTLD(tld));
      const allowedTlds = searchTlds.filter((tld) => !isRestrictedTLD(tld));

      if (restrictedTlds.length > 0) {
        serverLogger.info(
          `🚫 [API-${requestId}] Restricted TLDs detected: ${restrictedTlds.join(
            ", "
          )}`
        );
        // If all TLDs are restricted, return error
        if (allowedTlds.length === 0) {
          return NextResponse.json({
            success: false,
            error: "all_tlds_restricted",
            message: `Domain registration for ${restrictedTlds
              .map((tld) => `.${tld}`)
              .join(
                ", "
              )} requires special permissions and additional documentation. Please contact our support team for assistance.`,
            restrictedTlds: restrictedTlds,
            supportContact: process.env.SUPPORT_EMAIL || "support@anutech.in",
            requestId,
          });
        }
        // If some TLDs are restricted, continue with allowed ones but note the restriction
        searchTlds = allowedTlds;
        serverLogger.info(
          `⚠️ [API-${requestId}] Filtered out restricted TLDs, continuing with: ${allowedTlds.join(
            ", "
          )}`
        );
      }

      serverLogger.info(`🌐 [API-${requestId}] Base domain search:`, {
        baseDomain: baseDomain,
        searchTlds: searchTlds,
        providedTlds: tlds,
        restrictedTlds: restrictedTlds,
      });
    }

    // Validate base domain name. validateDomainName's `sanitized` is always
    // a string (the union with Record<string,string> is for the address
    // validator); narrow it once for the rest of this handler.
    const domainValidationRaw = InputValidator.validateDomainName(baseDomain);
    const domainValidation = {
      ...domainValidationRaw,
      sanitized: typeof domainValidationRaw.sanitized === "string"
        ? domainValidationRaw.sanitized
        : undefined,
    };
    if (!domainValidation.isValid) {
      serverLogger.error(`❌ [API-${requestId}] Domain validation failed:`, {
        domain: baseDomain,
        errors: domainValidation.errors,
        sanitized: domainValidation.sanitized,
      });
      return NextResponse.json(
        {
          success: false,
          error: domainValidation.errors.join(", "),
          requestId,
        },
        { status: 400 }
      );
    }

    serverLogger.info(`🎯 [API-${requestId}] Mode: Production`);

    const tldsKey = searchTlds.sort().join(",");
    const domainCacheKey = `domain:check:${domainValidation.sanitized || baseDomain}:${tldsKey}`;
    const suggestionCacheKey = `domain:suggestions:${domainValidation.sanitized || baseDomain}`;

    const domainToCheck = userEnteredDomain || (hasTLD ? domainValidation.sanitized : null);

    // Quick mode: return only domain availability — skip slow suggestion generation
    // and hosting check. Used by the frontend for fast first-paint of exact results.
    if (quick) {
      const cached = await redisCache.get<DomainSearchResult[]>(domainCacheKey);
      let quickResults: DomainSearchResult[];
      let isResultsCached: boolean;
      if (cached) {
        quickResults = cached;
        isResultsCached = true;
      } else {
        quickResults = await ResellerClubWrapper.searchDomainWithTlds(
          domainValidation.sanitized || baseDomain,
          searchTlds
        );
        if (quickResults && quickResults.length > 0) {
          await redisCache.set(domainCacheKey, quickResults, 600);
        }
        isResultsCached = false;
      }
      serverLogger.info(`⚡ [API-${requestId}] Quick search done in ${Date.now() - startTime}ms`);
      return NextResponse.json({
        success: true,
        results: quickResults || [],
        suggestions: [],
        hostingExists: false,
        requestId,
        responseTime: `${Date.now() - startTime}ms`,
        searchQuery: {
          originalDomain: domain,
          baseDomain: domainValidation.sanitized,
          searchTlds,
          userEnteredDomain,
        },
        cached: { results: isResultsCached, suggestions: false },
      });
    }

    // Run all three independent lookups in parallel to minimise wall-clock latency.
    const [
      { results, isResultsCached },
      { suggestions, isSuggestionsCached },
      hostingExists,
    ] = await Promise.all([
      // 1. Domain availability (ResellerClub, cached 10 min)
      (async () => {
        const cached = await redisCache.get<DomainSearchResult[]>(domainCacheKey);
        if (cached) {
          serverLogger.info(`🚀 [API-${requestId}] Cache hit for domain results.`);
          return { results: cached, isResultsCached: true };
        }
        serverLogger.info(`🌐 [API-${requestId}] Cache miss for domain results. Fetching from ResellerClub.`);
        const fresh = await ResellerClubWrapper.searchDomainWithTlds(
          domainValidation.sanitized || baseDomain,
          searchTlds
        );
        if (fresh && fresh.length > 0) {
          await redisCache.set(domainCacheKey, fresh, 600);
        }
        return { results: fresh, isResultsCached: false };
      })(),

      // 2. Suggestions (ResellerClub, cached 10 min)
      (async () => {
        const cached = await redisCache.get<DomainSearchResult[]>(suggestionCacheKey);
        if (cached) {
          serverLogger.info(`🚀 [API-${requestId}] Cache hit for suggestions.`);
          return { suggestions: cached, isSuggestionsCached: true };
        }
        serverLogger.info(`💡 [API-${requestId}] Cache miss for suggestions. Generating...`);
        try {
          const fresh = await SuggestionGenerator.generateSuggestions(baseDomain);
          if (fresh && fresh.length > 0) {
            await redisCache.set(suggestionCacheKey, fresh, 600);
          }
          return { suggestions: fresh, isSuggestionsCached: false };
        } catch (suggErr) {
          serverLogger.error(`❌ [API-${requestId}] Error generating suggestions:`, suggErr);
          return { suggestions: [] as DomainSearchResult[], isSuggestionsCached: false };
        }
      })(),

      // 3. Hosting existence check (DirectAdmin)
      domainToCheck
        ? (async () => {
            try {
              serverLogger.info(`🔍 [API-${requestId}] Checking hosting existence for: ${domainToCheck}`);
              const exists = await DirectAdminService.domainExists(domainToCheck);
              serverLogger.info(`🔍 [API-${requestId}] Hosting existence check result: ${exists}`);
              return exists;
            } catch (err) {
              serverLogger.error(`⚠️ [API-${requestId}] Failed to check hosting existence:`, err);
              return false;
            }
          })()
        : Promise.resolve(false),
    ]);

    // Store results in localStorage for persistence
    const responseData = {
      success: true,
      results: results || [],
      suggestions: suggestions || [],
      hostingExists,
      requestId,
      responseTime: `${Date.now() - startTime}ms`,
      searchQuery: {
        originalDomain: domain,
        baseDomain: domainValidation.sanitized,
        searchTlds: searchTlds,
        userEnteredDomain: userEnteredDomain,
      },
      cached: {
        results: isResultsCached,
        suggestions: isSuggestionsCached,
      }
    };

    const availableCount = results.filter((r) => r.available).length;
    const livePricingCount = results.filter(
      (r) => r.pricingSource === "live"
    ).length;

    serverLogger.info(
      `✅ [API-${requestId}] Domain search completed in ${
        Date.now() - startTime
      }ms - ${
        results.length
      } domains found, ${availableCount} available, ${livePricingCount} with live pricing`
    );

    return NextResponse.json(responseData);
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(`❌ [API-${requestId}] Domain search failed:`, {
      error: error instanceof Error ? error.message : "Unknown error",
      responseTime: `${responseTime}ms`,
    });

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Domain search failed due to a technical error",
        requestId,
        responseTime: `${responseTime}ms`,
      },
      { status: 500 }
    );
  }
}
