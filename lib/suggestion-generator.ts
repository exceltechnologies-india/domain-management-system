/**
 * Domain Suggestion Generator
 * 
 * This utility generates alternative domain names based on user input.
 * It uses common prefixes, suffixes, and TLD variations to suggest available options.
 */
import { DomainSearchResult } from "./types";
import { ResellerClubWrapper } from "./resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";

export class SuggestionGenerator {
  /** Lists of common prefixes to prepended to the base domain */
  private static readonly PREFIXES = [
    'get', 'my', 'the', 'go', 'try', 'join', 'use', 'start', 
    'hello', 'official', 'real', 'best', 'top', 'pro'
  ];
  /** Lists of common suffixes to appended to the base domain */
  private static readonly SUFFIXES = [
    'hub', 'app', 'lab', 'web', 'online', 'store', 'shop', 'inc', 'corp', 
    'solutions', 'digital', 'tech', 'studio', 'base', 'cloud', 'ify', 'ly'
  ];
  /** Common TLDs to check for the base domain */
  private static readonly COMMON_TLDS = [
    'com', 'net', 'org', 'co', 'me', 'io', 'biz', 'info', 
    'ai', 'app', 'dev', 'tech', 'online', 'site'
  ];

  /**
   * Generate available domain suggestions for a base domain name
   * @param baseDomain The base domain name (e.g., "mybrand")
   * @returns Array of available domain search results with categories
   */
  static async generateSuggestions(baseDomain: string): Promise<DomainSearchResult[]> {
    const candidates: string[] = [];
    
    // 1. TLD Variations (other common TLDs for the same name)
    this.COMMON_TLDS.forEach(tld => {
      candidates.push(`${baseDomain}.${tld}`);
    });

    // 2. Prefix additions
    this.PREFIXES.forEach(prefix => {
      candidates.push(`${prefix}${baseDomain}.com`);
    });

    // 3. Suffix additions
    this.SUFFIXES.forEach(suffix => {
      candidates.push(`${baseDomain}${suffix}.com`);
    });

    // 4. Mix TLDs for some brandable versions
    const premiumSuffixes = ['io', 'ai', 'dev', 'tech'];
    premiumSuffixes.forEach(tld => {
        candidates.push(`${baseDomain}app.${tld}`);
        candidates.push(`${baseDomain}hub.${tld}`);
    });

    // 5. Unique and shuffle
    const uniqueCandidates = Array.from(new Set(candidates))
      .sort(() => 0.5 - Math.random())
      .slice(0, 15);

    try {
      // Group by base domain to use searchDomainWithTlds where possible
      const byBaseDomain: { [base: string]: string[] } = {};
      uniqueCandidates.forEach(domain => {
          const parts = domain.split('.');
          const base = parts[0];
          const tld = parts.slice(1).join('.');
          if (!byBaseDomain[base]) byBaseDomain[base] = [];
          byBaseDomain[base].push(tld);
      });

      const results: DomainSearchResult[] = [];
      const checkPromises = Object.entries(byBaseDomain).map(async ([base, tlds]) => {
          try {
              const res = await ResellerClubWrapper.searchDomainWithTlds(base, tlds);
              return res.filter(r => r.available).map(r => {
                  // Add categorization and "original price" for UI enhancements
                  const tld = r.domainName.split('.').pop() || '';
                  let category = 'All';
                  if (['com', 'net', 'in', 'co.in', 'org'].includes(tld)) category = 'Popular';
                  else if (['tech', 'ai', 'dev', 'io', 'digital'].includes(tld)) category = 'Tech';
                  else if (['biz', 'solutions', 'inc', 'corp', 'solutions'].includes(tld)) category = 'Business';

                  return {
                      ...r,
                      category,
                      originalPrice: r.price ? Math.round(r.price * 1.5) : undefined
                  };
              });
          } catch (e) {
              return [];
          }
      });

      const resolvedBatches = await Promise.all(checkPromises);
      resolvedBatches.forEach(batch => results.push(...batch));

      // Limit final results to 20 to support categorization tabs
      return results.slice(0, 20);
    } catch (error) {
      serverLogger.error("Suggestion generation failed:", error);
      return [];
    }
  }
}
