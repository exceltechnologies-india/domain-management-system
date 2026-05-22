/**
 * Typed wrapper around `ResellerClubWrapper.transferDomain`. Maps the
 * raw RC response (and any thrown exception) onto the typed
 * `TransferDomainOutcome` union.
 *
 * Distinguishes registry-rejection (bad EPP code, transfer-lock, the
 * 60-day post-registration window) from generic hard failures so the
 * caller can surface a clearer message than "transfer failed".
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import type { TransferDomainOutcome } from "./types";
import {
  classifyTransferDomainResponse,
  matchesAny,
  BALANCE_PENDING_FRAGMENTS,
  TRANSFER_REJECTED_FRAGMENTS,
} from "./classify";

export interface TransferDomainInput {
  domainName: string;
  authCode: string;
  customerId: number;
  contacts?: {
    admin: number;
    tech: number;
    billing: number;
  };
}

export async function transferDomain(
  input: TransferDomainInput
): Promise<TransferDomainOutcome> {
  try {
    const raw = await ResellerClubWrapper.transferDomain(
      input.domainName,
      input.authCode,
      input.customerId,
      input.contacts
    );
    const outcome = classifyTransferDomainResponse(raw);
    if (outcome.kind === "transfer_rejected") {
      serverLogger.warn(
        `[RC] transferDomain rejected for ${input.domainName}: ${outcome.reason}`
      );
    } else if (outcome.kind === "hard_failure") {
      serverLogger.error(
        `[RC] transferDomain hard_failure for ${input.domainName}: ${outcome.reason}`
      );
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(
      `[RC] transferDomain threw for ${input.domainName}: ${message}`
    );
    if (matchesAny(message, BALANCE_PENDING_FRAGMENTS)) {
      return { kind: "balance_pending" };
    }
    if (matchesAny(message, TRANSFER_REJECTED_FRAGMENTS)) {
      return { kind: "transfer_rejected", reason: message };
    }
    return { kind: "hard_failure", reason: message };
  }
}
