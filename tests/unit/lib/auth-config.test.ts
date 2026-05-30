/**
 * Tests for `@/lib/auth-config` (rescan-4 slice 7do).
 * Backwards-compat barrel that assembles authOptions from submodules.
 * Pins the load-bearing shape so a future submodule shuffle doesn't
 * silently change the NextAuth contract:
 *  - providers / callbacks / cookies / pages / session / secret
 *  - debug flag tracks NODE_ENV
 *  - logger.error/warn/debug forward to serverLogger
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = "a-known-test-secret-32+chars-xyzxyz";
});

const providersMock = vi.hoisted(() => [{ id: "google" }, { id: "credentials" }]);
const callbacksMock = vi.hoisted(() => ({
  signIn: vi.fn(),
  jwt: vi.fn(),
  session: vi.fn(),
}));
const cookiesMock = vi.hoisted(() => ({
  sessionToken: { name: "next-auth.session-token", options: {} },
}));

vi.mock("@/lib/auth-config/providers", () => ({ providers: providersMock }));
vi.mock("@/lib/auth-config/callbacks", () => ({ callbacks: callbacksMock }));
vi.mock("@/lib/auth-config/cookies", () => ({ cookies: cookiesMock }));

const loggerErrorMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());
const loggerLogMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerErrorMock, warn: loggerWarnMock, log: loggerLogMock },
}));

beforeEach(() => {
  vi.resetModules();
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
  loggerLogMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authOptions", () => {
  it("wires up providers / callbacks / cookies from the submodules", async () => {
    const { authOptions } = await import("@/lib/auth-config");
    expect(authOptions.providers).toBe(providersMock);
    expect(authOptions.callbacks).toBe(callbacksMock);
    expect(authOptions.cookies).toBe(cookiesMock);
  });

  it("pages.signIn = '/login' and pages.error = '/login'", async () => {
    const { authOptions } = await import("@/lib/auth-config");
    expect(authOptions.pages).toEqual({ signIn: "/login", error: "/login" });
  });

  it("session: strategy='jwt' + maxAge=30min", async () => {
    const { authOptions } = await import("@/lib/auth-config");
    expect(authOptions.session?.strategy).toBe("jwt");
    expect(authOptions.session?.maxAge).toBe(30 * 60);
  });

  it("secret is the AUTH_SECRET (trimmed NEXTAUTH_SECRET)", async () => {
    const { authOptions } = await import("@/lib/auth-config");
    expect(authOptions.secret).toBe("a-known-test-secret-32+chars-xyzxyz");
  });

  it("debug=true in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { authOptions } = await import("@/lib/auth-config");
    expect(authOptions.debug).toBe(true);
  });

  it("debug=false in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { authOptions } = await import("@/lib/auth-config");
    expect(authOptions.debug).toBe(false);
  });

  it("logger.error forwards to serverLogger.error with stringified message args", async () => {
    const { authOptions } = await import("@/lib/auth-config");
    // The source uses a rest-args signature internally; cast through
    // unknown so we can pass the test args without satisfying
    // NextAuth's typed Logger interface verbatim.
    const errorFn = authOptions.logger!.error as unknown as (
      code: string,
      ...args: unknown[]
    ) => void;
    errorFn("CALLBACK_FETCH_ERROR", { provider: "google" });
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock.mock.calls[0][0]).toBe("NextAuth Error:");
    expect(loggerErrorMock.mock.calls[0][1]).toBe("CALLBACK_FETCH_ERROR");
    expect(loggerErrorMock.mock.calls[0][2]).toMatch(/google/);
  });

  it("logger.warn forwards to serverLogger.warn with the code", async () => {
    const { authOptions } = await import("@/lib/auth-config");
    authOptions.logger!.warn!("NEXTAUTH_URL");
    expect(loggerWarnMock).toHaveBeenCalledWith("NextAuth Warning:", "NEXTAUTH_URL");
  });

  it("logger.debug forwards to serverLogger.log; metadata gets JSON-stringified or empty string", async () => {
    const { authOptions } = await import("@/lib/auth-config");
    authOptions.logger!.debug!("JWT_SESSION", { sub: "u1" });
    expect(loggerLogMock).toHaveBeenCalledTimes(1);
    expect(loggerLogMock.mock.calls[0][2]).toMatch(/u1/);

    loggerLogMock.mockReset();
    authOptions.logger!.debug!("NO_METADATA", undefined);
    expect(loggerLogMock.mock.calls[0][2]).toBe("");
  });
});
