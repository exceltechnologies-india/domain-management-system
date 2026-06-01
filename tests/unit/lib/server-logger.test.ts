/**
 * Tests for `@/lib/server-logger` (rescan-4 slice 7ee).
 * The structured-logging facade that Cloud Logging auto-parses. Pins:
 *  - Production (NODE_ENV='production'): emits **a single JSON line per
 *    call** with severity + message + time. Severity strings match the
 *    LogSeverity enum (INFO/WARNING/ERROR/DEBUG) — Google Cloud Logging
 *    colour-codes by these values, so any deviation breaks dashboards
 *  - Dev: human-readable `[SEVERITY] ...args` form with native object
 *    rendering (we DON'T pre-stringify so terminal stack traces stay
 *    readable)
 *  - **Path sanitization**: process.cwd() occurrences in messages are
 *    replaced with `<PROJECT_ROOT>` (defence vs leaking internal paths
 *    in Stack Overflow-pasted error logs)
 *  - Error args: message goes into `message` field, stack + errorName
 *    into meta — preserves stack visibility while keeping JSON valid
 *  - Plain object args MERGED into meta, NOT serialised into message
 *    (a `{requestId, orderId}` arg lands as top-level JSON fields so
 *    Cloud Logging filters can query them directly)
 *  - Unserializable objects (circular refs) → `[unserializable object]`
 *    placeholder; the call never throws
 *  - Ambient requestId from globalThis.__requestContextStorage.getStore()
 *    is merged into meta when the call args don't supply their own
 *  - **error() ALSO fires remoteLog** (fire-and-forget POST to
 *    /api/v1/admin/log-error with x-cron-secret header + 2s AbortSignal)
 *  - remoteLog NO-OPs when NEXTAUTH_URL + APP_URL both unset
 *  - remoteLog never crashes — top-level catch swallows any failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

import { serverLogger } from "@/lib/server-logger";

beforeEach(() => {
  fetchMock.mockReset();
  consoleLog.mockClear();
  consoleWarn.mockClear();
  consoleError.mockClear();
  consoleDebug.mockClear();
  consoleInfo.mockClear();
  vi.stubEnv("NEXTAUTH_URL", "https://app.test.example");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  delete (globalThis as Record<string, unknown>).__requestContextStorage;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dev output (NODE_ENV != production)", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "test"));

  it("info/log → console.info with [INFO] prefix + raw args (no pre-stringify)", () => {
    serverLogger.info("hello", { orderId: "o1" });
    expect(consoleInfo).toHaveBeenCalledWith("[INFO]", "hello", {
      orderId: "o1",
    });
  });

  it("warn → console.warn with [WARNING] prefix", () => {
    serverLogger.warn("careful");
    expect(consoleWarn).toHaveBeenCalledWith("[WARNING]", "careful");
  });

  it("error → console.error with [ERROR] prefix", () => {
    serverLogger.error("boom");
    expect(consoleError).toHaveBeenCalledWith("[ERROR]", "boom");
  });

  it("debug → console.debug with [DEBUG] prefix", () => {
    serverLogger.debug("trace");
    expect(consoleDebug).toHaveBeenCalledWith("[DEBUG]", "trace");
  });
});

describe("production output (NODE_ENV=production)", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  it("emits ONE JSON line per call with severity + message + time", () => {
    serverLogger.info("payment captured");
    const [payload] = consoleLog.mock.calls[0];
    const parsed = JSON.parse(payload);
    expect(parsed.severity).toBe("INFO");
    expect(parsed.message).toBe("payment captured");
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("severity routes to the right console method (INFO→log, WARNING→warn, ERROR→error)", () => {
    serverLogger.info("i");
    serverLogger.warn("w");
    serverLogger.error("e");
    expect(consoleLog).toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("severity enum strings exactly match LogSeverity (INFO/WARNING/ERROR/DEBUG)", () => {
    serverLogger.info("i");
    serverLogger.warn("w");
    serverLogger.error("e");
    serverLogger.debug("d");
    expect(JSON.parse(consoleLog.mock.calls[0][0]).severity).toBe("INFO");
    expect(JSON.parse(consoleWarn.mock.calls[0][0]).severity).toBe("WARNING");
    expect(JSON.parse(consoleError.mock.calls[0][0]).severity).toBe("ERROR");
    expect(JSON.parse(consoleLog.mock.calls[1][0]).severity).toBe("DEBUG");
  });

  it("plain object args MERGE into top-level JSON, not into message", () => {
    serverLogger.info("captured", { orderId: "ord_1", amount: 5000 });
    const parsed = JSON.parse(consoleLog.mock.calls[0][0]);
    expect(parsed.message).toBe("captured");
    expect(parsed.orderId).toBe("ord_1");
    expect(parsed.amount).toBe(5000);
  });

  it("Error args: message → message field, errorName + stack → meta", () => {
    const err = new Error("network down");
    serverLogger.error(err);
    const parsed = JSON.parse(consoleError.mock.calls[0][0]);
    expect(parsed.message).toBe("network down");
    expect(parsed.errorName).toBe("Error");
    expect(parsed.stack).toBeDefined();
  });

  it("path sanitization: process.cwd() in the message is replaced with <PROJECT_ROOT>", () => {
    const cwd = process.cwd();
    serverLogger.info(`failure in ${cwd}/lib/auth.ts`);
    const parsed = JSON.parse(consoleLog.mock.calls[0][0]);
    expect(parsed.message).toContain("<PROJECT_ROOT>");
    expect(parsed.message).not.toContain(cwd);
  });

  it("unserializable object args → `[unserializable object]` in message (no throw)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serverLogger.info("payload", circular)).not.toThrow();
    const parsed = JSON.parse(consoleLog.mock.calls[0][0]);
    expect(parsed.message).toContain("[unserializable object]");
  });

  it("ambient requestId from globalThis.__requestContextStorage is merged into meta", () => {
    (globalThis as Record<string, unknown>).__requestContextStorage = {
      getStore: () => ({ requestId: "req_ABC" }),
    };
    serverLogger.info("hello");
    const parsed = JSON.parse(consoleLog.mock.calls[0][0]);
    expect(parsed.requestId).toBe("req_ABC");
  });

  it("explicit requestId arg WINS over ambient (call-site override)", () => {
    (globalThis as Record<string, unknown>).__requestContextStorage = {
      getStore: () => ({ requestId: "req_AMBIENT" }),
    };
    serverLogger.info("hello", { requestId: "req_EXPLICIT" });
    const parsed = JSON.parse(consoleLog.mock.calls[0][0]);
    expect(parsed.requestId).toBe("req_EXPLICIT");
  });

  it("ambient-storage throw is swallowed — never crashes a request", () => {
    (globalThis as Record<string, unknown>).__requestContextStorage = {
      getStore: () => {
        throw new Error("storage broken");
      },
    };
    expect(() => serverLogger.info("hello")).not.toThrow();
  });
});

describe("remoteLog (error-only fire-and-forget POST)", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  it("error() fires a POST to /api/v1/admin/log-error with x-cron-secret + 2s AbortSignal", () => {
    serverLogger.error("boom", { orderId: "ord_42" });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.test.example/api/v1/admin/log-error");
    expect(init.method).toBe("POST");
    expect(init.headers["x-cron-secret"]).toBe("test-cron-secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.signal).toBeDefined();
  });

  it("remoteLog body includes message + source + metadata (orderId merged in)", () => {
    serverLogger.error("boom", { orderId: "ord_42", service: "billing" });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.message).toContain("boom");
    expect(body.source).toBe("Server Logger");
    expect(body.service).toBe("billing");
    expect(body.metadata).toMatchObject({ orderId: "ord_42", service: "billing" });
  });

  it("info/warn/debug do NOT fire remoteLog (error-only escalation)", () => {
    serverLogger.info("i");
    serverLogger.warn("w");
    serverLogger.debug("d");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remoteLog NO-OPs when neither NEXTAUTH_URL nor APP_URL is set", () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("APP_URL", "");
    serverLogger.error("boom");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("APP_URL works as a fallback when NEXTAUTH_URL is unset", () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("APP_URL", "https://app2.test.example");
    serverLogger.error("boom");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app2.test.example/api/v1/admin/log-error");
  });

  it("fetch throw is silently swallowed — error() never crashes the caller", () => {
    fetchMock.mockImplementation(() => {
      throw new Error("fetch unavailable");
    });
    expect(() => serverLogger.error("boom")).not.toThrow();
  });

  it("Error.stack is path-sanitized in the remoteLog body too", () => {
    const err = new Error("network down");
    err.stack = `Error: network down\n    at ${process.cwd()}/lib/auth.ts:42`;
    serverLogger.error(err);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.stack).toContain("<PROJECT_ROOT>");
    expect(body.stack).not.toContain(process.cwd());
  });
});
