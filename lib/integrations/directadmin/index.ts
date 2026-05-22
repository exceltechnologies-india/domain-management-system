/**
 * Barrel re-exports for the DirectAdmin anti-corruption layer.
 * See ./types.ts for the design rationale (rescan-4 M1 slice 2).
 */
export { createUser } from "./create-user";
export type { CreateUserInput } from "./create-user";
export type { CreateUserOutcome } from "./types";
export {
  classifyCreateUserError,
  USERNAME_COLLISION_FRAGMENTS,
  matchesAny,
} from "./classify";
export type { SingleCreateUserAttempt } from "./classify";
