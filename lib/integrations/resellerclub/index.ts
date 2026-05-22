/**
 * Barrel re-exports for the ResellerClub anti-corruption layer.
 * See ./types.ts for the design rationale (rescan-4 M1).
 */
export { registerDomain } from "./register-domain";
export type { RegisterDomainInput } from "./register-domain";
export { renewDomain } from "./renew-domain";
export type { RenewDomainInput } from "./renew-domain";
export { transferDomain } from "./transfer-domain";
export type { TransferDomainInput } from "./transfer-domain";
export {
  classifyRegisterDomainResponse,
  classifyRenewDomainResponse,
  classifyTransferDomainResponse,
  matchesAny,
  BALANCE_PENDING_FRAGMENTS,
  PROCESSING_LOCK_FRAGMENTS,
  ALREADY_IN_PROGRESS_FRAGMENTS,
  TRANSFER_REJECTED_FRAGMENTS,
} from "./classify";
export type {
  RegisterDomainOutcome,
  RenewDomainOutcome,
  TransferDomainOutcome,
} from "./types";
