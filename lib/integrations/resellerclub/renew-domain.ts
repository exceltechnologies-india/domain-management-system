/**
 * Typed wrapper around `ResellerClubWrapper.renewDomain`. Maps the
 * raw RC response (including exceptions) onto `RenewDomainOutcome` so
 * callers `switch` instead of inspecting `result.status` /
 * `result.message`.
 *
 * The underlying wrapper does an order-id + expiry pre-flight lookup
 * inside; if either of those returns `{status:"error"}` the wrapper
 * surfaces that as a normal error response. We classify it as
 * `hard_failure` here — callers shouldn't have to distinguish "lookup
 * failed" from "registry rejected" (both are unfixable from the
 * caller's POV).
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import type { RenewDomainOutcome } from "./types";
import {
  classifyRenewDomainResponse,
  matchesAny,
  BALANCE_PENDING_FRAGMENTS,
} from "./classify";

export interface RenewDomainInput {
  domainName: string;
  /** 1-10 (RC's hard cap). */
  years: number;
}

export async function renewDomain(input: RenewDomainInput): Promise<RenewDomainOutcome> {
  try {
    const raw = await ResellerClubWrapper.renewDomain(input.domainName, input.years);
    const outcome = classifyRenewDomainResponse(raw);
    if (outcome.kind === "hard_failure") {
      serverLogger.error(
        `[RC] renewDomain hard_failure for ${input.domainName}: ${outcome.reason}`
      );
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(`[RC] renewDomain threw for ${input.domainName}: ${message}`);
    if (matchesAny(message, BALANCE_PENDING_FRAGMENTS)) {
      return { kind: "balance_pending" };
    }
    return { kind: "hard_failure", reason: message };
  }
}
