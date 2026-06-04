/**
 * Tests for `@/lib/zohobooks/types` (rescan-4 slice 7fv).
 * The file is mostly TypeScript type declarations (which tsc verifies),
 * but it exposes one runtime helper: `unwrapZohoError`. Used in every
 * Zoho catch block to pull out the API-error payload regardless of
 * whether the throw was an AxiosError, a plain Error, or a raw thrown
 * value. Pins:
 *  - **AxiosError branch**: extracts response.data + response.status
 *    + err.message verbatim (avoids `(err as any).response?.data`
 *    patterns scattered across ~10 callsites)
 *  - **Non-AxiosError Error branch**: { message: err.message } only;
 *    NO data / status fields (caller's `.data?.code` checks short-
 *    circuit to undefined, taking the generic-fail path)
 *  - **Non-Error throw branch**: { message: String(err) } — string
 *    coercion so the catch always has SOMETHING to log even when the
 *    throw target is `null`, `undefined`, a number, etc.
 *  - **AxiosError with no response** (network error, never reached
 *    server): data + status BOTH undefined; message = err.message
 *    (this is the case we hit when the upstream connection dies
 *    before headers — caller's retry logic uses `!status` to detect)
 *  - **AxiosError response.data passthrough**: returns the data
 *    object verbatim (the typed shape is { code?, message?, [k]: ?
 *    unknown }); caller is responsible for narrowing
 */
import { describe, it, expect } from "vitest";
import { AxiosError } from "axios";
import { unwrapZohoError } from "@/lib/zohobooks/types";

function makeAxiosError(
  status?: number,
  data?: unknown,
  message = "Request failed"
) {
  return new AxiosError(
    message,
    "ERR",
    undefined,
    undefined,
    status !== undefined
      ? ({
          status,
          statusText: "Err",
          data,
          headers: {},
          config: {},
        } as any)
      : undefined
  );
}

describe("unwrapZohoError — AxiosError branch", () => {
  it("extracts response.data + response.status + err.message verbatim", () => {
    const err = makeAxiosError(400, { code: 5, message: "validation failed" });
    const r = unwrapZohoError(err);
    expect(r.data).toEqual({ code: 5, message: "validation failed" });
    expect(r.status).toBe(400);
    expect(r.message).toBe("Request failed");
  });

  it("preserves extra fields on response.data (open index signature)", () => {
    const err = makeAxiosError(400, {
      code: 5,
      message: "bad",
      extra_field: "X",
      nested: { y: 1 },
    });
    const r = unwrapZohoError(err);
    expect((r.data as any).extra_field).toBe("X");
    expect((r.data as any).nested).toEqual({ y: 1 });
  });

  it("non-2xx with empty body → data undefined; status still extracted", () => {
    const err = makeAxiosError(500, undefined);
    const r = unwrapZohoError(err);
    expect(r.data).toBeUndefined();
    expect(r.status).toBe(500);
  });

  it("**AxiosError with NO response (network error)**: data + status BOTH undefined; message extracted", () => {
    const err = makeAxiosError(undefined, undefined, "ECONNRESET");
    const r = unwrapZohoError(err);
    expect(r.data).toBeUndefined();
    expect(r.status).toBeUndefined();
    expect(r.message).toBe("ECONNRESET");
  });
});

describe("unwrapZohoError — non-AxiosError branches", () => {
  it("plain Error: { message: err.message } only (NO data/status fields)", () => {
    const err = new Error("plain failure");
    const r = unwrapZohoError(err);
    expect(r.data).toBeUndefined();
    expect(r.status).toBeUndefined();
    expect(r.message).toBe("plain failure");
  });

  it("non-Error throw (string) → String(err) coercion", () => {
    const r = unwrapZohoError("string-thrown");
    expect(r.message).toBe("string-thrown");
  });

  it("non-Error throw (number) → String(err) = '42'", () => {
    const r = unwrapZohoError(42);
    expect(r.message).toBe("42");
  });

  it("non-Error throw (null) → String(null) = 'null' (NEVER undefined message)", () => {
    const r = unwrapZohoError(null);
    expect(r.message).toBe("null");
  });

  it("non-Error throw (undefined) → 'undefined' string", () => {
    const r = unwrapZohoError(undefined);
    expect(r.message).toBe("undefined");
  });

  it("non-Error throw (object without message) → '[object Object]' fallback", () => {
    const r = unwrapZohoError({ foo: "bar" });
    expect(r.message).toBe("[object Object]");
  });

  it("custom Error subclass: { message } extracted via Error branch", () => {
    class MyErr extends Error {
      constructor() {
        super("custom");
      }
    }
    const r = unwrapZohoError(new MyErr());
    expect(r.message).toBe("custom");
  });
});

describe("unwrapZohoError — retry-logic interop", () => {
  it("network error case: !status returns truthy so retry layer fires", () => {
    const err = makeAxiosError(undefined, undefined, "ETIMEDOUT");
    const r = unwrapZohoError(err);
    // Caller's `!status` check (in idempotentRetry) returns TRUE → retryable
    expect(!r.status).toBe(true);
  });

  it("5xx case: status >= 500 (retryable)", () => {
    const r = unwrapZohoError(makeAxiosError(503, {}));
    expect(r.status).toBe(503);
    expect((r.status ?? 0) >= 500).toBe(true);
  });

  it("4xx validation: status 400 (NOT retryable)", () => {
    const r = unwrapZohoError(makeAxiosError(400, { code: 5 }));
    expect(r.status).toBe(400);
    expect((r.status ?? 0) >= 500).toBe(false);
  });

  it("429 case: caught by status === 429 in retry layer", () => {
    const r = unwrapZohoError(makeAxiosError(429, {}));
    expect(r.status).toBe(429);
  });

  it("plain Error: !status is truthy (no status → retryable)", () => {
    const r = unwrapZohoError(new Error("network"));
    expect(!r.status).toBe(true);
  });
});

describe("unwrapZohoError — subscription/code extraction", () => {
  it("code 103001 surfaces via r.data.code (subscription-expired sentinel)", () => {
    const err = makeAxiosError(403, {
      code: 103001,
      message: "Subscription expired",
    });
    const r = unwrapZohoError(err);
    expect(r.data?.code).toBe(103001);
  });

  it("code 2 + 'gst' in message (GST validation fallback path)", () => {
    const err = makeAxiosError(400, {
      code: 2,
      message: "Invalid GSTIN provided",
    });
    const r = unwrapZohoError(err);
    expect(r.data?.code).toBe(2);
    expect(r.data?.message?.toLowerCase()).toContain("gst");
  });

  it("code 3032 (tax-mismatch fallback path)", () => {
    const err = makeAxiosError(400, { code: 3032, message: "Tax mismatch" });
    expect(unwrapZohoError(err).data?.code).toBe(3032);
  });

  it("code 57 (access-denied probe path)", () => {
    const err = makeAxiosError(401, { code: 57, message: "no scope" });
    expect(unwrapZohoError(err).data?.code).toBe(57);
  });
});
