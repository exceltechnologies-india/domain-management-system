/**
 * Typed wrapper around RC's `getDomainOrderId` lookup. Same shape as
 * the other read-ops — caller switches on `outcome.kind` and never
 * touches the raw `ResellerClubResponse`.
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { classifyGetDomainOrderIdResponse } from "./classify";
import type { GetDomainOrderIdOutcome } from "./types";

export interface GetDomainOrderIdInput {
  domainName: string;
}

export async function getDomainOrderId(
  input: GetDomainOrderIdInput
): Promise<GetDomainOrderIdOutcome> {
  const res = await ResellerClubWrapper.getDomainOrderId(input.domainName);
  const outcome = classifyGetDomainOrderIdResponse(res);

  if (outcome.kind === "not_found") {
    serverLogger.info(
      `[RC] getDomainOrderId not_found for "${input.domainName}": ${outcome.reason}`
    );
  } else if (outcome.kind === "hard_failure") {
    serverLogger.error(
      `[RC] getDomainOrderId hard_failure for "${input.domainName}": ${outcome.reason}`
    );
  }
  return outcome;
}
