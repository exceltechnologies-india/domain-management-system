/**
 * Backwards-compatible barrel for the SecurityValidator class.
 *
 * The implementation lives in [lib/security/validator.ts](./security/validator).
 * This barrel preserves the historical `import { SecurityValidator } from "@/lib/security"`
 * surface so existing call sites (middleware, auth routes, tests) don't have
 * to change. New code should import directly from `@/lib/security/validator`
 * if it prefers the explicit path.
 */
export { SecurityValidator } from "./security/validator";
