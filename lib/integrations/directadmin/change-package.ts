/**
 * Typed wrapper around DA's changePackage (CMD_API_MODIFY_USER with
 * action=package). Same shape as the other user-op wrappers — caller
 * switches on `outcome.kind` and the inner DA throw form is hidden.
 */
import { DirectAdminService, DirectAdminError } from "@/lib/directadmin";
import { serverLogger } from "@/lib/server-logger";
import { classifyChangePackageError } from "./classify";
import type { ChangePackageOutcome } from "./types";

export interface ChangePackageInput {
  username: string;
  newPackage: string;
}

export async function changePackage(input: ChangePackageInput): Promise<ChangePackageOutcome> {
  try {
    await DirectAdminService.changePackage(input.username, input.newPackage);
    return { kind: "changed" };
  } catch (err) {
    const status = err instanceof DirectAdminError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const single = classifyChangePackageError(message, status);

    if (single.kind === "user_not_found") {
      serverLogger.error(
        `[DA] changePackage user_not_found for "${input.username}" → "${input.newPackage}": ${single.reason}`
      );
      return { kind: "user_not_found", reason: single.reason };
    }
    if (single.kind === "package_not_found") {
      serverLogger.error(
        `[DA] changePackage package_not_found for "${input.username}" → "${input.newPackage}": ${single.reason}`
      );
      return { kind: "package_not_found", reason: single.reason };
    }
    if (single.kind === "unreachable") {
      serverLogger.warn(
        `[DA] changePackage unreachable for "${input.username}" → "${input.newPackage}": ${single.reason}`
      );
      return { kind: "da_unreachable", reason: single.reason };
    }
    serverLogger.error(
      `[DA] changePackage hard_failure for "${input.username}" → "${input.newPackage}": ${single.reason}`
    );
    return { kind: "hard_failure", reason: single.reason };
  }
}
