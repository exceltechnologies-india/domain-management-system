/**
 * Typed wrapper around the DirectAdmin suspendUser flow. Maps thrown
 * DirectAdminError / generic Error onto the SuspendUserOutcome union
 * so callers (expiry worker, refund webhook, admin actions) can branch
 * on `kind` instead of guessing whether to retry.
 */
import { DirectAdminService, DirectAdminError } from "@/lib/directadmin";
import { serverLogger } from "@/lib/server-logger";
import { classifySuspendUserError } from "./classify";
import type { SuspendUserOutcome } from "./types";

export interface SuspendUserInput {
  username: string;
  /** Reason string surfaced in DA's audit log. Defaults to 'Admin Action'
   *  inside the underlying SDK call. */
  reason?: string;
}

export async function suspendUser(input: SuspendUserInput): Promise<SuspendUserOutcome> {
  try {
    await DirectAdminService.suspendUser(input.username, input.reason);
    return { kind: "suspended" };
  } catch (err) {
    const status = err instanceof DirectAdminError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const single = classifySuspendUserError(message, status);

    if (single.kind === "user_not_found") {
      serverLogger.warn(
        `[DA] suspendUser user_not_found for "${input.username}": ${single.reason}`
      );
      return { kind: "user_not_found", reason: single.reason };
    }
    if (single.kind === "unreachable") {
      serverLogger.error(
        `[DA] suspendUser unreachable for "${input.username}": ${single.reason}`
      );
      return { kind: "da_unreachable", reason: single.reason };
    }
    serverLogger.error(
      `[DA] suspendUser hard_failure for "${input.username}": ${single.reason}`
    );
    return { kind: "hard_failure", reason: single.reason };
  }
}
