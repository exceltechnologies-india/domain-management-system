/**
 * Barrel re-exports for the ResellerClub anti-corruption layer.
 * See ./types.ts for the design rationale (rescan-4 M1).
 */
export { registerDomain } from "./register-domain";
export type { RegisterDomainInput } from "./register-domain";
export { classifyRegisterDomainResponse } from "./classify";
export type { RegisterDomainOutcome } from "./types";
