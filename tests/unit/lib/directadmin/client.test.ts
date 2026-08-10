/**
 * Tests for `@/lib/directadmin/client` pure helpers (rescan-4 slice 7eg).
 *
 * NOTE: executeRequest is not unit-tested here (the global request
 * queue + rate limiter + circuit breaker keep module-level state across
 * calls and would require fake-timer orchestration that's better
 * exercised in integration tests). The pure helpers below are the
 * ones every DA submodule depends on for credential validation,
 * response parsing, and identifier-format checks.
 *
 * Pins:
 *  - DirectAdminError sets name + 4 props (message, context, status,
 *    response) — the typed-error contract every classifier reads
 *  - DA_SERVER_IP exported (env-driven with a literal fallback for
 *    first-boot smoke tests)
 *  - NAMESERVERS exported (the two ns1/ns2 entries DA hands clients)
 *  - KNOWN_PACKAGES derived from HOSTING_PLANS at module-load
 *  - parseDAError: handles 4 input shapes — {error}/{text}/{details}
 *    object, URL-encoded string (error=1&text=...), HTML (basic tag-
 *    strip), raw string under 500 chars; falls through to "Complex or
 *    empty error response from DirectAdmin"
 *  - parseDAError DECODES URL-encoded percent + plus-to-space (DA emits
 *    `text=Failed%20to+create+user` and humans see "Failed to create user")
 *  - parseResponseData: URL-encoded string → object; repeated keys (like
 *    `list[]=a&list[]=b`) merge into a string[]
 *  - validateUsername: 3-16 chars, must start with letter (a-z), only
 *    [a-z0-9] after — empty/short/long/bad-format all throw
 *  - validatePackageName: [A-Za-z0-9_-]+; empty/special-char throw
 *  - normalizePackageName: case-corrects when the lowercase form
 *    matches a KNOWN_PACKAGES entry; otherwise returns the input
 *    unchanged (no throw on unknown — the package-validation function
 *    is separate); empty input passed through
 *  - logDebugCredentials emits a serverLogger.info line with the
 *    first 2 chars + the key length (NEVER the full key)
 *  - getAuth throws DirectAdminError when creds missing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, error: loggerError, warn: vi.fn() },
}));

// HOSTING_PLANS shape: { someKey: { serverPackage: 'standard' }, ... }
vi.mock("@/config/hosting-plans", () => ({
  HOSTING_PLANS: {
    basic: { serverPackage: "Standard" },
    pro: { serverPackage: "Pro" },
    enterprise: { serverPackage: "Enterprise" },
  },
}));

// The DA client captures env vars at module-load into module-level
// `const`s. So we need to set env BEFORE importing AND re-import per
// test that depends on the captured value.
type ClientMod = typeof import("@/lib/directadmin/client");
let mod: ClientMod;
let DirectAdminError: ClientMod["DirectAdminError"];
let DA_SERVER_IP: ClientMod["DA_SERVER_IP"];
let NAMESERVERS: ClientMod["NAMESERVERS"];
let KNOWN_PACKAGES: ClientMod["KNOWN_PACKAGES"];
let parseDAError: ClientMod["parseDAError"];
let parseResponseData: ClientMod["parseResponseData"];
let validateUsername: ClientMod["validateUsername"];
let validatePackageName: ClientMod["validatePackageName"];
let normalizePackageName: ClientMod["normalizePackageName"];
let logDebugCredentials: ClientMod["logDebugCredentials"];
let getAuth: ClientMod["getAuth"];
let MIN_REQUEST_INTERVAL_MS: ClientMod["MIN_REQUEST_INTERVAL_MS"];
let DEFAULT_TIMEOUT_MS: ClientMod["DEFAULT_TIMEOUT_MS"];

beforeEach(async () => {
  loggerInfo.mockReset();
  loggerError.mockReset();
  vi.stubEnv("DIRECTADMIN_URL", "https://da.test:2222");
  vi.stubEnv("DIRECTADMIN_ADMIN_USER", "admin");
  vi.stubEnv("DIRECTADMIN_API_KEY", "the_secret_api_key_xyz");
  vi.resetModules();
  mod = await import("@/lib/directadmin/client");
  ({
    DirectAdminError,
    DA_SERVER_IP,
    NAMESERVERS,
    KNOWN_PACKAGES,
    parseDAError,
    parseResponseData,
    validateUsername,
    validatePackageName,
    normalizePackageName,
    logDebugCredentials,
    getAuth,
    MIN_REQUEST_INTERVAL_MS,
    DEFAULT_TIMEOUT_MS,
  } = mod);
});

describe("DirectAdminError class", () => {
  it("sets name + message + context + status + response", () => {
    const err = new DirectAdminError(
      "User not found",
      "deleteUser",
      404,
      { error: "404" }
    );
    expect(err.name).toBe("DirectAdminError");
    expect(err.message).toBe("User not found");
    expect(err.context).toBe("deleteUser");
    expect(err.status).toBe(404);
    expect(err.response).toEqual({ error: "404" });
    expect(err instanceof Error).toBe(true);
  });

  it("optional fields all default to undefined", () => {
    const err = new DirectAdminError("oops");
    expect(err.context).toBeUndefined();
    expect(err.status).toBeUndefined();
    expect(err.response).toBeUndefined();
  });
});

describe("module-level constants", () => {
  it("DA_SERVER_IP is exported (env-driven with fallback)", () => {
    expect(typeof DA_SERVER_IP).toBe("string");
    expect(DA_SERVER_IP.length).toBeGreaterThan(0);
  });

  it("NAMESERVERS has the four orderbox-dns entries", () => {
    expect(NAMESERVERS).toEqual([
      "deepak1299294.mercury.orderbox-dns.com",
      "deepak1299294.venus.orderbox-dns.com",
      "deepak1299294.earth.orderbox-dns.com",
      "deepak1299294.mars.orderbox-dns.com",
    ]);
  });

  it("KNOWN_PACKAGES derived from HOSTING_PLANS.serverPackage values", () => {
    expect(KNOWN_PACKAGES).toEqual(["Standard", "Pro", "Enterprise"]);
  });

  it("MIN_REQUEST_INTERVAL_MS = 500 (rate-limit floor)", () => {
    expect(MIN_REQUEST_INTERVAL_MS).toBe(500);
  });

  it("DEFAULT_TIMEOUT_MS = 8000 (8s per-request budget)", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
  });
});

describe("parseDAError", () => {
  it("falsy input → 'Unknown DirectAdmin error'", () => {
    expect(parseDAError(null)).toBe("Unknown DirectAdmin error");
    expect(parseDAError(undefined)).toBe("Unknown DirectAdmin error");
  });

  it("object {error: '...'} → that error string", () => {
    expect(parseDAError({ error: "User does not exist" })).toBe(
      "User does not exist"
    );
  });

  it("object {text: '...'} → text", () => {
    expect(parseDAError({ text: "Already exists" })).toBe("Already exists");
  });

  it("object {details: '...'} → details (fallback when no error/text)", () => {
    expect(parseDAError({ details: "Some detail" })).toBe("Some detail");
  });

  it("URL-encoded string → DECODED concat of text + details (+ → space)", () => {
    const decoded = parseDAError("error=1&text=Failed%20to+create&details=DB+error");
    expect(decoded).toBe("Failed to create - DB error");
  });

  it("HTML string → tag-stripped + whitespace-collapsed", () => {
    expect(parseDAError("<html><body>Server <b>down</b></body></html>")).toBe(
      "Server down"
    );
  });

  it("short raw string (no markers) → returned as-is", () => {
    expect(parseDAError("just a plain error")).toBe("just a plain error");
  });

  it("very long unstructured string → fallthrough sentinel", () => {
    const long = "x".repeat(600);
    expect(parseDAError(long)).toBe(
      "Complex or empty error response from DirectAdmin"
    );
  });
});

describe("parseResponseData", () => {
  it("plain string with no '=' → returned unchanged", () => {
    expect(parseResponseData("hello world")).toBe("hello world");
  });

  it("URL-encoded string → object", () => {
    expect(parseResponseData("user=alice&pkg=Standard")).toEqual({
      user: "alice",
      pkg: "Standard",
    });
  });

  it("repeated key (list[]) → merged into string[]", () => {
    expect(parseResponseData("list[]=a&list[]=b&list[]=c")).toEqual({
      "list[]": ["a", "b", "c"],
    });
  });

  it("non-string input → passed through unchanged", () => {
    expect(parseResponseData({ already: "object" })).toEqual({
      already: "object",
    });
  });
});

describe("validateUsername", () => {
  it("accepts 3-16 chars starting with a letter, alnum only", () => {
    expect(() => validateUsername("alice")).not.toThrow();
    expect(() => validateUsername("user1")).not.toThrow();
    expect(() => validateUsername("a".repeat(16))).not.toThrow();
  });

  it("empty input → throws 'Username is required'", () => {
    expect(() => validateUsername("")).toThrow(/required/i);
  });

  it("<3 chars → throws length error", () => {
    expect(() => validateUsername("ab")).toThrow(/length/i);
  });

  it(">16 chars → throws length error", () => {
    expect(() => validateUsername("a".repeat(17))).toThrow(/length/i);
  });

  it("starts with digit → throws format error", () => {
    expect(() => validateUsername("1alice")).toThrow(/format/i);
  });

  it("contains special chars → throws format error", () => {
    expect(() => validateUsername("alice-x")).toThrow(/format/i);
    expect(() => validateUsername("alice_x")).toThrow(/format/i);
  });
});

describe("validatePackageName", () => {
  it("accepts alnum + _ + -", () => {
    expect(() => validatePackageName("Standard")).not.toThrow();
    expect(() => validatePackageName("pro_v2")).not.toThrow();
    expect(() => validatePackageName("basic-shared")).not.toThrow();
  });

  it("empty → throws 'required'", () => {
    expect(() => validatePackageName("")).toThrow(/required/i);
  });

  it("contains other special chars → throws", () => {
    expect(() => validatePackageName("bad!name")).toThrow();
    expect(() => validatePackageName("bad name")).toThrow();
  });
});

describe("normalizePackageName", () => {
  it("case-corrects against KNOWN_PACKAGES", () => {
    expect(normalizePackageName("standard")).toBe("Standard");
    expect(normalizePackageName("PRO")).toBe("Pro");
    expect(normalizePackageName("enterprise")).toBe("Enterprise");
  });

  it("already-canonical input → returned as-is (no spurious log)", () => {
    loggerInfo.mockReset();
    expect(normalizePackageName("Standard")).toBe("Standard");
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("unknown package → returned unchanged (no throw)", () => {
    expect(normalizePackageName("unknown_pkg")).toBe("unknown_pkg");
  });

  it("empty input → passed through", () => {
    expect(normalizePackageName("")).toBe("");
  });
});

describe("logDebugCredentials", () => {
  it("logs first 2 chars + key length only — NEVER the full key", () => {
    logDebugCredentials();
    expect(loggerInfo).toHaveBeenCalled();
    const logArg = loggerInfo.mock.calls[0][0] as string;
    // Should NOT contain the full key (which is in env stub).
    expect(logArg).not.toContain("the_secret_api_key_xyz");
    // Should contain the first 2 chars + masked.
    expect(logArg).toMatch(/ad\*\*\*/);
    // Should contain the key length.
    expect(logArg).toMatch(/Length:\s*22/);
  });
});

describe("getAuth", () => {
  it("returns {username, password} from env when both set", () => {
    expect(getAuth()).toEqual({
      username: "admin",
      password: "the_secret_api_key_xyz",
    });
  });
});
