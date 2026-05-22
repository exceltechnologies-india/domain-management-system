/**
 * Typed wrapper around the DirectAdmin createUser flow. Iterates a list
 * of candidate usernames so the username-collision retry that used to
 * be inline in `provisioner-hosting.ts` is now this wrapper's
 * responsibility — caller gets a single typed outcome.
 *
 * Classification rules live in `./classify.ts` (pure, unit-testable).
 * This file is the orchestration: try candidate, look at the thrown
 * shape via DirectAdminError, branch.
 */
import { DirectAdminService, DirectAdminError, DA_SERVER_IP } from "@/lib/directadmin";
import { serverLogger } from "@/lib/server-logger";
import { classifyCreateUserError } from "./classify";
import type { CreateUserOutcome } from "./types";

export interface CreateUserInput {
  email: string;
  domain: string;
  packageName: string;
  /** Defaults to DA_SERVER_IP from `lib/directadmin/client.ts`. */
  ip?: string;
  /** Candidate usernames to try in order. The wrapper retries on
   *  "already exists" collisions and returns the first success. If all
   *  candidates collide, returns `username_collision_exhausted`. */
  usernameCandidates: readonly string[];
}

export async function createUser(input: CreateUserInput): Promise<CreateUserOutcome> {
  const { email, domain, packageName, usernameCandidates } = input;
  const ip = input.ip ?? DA_SERVER_IP;

  if (usernameCandidates.length === 0) {
    return { kind: "hard_failure", reason: "no username candidates provided" };
  }

  for (let i = 0; i < usernameCandidates.length; i++) {
    const username = usernameCandidates[i];
    try {
      await DirectAdminService.createUser(username, email, domain, packageName, ip);
      return { kind: "created", username };
    } catch (err) {
      const status = err instanceof DirectAdminError ? err.status : undefined;
      const message = err instanceof Error ? err.message : String(err);
      const single = classifyCreateUserError(message, status);

      if (single.kind === "collision") {
        if (i < usernameCandidates.length - 1) {
          serverLogger.warn(
            `[DA] createUser username collision on "${username}", trying next candidate (${i + 1}/${usernameCandidates.length})`
          );
          continue;
        }
        serverLogger.warn(
          `[DA] createUser exhausted all ${usernameCandidates.length} candidates with collisions`
        );
        return { kind: "username_collision_exhausted" };
      }

      if (single.kind === "unreachable") {
        serverLogger.error(`[DA] createUser unreachable: ${single.reason}`);
        return { kind: "da_unreachable", reason: single.reason };
      }

      serverLogger.error(`[DA] createUser hard_failure: ${single.reason}`);
      return { kind: "hard_failure", reason: single.reason };
    }
  }

  // Should be unreachable — the loop either returns inside or continues.
  return { kind: "hard_failure", reason: "unexpected fallthrough in createUser" };
}
