/**
 * Tests for `@/lib/directadmin/types` (rescan-4 slice 7dm).
 * Pure type-narrowing helpers + the unwrapDAError function. Pins:
 *  - unwrapDAError unwraps AxiosError → {status, data, code, message}
 *  - Generic Error → {message} only (no status/data/code)
 *  - String / non-Error → coerced into {message}
 */
import { describe, it, expect } from "vitest";
import { AxiosError, type AxiosResponse } from "axios";
import {
  unwrapDAError,
  type DAErrorPayload,
} from "@/lib/directadmin/types";

describe("unwrapDAError", () => {
  it("AxiosError with response → extracts status, data, code, message", () => {
    const ax = new AxiosError("Request failed");
    ax.code = "ERR_BAD_RESPONSE";
    ax.response = {
      status: 503,
      statusText: "Service Unavailable",
      headers: {},
      config: {} as never,
      data: { error: "1", text: "backend offline" },
    } as AxiosResponse<DAErrorPayload>;

    const result = unwrapDAError(ax);
    expect(result.status).toBe(503);
    expect(result.code).toBe("ERR_BAD_RESPONSE");
    expect(result.message).toBe("Request failed");
    expect(result.data).toEqual({ error: "1", text: "backend offline" });
  });

  it("AxiosError WITHOUT response (network failure) → status+data undefined, code+message kept", () => {
    const ax = new AxiosError("connect ETIMEDOUT");
    ax.code = "ETIMEDOUT";
    const result = unwrapDAError(ax);
    expect(result.status).toBeUndefined();
    expect(result.data).toBeUndefined();
    expect(result.code).toBe("ETIMEDOUT");
    expect(result.message).toBe("connect ETIMEDOUT");
  });

  it("AxiosError with string body → data is the raw string (HTML auth-bounce case)", () => {
    const ax = new AxiosError("HTML response");
    ax.response = {
      status: 200,
      statusText: "OK",
      headers: {},
      config: {} as never,
      data: "<html>...login...</html>",
    } as AxiosResponse<string>;
    const result = unwrapDAError(ax);
    expect(result.data).toBe("<html>...login...</html>");
  });

  it("Generic Error → only the message is extracted", () => {
    const result = unwrapDAError(new Error("plain failure"));
    expect(result.message).toBe("plain failure");
    expect(result.status).toBeUndefined();
    expect(result.data).toBeUndefined();
    expect(result.code).toBeUndefined();
  });

  it("Non-Error string → coerced into {message}", () => {
    const result = unwrapDAError("a plain string");
    expect(result.message).toBe("a plain string");
  });

  it("Non-Error object → String() coerced", () => {
    const result = unwrapDAError({ weird: "object" });
    expect(typeof result.message).toBe("string");
    expect(result.message).toContain("[object Object]");
  });

  it("null/undefined → coerced", () => {
    expect(unwrapDAError(null).message).toBe("null");
    expect(unwrapDAError(undefined).message).toBe("undefined");
  });
});
