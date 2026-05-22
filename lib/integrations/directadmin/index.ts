/**
 * Barrel re-exports for the DirectAdmin anti-corruption layer.
 * See ./types.ts for the design rationale (rescan-4 M1 slice 2).
 */
export { createUser } from "./create-user";
export type { CreateUserInput } from "./create-user";
export { suspendUser } from "./suspend-user";
export type { SuspendUserInput } from "./suspend-user";
export { unsuspendUser } from "./unsuspend-user";
export type { UnsuspendUserInput } from "./unsuspend-user";
export type {
  CreateUserOutcome,
  SuspendUserOutcome,
  UnsuspendUserOutcome,
} from "./types";
export {
  classifyCreateUserError,
  classifySuspendUserError,
  classifyUnsuspendUserError,
  USERNAME_COLLISION_FRAGMENTS,
  USER_NOT_FOUND_FRAGMENTS,
  matchesAny,
} from "./classify";
export type {
  SingleCreateUserAttempt,
  SingleSuspendUserAttempt,
  SingleUnsuspendUserAttempt,
} from "./classify";
