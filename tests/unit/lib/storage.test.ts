/**
 * Tests for `@/lib/storage` (rescan-4 slice 7dp).
 * SafeStorage wraps localStorage/sessionStorage with an in-memory
 * fallback when storage access is blocked (privacy mode, cookies
 * disabled, embedded iframe). Pins:
 *  - Happy path delegates to the underlying window.localStorage/
 *    sessionStorage
 *  - Storage-access throw at probe time falls back to MemoryStorage
 *    + warn log
 *  - setItem failure mid-flight is caught + logged (no throw)
 *  - safeLocalStorage / safeSessionStorage are usable instances
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarn, error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  loggerWarn.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("SafeStorage — happy path (jsdom provides functional localStorage)", () => {
  it("setItem/getItem round-trip delegates to window.localStorage", async () => {
    const { safeLocalStorage } = await import("@/lib/storage");
    safeLocalStorage.setItem("foo", "bar");
    expect(safeLocalStorage.getItem("foo")).toBe("bar");
    // The underlying window.localStorage also has the value.
    expect(window.localStorage.getItem("foo")).toBe("bar");
  });

  it("removeItem clears the value; length tracks the size", async () => {
    const { safeLocalStorage } = await import("@/lib/storage");
    safeLocalStorage.setItem("a", "1");
    safeLocalStorage.setItem("b", "2");
    expect(safeLocalStorage.length).toBe(2);
    safeLocalStorage.removeItem("a");
    expect(safeLocalStorage.length).toBe(1);
    expect(safeLocalStorage.getItem("a")).toBeNull();
  });

  it("clear() empties the store", async () => {
    const { safeLocalStorage } = await import("@/lib/storage");
    safeLocalStorage.setItem("a", "1");
    safeLocalStorage.setItem("b", "2");
    safeLocalStorage.clear();
    expect(safeLocalStorage.length).toBe(0);
  });

  it("key(i) returns the i-th key (matches underlying iteration order)", async () => {
    const { safeLocalStorage } = await import("@/lib/storage");
    safeLocalStorage.clear();
    safeLocalStorage.setItem("first", "1");
    safeLocalStorage.setItem("second", "2");
    expect(safeLocalStorage.key(0)).toBe("first");
    expect(safeLocalStorage.key(1)).toBe("second");
    expect(safeLocalStorage.key(99)).toBeNull();
  });

  it("safeSessionStorage and safeLocalStorage are independent instances", async () => {
    const { safeLocalStorage, safeSessionStorage } = await import("@/lib/storage");
    safeLocalStorage.setItem("k", "L");
    safeSessionStorage.setItem("k", "S");
    expect(safeLocalStorage.getItem("k")).toBe("L");
    expect(safeSessionStorage.getItem("k")).toBe("S");
  });
});

describe("SafeStorage — privacy-mode fallback", () => {
  it("falls back to MemoryStorage + warn log when window.localStorage throws on probe", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Access to storage is not allowed");
      },
    });
    try {
      const { safeLocalStorage } = await import("@/lib/storage");
      // setItem/getItem keep working via the in-memory fallback.
      safeLocalStorage.setItem("foo", "bar");
      expect(safeLocalStorage.getItem("foo")).toBe("bar");
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn.mock.calls[0][0]).toMatch(/blocked.*in-memory/i);
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });

  it("setItem failure on the real storage (e.g. quota exceeded) is caught + warn log", async () => {
    const { safeLocalStorage } = await import("@/lib/storage");
    const setSpy = vi.spyOn(window.localStorage.__proto__, "setItem").mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      // Does NOT throw — the wrapper swallows + logs.
      expect(() => safeLocalStorage.setItem("k", "v")).not.toThrow();
      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn.mock.calls[0][0]).toMatch(/Failed to set item/);
    } finally {
      setSpy.mockRestore();
    }
  });
});
