/**
 * Tests for `@/lib/request-context` (rescan-4 slice 7dm).
 * AsyncLocalStorage-backed per-request context. Pins:
 *  - getRequestContext / getCurrentRequestId outside a run scope → undefined
 *  - withRequestContext binds ctx → readable from sync + nested async work
 *  - Context is per-call; concurrent runs don't bleed
 *  - withRequestLogContext extracts x-request-id from the Request and
 *    runs the handler with that requestId; missing header → fresh UUID
 *  - Storage is published on globalThis as __requestContextStorage
 *    (so server-logger can read it without importing this module)
 */
import { describe, it, expect } from "vitest";
import {
  getRequestContext,
  getCurrentRequestId,
  withRequestContext,
  withRequestLogContext,
} from "@/lib/request-context";
import type { AsyncLocalStorage } from "node:async_hooks";

interface StoredCtx {
  requestId: string;
}
type CtxStorage = AsyncLocalStorage<StoredCtx>;

describe("request-context: outside a run scope", () => {
  it("getRequestContext returns undefined when no context is bound", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("getCurrentRequestId returns undefined when no context is bound", () => {
    expect(getCurrentRequestId()).toBeUndefined();
  });
});

describe("withRequestContext", () => {
  it("binds ctx for the synchronous body", () => {
    let observed: ReturnType<typeof getRequestContext>;
    withRequestContext({ requestId: "abc-123" }, () => {
      observed = getRequestContext();
    });
    expect(observed).toEqual({ requestId: "abc-123" });
  });

  it("ctx is visible inside async work spawned during the run", async () => {
    const observed = await withRequestContext({ requestId: "async-xyz" }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      return getCurrentRequestId();
    });
    expect(observed).toBe("async-xyz");
  });

  it("two concurrent runs keep their own ctx (no bleed)", async () => {
    const [a, b] = await Promise.all([
      withRequestContext({ requestId: "ctx-A" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getCurrentRequestId();
      }),
      withRequestContext({ requestId: "ctx-B" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getCurrentRequestId();
      }),
    ]);
    expect(a).toBe("ctx-A");
    expect(b).toBe("ctx-B");
  });

  it("ctx is no longer bound after the run completes", () => {
    withRequestContext({ requestId: "scoped" }, () => {
      // pass
    });
    expect(getRequestContext()).toBeUndefined();
  });
});

describe("withRequestLogContext", () => {
  it("extracts x-request-id from the Request and binds the handler ctx", async () => {
    let observed: string | undefined;
    const wrapped = withRequestLogContext(async () => {
      observed = getCurrentRequestId();
      return "ok";
    });
    const req = new Request("http://localhost/", {
      headers: { "x-request-id": "header-supplied-id" },
    });
    const result = await wrapped(req);
    expect(result).toBe("ok");
    expect(observed).toBe("header-supplied-id");
  });

  it("missing x-request-id header → generates a fresh UUID", async () => {
    let observed: string | undefined;
    const wrapped = withRequestLogContext(async () => {
      observed = getCurrentRequestId();
      return undefined;
    });
    const req = new Request("http://localhost/");
    await wrapped(req);
    // Standard UUID v4 pattern.
    expect(observed).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("forwards extra args (route params, NextResponse args, etc.) to the handler", async () => {
    const handler = vi.fn(async () => undefined);
    const wrapped = withRequestLogContext(handler);
    const req = new Request("http://localhost/");
    const ctx = { params: { id: "42" } };
    await wrapped(req, ctx);
    expect(handler).toHaveBeenCalledWith(req, ctx);
  });
});

describe("globalThis publication", () => {
  it("__requestContextStorage is published so server-logger can read without importing this module", () => {
    const published = (globalThis as unknown as { __requestContextStorage: CtxStorage })
      .__requestContextStorage;
    expect(published).toBeDefined();
    // It's the same AsyncLocalStorage used by getRequestContext.
    withRequestContext({ requestId: "global-test" }, () => {
      expect(published.getStore()).toEqual({ requestId: "global-test" });
    });
  });
});

import { vi } from "vitest";
