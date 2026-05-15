/**
 * Backwards-compatible barrel for the security-header utilities.
 *
 * The implementation lives in [lib/security/headers.ts](./security/headers).
 * This barrel preserves the historical
 * `import { addSecurityHeaders, addCorsHeaders, buildPreflightResponse } from "@/lib/security-headers"`
 * surface so existing call sites (middleware, api-response-wrapper, route
 * handlers) don't have to change. New code should import directly from
 * `@/lib/security/headers` if it prefers the explicit path.
 */
export {
  addSecurityHeaders,
  addCorsHeaders,
  buildPreflightResponse,
} from "./security/headers";
