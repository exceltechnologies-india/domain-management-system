/**
 * Typed wrapper around the DirectAdmin unsuspendUser flow. Mirror of
 * suspend-user.ts — same four-way outcome with different verbs.
 *
 * Caller semantics differ from suspendUser: in the renewal flow we
 * already collected money from the customer, so user_not_found / any
 * failure shouldn't roll back the payment. Callers typically log + still
 * mark the Hosting row active in the DB. The background reconciliation
 * cron pushes the state to DA later when it comes back.
 */
import { DirectAdminService, DirectAdminError } from "@/lib/directadmin";
import { serverLogger } from "@/lib/server-logger";
import { classifyUnsuspendUserError } from "./classify";
import type { UnsuspendUserOutcome } from "./types";

export interface UnsuspendUserInput {
  username: string;
}

export async function unsuspendUser(
  input: UnsuspendUserInput
): Promise<UnsuspendUserOutcome> {
  try {
    await DirectAdminService.unsuspendUser(input.username);
    return { kind: "unsuspended" };
  } catch (err) {
    const status = err instanceof DirectAdminError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const single = classifyUnsuspendUserError(message, status);

    if (single.kind === "user_not_found") {
      serverLogger.error(
        `[DA] unsuspendUser user_not_found for "${input.username}": ${single.reason} (renewal collected payment but DA doesn't know this account — investigate)`
      );
      return { kind: "user_not_found", reason: single.reason };
    }
    if (single.kind === "unreachable") {
      serverLogger.warn(
        `[DA] unsuspendUser unreachable for "${input.username}": ${single.reason}`
      );
      return { kind: "da_unreachable", reason: single.reason };
    }
    serverLogger.error(
      `[DA] unsuspendUser hard_failure for "${input.username}": ${single.reason}`
    );
    return { kind: "hard_failure", reason: single.reason };
  }
}
