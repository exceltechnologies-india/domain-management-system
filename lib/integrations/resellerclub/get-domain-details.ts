/**
 * Typed wrapper around RC's `getDomainDetails`. Read op — surfaces a
 * `found` / `not_found` / `hard_failure` outcome so the verify-status
 * route and DomainVerificationService can branch without parsing
 * "404"-like substrings out of the message.
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { classifyGetDomainDetailsResponse } from "./classify";
import type { GetDomainDetailsOutcome } from "./types";

export interface GetDomainDetailsInput {
  domainName: string;
}

export async function getDomainDetails(
  input: GetDomainDetailsInput
): Promise<GetDomainDetailsOutcome> {
  const res = await ResellerClubWrapper.getDomainDetails(input.domainName);
  const outcome = classifyGetDomainDetailsResponse(res);

  if (outcome.kind === "not_found") {
    serverLogger.info(
      `[RC] getDomainDetails not_found for "${input.domainName}": ${outcome.reason}`
    );
  } else if (outcome.kind === "hard_failure") {
    serverLogger.error(
      `[RC] getDomainDetails hard_failure for "${input.domainName}": ${outcome.reason}`
    );
  }
  return outcome;
}
