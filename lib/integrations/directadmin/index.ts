/**
 * Barrel re-exports for the DirectAdmin anti-corruption layer.
 * See ./types.ts for the design rationale (rescan-4 M1 slice 2).
 */
export { createUser } from "./create-user";
export type { CreateUserInput } from "./create-user";
export { suspendUser } from "./suspend-user";
export type { SuspendUserInput } from "./suspend-user";
export type { CreateUserOutcome, SuspendUserOutcome } from "./types";
export {
  classifyCreateUserError,
  classifySuspendUserError,
  USERNAME_COLLISION_FRAGMENTS,
  USER_NOT_FOUND_FRAGMENTS,
  matchesAny,
} from "./classify";
export type {
  SingleCreateUserAttempt,
  SingleSuspendUserAttempt,
} from "./classify";
