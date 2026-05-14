/**
 * Per-request context propagation via AsyncLocalStorage.
 *
 * Anything stored inside a `withRequestContext(...)` callback is visible to
 * every async code path that runs inside it — DB queries, fetch calls, helper
 * modules — without any of them needing to receive the request as an argument.
 *
 * The primary use case is auto-injecting `requestId` into every structured log
 * entry: serverLogger.* reads the current context and includes `requestId` in
 * its JSON output when present, so individual log call sites don't have to
 * pass `{ requestId }` manually.
 *
 * Runtime notes:
 *  - AsyncLocalStorage is a Node.js API. It works in route handlers and
 *    server actions (which run in the Node runtime).
 *  - In the Edge runtime (middleware.ts), `node:async_hooks` is not available;
 *    we guard the import so middleware modules don't fail to load. Inside
 *    middleware, pass `{ requestId }` explicitly as a meta-arg instead (as
 *    middleware.ts already does).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

// One instance per process. Survives across all async operations spawned
// inside `requestContext.run(...)`.
const storage = new AsyncLocalStorage<RequestContext>();

// Publish the storage on globalThis so server-logger.ts can read it WITHOUT
// importing this module — that import would pull `node:async_hooks` into the
// Edge runtime bundle (middleware) and webpack rejects the `node:` scheme
// there. The decoupling keeps middleware's serverLogger import safe.
(globalThis as any).__requestContextStorage = storage;

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCurrentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Run `fn` with `ctx` bound as the current request context. Every async
 * operation started during `fn` inherits the same context until it resolves.
 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Convenience wrapper for App Router route handlers. Reads `x-request-id`
 * from the incoming request (set by middleware) and runs the handler inside
 * a bound context. Use it like:
 *
 *   export const POST = withRequestLogContext(async (request) => {
 *     serverLogger.info("hello"); // automatically carries requestId
 *     ...
 *   });
 */
export function withRequestLogContext<R extends Request, T>(
  handler: (request: R, ...rest: any[]) => Promise<T> | T
) {
  return async (request: R, ...rest: any[]): Promise<T> => {
    const requestId =
      request.headers.get("x-request-id") ?? crypto.randomUUID();
    return storage.run({ requestId }, () => handler(request, ...rest));
  };
}
