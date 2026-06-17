/**
 * Tests for `@/lib/logger` (rescan-4 slice 7dn).
 * Client-side secure logger. Pins:
 *  - Development: log/error/warn/info/debug write to the corresponding
 *    console.* method.
 *  - Production: console.* is NOT called.
 *  - error + warn push to the /api/v1/log endpoint via sendBeacon when
 *    available (else fetch).
 *  - sendBeacon payload contains the level + a joined `message` string
 *    + the sanitized structured array under `details` (the server schema
 *    at app/api/log/route.ts requires `message: string` and accepts
 *    optional `details: unknown`).
 *  - Error objects are serialised to {message, stack, name}.
 *  - Circular objects are replaced with '[Circular Object]'.
 *  - log/info/debug do NOT call sendBeacon/fetch (server-side noise).
 *
 * The logger reads `process.env.NODE_ENV` at module-load (top-level
 * const), so each scenario re-imports via vi.resetModules + stubEnv.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let sendBeaconMock: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let consoleSpies: Record<string, ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  vi.resetModules();
  // Default: jsdom provides `window` + `navigator`. Stub sendBeacon onto
  // navigator + fetch globally.
  sendBeaconMock = vi.fn().mockReturnValue(true);
  fetchMock = vi.fn().mockResolvedValue({});
  Object.defineProperty(navigator, "sendBeacon", {
    value: sendBeaconMock,
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("fetch", fetchMock);
  consoleSpies = {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
  };
});

afterEach(() => {
  for (const spy of Object.values(consoleSpies)) spy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("logger (development)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
  });

  it("log writes to console.log", async () => {
    const { logger } = await import("@/lib/logger");
    logger.log("hello", 42);
    expect(consoleSpies.log).toHaveBeenCalledWith("hello", 42);
  });

  it("error / warn / info / debug each write to the matching console method", async () => {
    const { logger } = await import("@/lib/logger");
    logger.error("e");
    logger.warn("w");
    logger.info("i");
    logger.debug("d");
    expect(consoleSpies.error).toHaveBeenCalledWith("e");
    expect(consoleSpies.warn).toHaveBeenCalledWith("w");
    expect(consoleSpies.info).toHaveBeenCalledWith("i");
    expect(consoleSpies.debug).toHaveBeenCalledWith("d");
  });
});

describe("logger (production)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
  });

  it("does NOT write to console.log / info / debug in production", async () => {
    const { logger } = await import("@/lib/logger");
    logger.log("x");
    logger.info("x");
    logger.debug("x");
    expect(consoleSpies.log).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.debug).not.toHaveBeenCalled();
  });
});

describe("logger server forwarding (error + warn)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
  });

  it("error → navigator.sendBeacon called with /api/v1/log + the level+message+details payload", async () => {
    const { logger } = await import("@/lib/logger");
    logger.error("boom", { id: 1 });
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeaconMock.mock.calls[0];
    expect(url).toBe("/api/v1/log");
    expect(blob).toBeInstanceOf(Blob);
    const text = await (blob as Blob).text();
    const parsed = JSON.parse(text);
    expect(parsed.level).toBe("error");
    // `message` is the joined string (server schema requires `string`).
    expect(typeof parsed.message).toBe("string");
    expect(parsed.message).toContain("boom");
    expect(parsed.message).toContain('{"id":1}');
    // `details` is the original structured array (for server-side context).
    expect(parsed.details).toEqual(["boom", { id: 1 }]);
  });

  it("warn → sendBeacon called with level='warn'", async () => {
    const { logger } = await import("@/lib/logger");
    logger.warn("careful");
    const blob = sendBeaconMock.mock.calls[0][1] as Blob;
    const parsed = JSON.parse(await blob.text());
    expect(parsed.level).toBe("warn");
    expect(parsed.message).toBe("careful");
    expect(parsed.details).toEqual(["careful"]);
  });

  it("log / info / debug do NOT call sendBeacon (avoid noise)", async () => {
    const { logger } = await import("@/lib/logger");
    logger.log("x");
    logger.info("x");
    logger.debug("x");
    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  it("Error instances are serialised to {message, stack, name}", async () => {
    const { logger } = await import("@/lib/logger");
    const err = new Error("oops");
    logger.error(err);
    const blob = sendBeaconMock.mock.calls[0][1] as Blob;
    const parsed = JSON.parse(await blob.text());
    expect(parsed.details[0]).toMatchObject({
      message: "oops",
      name: "Error",
    });
    expect(parsed.details[0].stack).toBeTypeOf("string");
  });

  it("Circular objects are replaced with '[Circular Object]'", async () => {
    const { logger } = await import("@/lib/logger");
    const a: { self?: unknown; name: string } = { name: "loop" };
    a.self = a;
    logger.error(a);
    const blob = sendBeaconMock.mock.calls[0][1] as Blob;
    const parsed = JSON.parse(await blob.text());
    expect(parsed.details[0]).toBe("[Circular Object]");
  });

  it("falls back to fetch when sendBeacon is unavailable", async () => {
    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const { logger } = await import("@/lib/logger");
    logger.error("via-fetch");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/log",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
      })
    );
  });
});
