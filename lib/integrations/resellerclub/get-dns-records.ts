/**
 * Typed wrapper around RC's `getDNSRecords`. Same shape as the other
 * read-ops — surfaces `found` / `not_found` / `hard_failure` so the
 * dns routes can map RC's "Request failed with status code 404"
 * heuristic onto a real 404 without parsing message strings.
 */
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { classifyGetDNSRecordsResponse } from "./classify";
import type { GetDNSRecordsOutcome } from "./types";

export interface GetDNSRecordsInput {
  domainName: string;
  customerId: string;
}

export async function getDNSRecords(
  input: GetDNSRecordsInput
): Promise<GetDNSRecordsOutcome> {
  const res = await ResellerClubWrapper.getDNSRecords(
    input.domainName,
    input.customerId
  );
  const outcome = classifyGetDNSRecordsResponse(res);

  if (outcome.kind === "not_found") {
    serverLogger.info(
      `[RC] getDNSRecords not_found for "${input.domainName}": ${outcome.reason}`
    );
  } else if (outcome.kind === "hard_failure") {
    serverLogger.error(
      `[RC] getDNSRecords hard_failure for "${input.domainName}": ${outcome.reason}`
    );
  }
  return outcome;
}
