/**
 * Typed wrapper around DA's deleteUser. Same shape as suspend /
 * unsuspend / getUserConfig — the meaningful distinction is the
 * `user_not_found` outcome, which cleanup callsites typically coalesce
 * with success (intent was deletion; end state matches).
 */
import { DirectAdminService, DirectAdminError } from "@/lib/directadmin";
import { serverLogger } from "@/lib/server-logger";
import { classifyDeleteUserError } from "./classify";
import type { DeleteUserOutcome } from "./types";

export interface DeleteUserInput {
  username: string;
}

export async function deleteUser(input: DeleteUserInput): Promise<DeleteUserOutcome> {
  try {
    await DirectAdminService.deleteUser(input.username);
    return { kind: "deleted" };
  } catch (err) {
    const status = err instanceof DirectAdminError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const single = classifyDeleteUserError(message, status);

    if (single.kind === "user_not_found") {
      serverLogger.info(
        `[DA] deleteUser user_not_found for "${input.username}" — already gone, treating as success at callsite: ${single.reason}`
      );
      return { kind: "user_not_found", reason: single.reason };
    }
    if (single.kind === "unreachable") {
      serverLogger.warn(
        `[DA] deleteUser unreachable for "${input.username}": ${single.reason}`
      );
      return { kind: "da_unreachable", reason: single.reason };
    }
    serverLogger.error(
      `[DA] deleteUser hard_failure for "${input.username}": ${single.reason}`
    );
    return { kind: "hard_failure", reason: single.reason };
  }
}
