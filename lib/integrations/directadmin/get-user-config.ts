/**
 * Typed wrapper around DA's CMD_API_SHOW_USER_CONFIG read op. The
 * existing `DirectAdminService.getUserConfig` throws on every error,
 * forcing every caller to wrap in try/catch and guess whether the
 * failure is transient (DA blip — retry) or terminal (user genuinely
 * gone — mark the Hosting row orphaned).
 *
 * The typed outcome makes that split a switch on `kind`.
 */
import { DirectAdminService, DirectAdminError } from "@/lib/directadmin";
import { serverLogger } from "@/lib/server-logger";
import { classifyGetUserConfigError } from "./classify";
import type { GetUserConfigOutcome } from "./types";

export interface GetUserConfigInput {
  username: string;
}

export async function getUserConfig(
  input: GetUserConfigInput
): Promise<GetUserConfigOutcome> {
  try {
    const config = await DirectAdminService.getUserConfig(input.username);
    return { kind: "found", config };
  } catch (err) {
    const status = err instanceof DirectAdminError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const single = classifyGetUserConfigError(message, status);

    if (single.kind === "user_not_found") {
      serverLogger.warn(
        `[DA] getUserConfig user_not_found for "${input.username}": ${single.reason}`
      );
      return { kind: "user_not_found", reason: single.reason };
    }
    if (single.kind === "unreachable") {
      serverLogger.warn(
        `[DA] getUserConfig unreachable for "${input.username}": ${single.reason}`
      );
      return { kind: "da_unreachable", reason: single.reason };
    }
    serverLogger.error(
      `[DA] getUserConfig hard_failure for "${input.username}": ${single.reason}`
    );
    return { kind: "hard_failure", reason: single.reason };
  }
}
