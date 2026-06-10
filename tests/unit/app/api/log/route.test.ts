/**
 * Tests for `app/api/log/route.ts` (slice 7gp, part 1). Public,
 * unauthenticated endpoint that forwards client-side logs to the
 * server-side logger. Anyone on the internet can POST here.
 *
 * Threat model:
 *  - **Log-flooding / abuse**: the schema bounds (message ≤ 8000,
 *    url ≤ 2000, timestamp ≤ 50) prevent one POST from filling
 *    the log pipeline with a megabyte-sized blob
 *  - **Log-injection** is unavoidable for free-text but the
 *    serverLogger sanitises downstream; we just ensure the level
 *    enum is whitelisted so a malicious caller can't trigger an
 *    unexpected logger code path
 *  - **Logging loops**: a client-side error logger sees an error
 *    response from /api/log, panics, logs that → infinite loop.
 *    Defence: this route **swallows** outer-catch errors silently
 *    (200 success:false rather than a verbose 500 with stack)
 *
 * Pins:
 *  - zod schema: level enum {info,warn,error} OPTIONAL; message
 *    REQUIRED with max 8000 chars; details unknown (raw passthrough
 *    to logger); url max 2000; timestamp max 50
 *  - Oversize message → 400 VALIDATION_ERROR
 *  - Level dispatch: 'error' → serverLogger.error, 'warn' → warn,
 *    'info' OR undefined → info (default)
 *  - Invalid level value → 400
 *  - Log line includes timestamp + url + message (interpolation
 *    contract — front-end greps for this prefix)
 *  - Outer catch: 500 with `{success:false}`, NO error message
 *    (anti-loop). Body schema for client safety: success:false only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const info = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info, warn, error },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/log/route";

function makeReq(body: unknown, contentType = "application/json") {
  return new NextRequest("https://example.com/api/log", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": contentType },
  });
}

beforeEach(() => {
  info.mockReset();
  warn.mockReset();
  error.mockReset();
});

// ─── Body validation ─────────────────────────────────────────────
describe("Body validation (anti-abuse size bounds)", () => {
  it("missing message → 400 VALIDATION_ERROR; NO logger call", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("message > 8000 chars → 400 (anti-DoS via giant log writes)", async () => {
    const res = await POST(
      makeReq({ message: "x".repeat(8001) })
    );
    expect(res.status).toBe(400);
    expect(info).not.toHaveBeenCalled();
  });

  it("url > 2000 chars → 400", async () => {
    const res = await POST(
      makeReq({ message: "hi", url: "x".repeat(2001) })
    );
    expect(res.status).toBe(400);
  });

  it("timestamp > 50 chars → 400", async () => {
    const res = await POST(
      makeReq({ message: "hi", timestamp: "x".repeat(51) })
    );
    expect(res.status).toBe(400);
  });

  it("invalid level value → 400 (not in enum)", async () => {
    const res = await POST(
      makeReq({ message: "hi", level: "fatal" })
    );
    expect(res.status).toBe(400);
  });

  it("malformed JSON → 400 INVALID_JSON", async () => {
    const res = await POST(makeReq("not-json"));
    expect(res.status).toBe(400);
  });
});

// ─── Level dispatch ──────────────────────────────────────────────
describe("Level dispatch", () => {
  it("level='error' → serverLogger.error", async () => {
    await POST(
      makeReq({
        message: "boom",
        level: "error",
        url: "/page",
        timestamp: "2026-06-10T00:00Z",
      })
    );
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("level='warn' → serverLogger.warn", async () => {
    await POST(makeReq({ message: "soft", level: "warn" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("level='info' → serverLogger.info", async () => {
    await POST(makeReq({ message: "hi", level: "info" }));
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("level omitted → DEFAULT to serverLogger.info", async () => {
    await POST(makeReq({ message: "no-level" }));
    expect(info).toHaveBeenCalledTimes(1);
  });
});

// ─── Log-line interpolation contract ─────────────────────────────
describe("Log-line interpolation contract", () => {
  it("includes [Client] prefix + timestamp + url + message in order", async () => {
    await POST(
      makeReq({
        message: "kaboom",
        level: "error",
        url: "/checkout",
        timestamp: "2026-06-10T12:00:00Z",
      })
    );
    const logMsg = error.mock.calls[0][0] as string;
    expect(logMsg).toBe(
      "[Client] [2026-06-10T12:00:00Z] [/checkout] kaboom"
    );
  });

  it("details passed through as second arg to logger (raw shape)", async () => {
    const details = {
      stack: "Error: ...\n  at someFunc",
      requestId: "abc",
    };
    await POST(
      makeReq({ message: "with details", level: "error", details })
    );
    expect(error).toHaveBeenCalledWith(expect.any(String), details);
  });

  it("details omitted → second arg is empty string (NOT undefined)", async () => {
    await POST(makeReq({ message: "no details", level: "info" }));
    expect(info).toHaveBeenCalledWith(expect.any(String), "");
  });
});

// ─── Outer catch (anti-logging-loop) ─────────────────────────────
describe("Outer catch — anti-logging-loop", () => {
  it("serverLogger throw → 500 with `{success:false}` ONLY (no error message — prevents client log-then-error loops)", async () => {
    info.mockImplementationOnce(() => {
      throw new Error("logger blew up");
    });
    const res = await POST(makeReq({ message: "hi", level: "info" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ success: false });
    expect(body).not.toHaveProperty("error");
    expect(body).not.toHaveProperty("message");
  });
});

// ─── Happy path response shape ──────────────────────────────────
describe("Happy path response shape", () => {
  it("returns { success: true }", async () => {
    const res = await POST(makeReq({ message: "ok" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
  });
});
