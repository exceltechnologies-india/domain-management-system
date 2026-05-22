/**
 * Typed wrapper around `ResellerClubWrapper.registerDomain` that maps the
 * raw `{status, message, data}` response (and any thrown exception) into
 * the `RegisterDomainOutcome` discriminated union. The classification
 * logic itself lives in `./classify.ts` so it can be unit-tested without
 * pulling in ResellerClubWrapper's env-checked module load.
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import type { RegisterDomainOutcome } from "./types";
import {
  classifyRegisterDomainResponse,
  matchesAny,
  BALANCE_PENDING_FRAGMENTS,
} from "./classify";

export interface RegisterDomainInput {
  domainName: string;
  years: number;
  customerId: number;
  nameServers?: string[];
  contacts?: {
    admin: number;
    tech: number;
    billing: number;
  };
  tldAttributes?: Record<string, string>;
}

/**
 * Register a domain via ResellerClub. Returns a typed outcome — callers
 * switch on `outcome.kind` instead of parsing English. Exceptions are
 * caught here and mapped onto the same outcome union (a thrown
 * insufficient-balance error becomes `balance_pending` just like an
 * RC response would have).
 */
export async function registerDomain(
  input: RegisterDomainInput
): Promise<RegisterDomainOutcome> {
  try {
    const raw = await ResellerClubWrapper.registerDomain(
      input.domainName,
      input.years,
      input.customerId,
      input.nameServers,
      input.contacts,
      input.tldAttributes
    );
    const outcome = classifyRegisterDomainResponse(raw);
    if (outcome.kind === "hard_failure") {
      serverLogger.error(
        `[RC] registerDomain hard_failure for ${input.domainName}: ${outcome.reason}`
      );
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(
      `[RC] registerDomain threw for ${input.domainName}: ${message}`
    );
    // Same heuristic on the exception message — balance errors sometimes
    // surface as a thrown axios error rather than a structured response.
    if (matchesAny(message, BALANCE_PENDING_FRAGMENTS)) {
      return { kind: "balance_pending" };
    }
    return { kind: "hard_failure", reason: message };
  }
}
