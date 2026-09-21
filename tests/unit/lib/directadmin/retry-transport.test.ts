/**
 * `executeRequest` must not retry into the dark.
 *
 * Its retry condition was `!status || status >= 500`. `!status` means "no HTTP
 * response", which covers two opposite situations: a connection that was
 * REFUSED (nothing sent — a retry is free) and a socket that died AFTER the
 * bytes left (DirectAdmin may already have done the work). Lumping them
 * together meant `createUser` — a non-idempotent create running on the default
 * maxRetries: 2 — would fire again after a reset, creating a second hosting
 * account or colliding with the one it had just made.
 *
 * Threat model:
 *  - **ECONNRESET / ETIMEDOUT must not retry.** These are the possibly-landed
 *    cases. This is the whole point of the change.
 *  - **ECONNREFUSED / ENOTFOUND must still retry.** The connection never
 *    established, so nothing happened; removing these retries would turn a
 *    momentary DNS blip into a failed provision.
 *  - **>= 500 must still retry.** DirectAdmin answered, so delivery is not in
 *    question, and the reads that make up most of this module's 21 callers
 *    depend on it.
 *  - **401/403 must still never retry**, and a DirectAdminError (a logical DA
 *    failure, not a transport one) must still fail immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxiosError } from "axios";

/**
 * The module reads DIRECTADMIN_* into module-level consts AT IMPORT, so these
 * must be set before the import below — a beforeEach is too late and
 * validateCredentials() then rejects before requestFn is ever called, which
 * presents as "called 0 times" rather than as a credentials error.
 */
vi.hoisted(() => {
  process.env.DIRECTADMIN_URL = "https://da.local.invalid:2222";
  process.env.DIRECTADMIN_ADMIN_USER = "admin";
  process.env.DIRECTADMIN_API_KEY = "key";
});

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/config/hosting-plans", () => ({ HOSTING_PLANS: {} }));

import { executeRequest, DirectAdminError } from "@/lib/directadmin/client";

/**
 * REAL AxiosError instances, not duck-typed objects.
 *
 * `unwrapDAError` branches on `err instanceof AxiosError`, so an object merely
 * carrying `isAxiosError: true` loses both `code` and `status` — the retry
 * logic then sees neither and refuses to retry, which reads as "the fix broke
 * legitimate retries" rather than "the fixture is wrong".
 */
function netError(code: string) {
  return new AxiosError(code, code);
}
function httpError(status: number) {
  return new AxiosError(`HTTP ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    statusText: "",
    data: "error=1&text=nope",
    headers: {},
    config: { headers: {} },
  } as never);
}

/**
 * MONOTONIC across tests. `vi.useFakeTimers()` resets the fake clock to the
 * real current time, so a per-test `Date.now() + offset` can land BEHIND a
 * circuitOpenUntil written by an earlier test — the breaker then stays shut
 * and every later test reports "called 0 times".
 */
let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers();
  /**
   * The client keeps a MODULE-LEVEL circuit breaker: 5 consecutive failures
   * open it for 60s, and these tests generate failures deliberately. Without
   * this, later tests reject with "Circuit breaker open" and requestFn is
   * never called — which looks identical to "the retry logic skipped it".
   *
   * The client resets its own counters once the open window has passed, so
   * starting each test two minutes later is enough; no production code needs
   * a test-only reset hook.
   */
  clock += 300_000;
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Run with timers auto-advanced so the backoff sleeps resolve. */
async function run<T>(fn: () => Promise<T>, op: string, retries?: number) {
  const p = retries === undefined ? executeRequest(fn, op) : executeRequest(fn, op, retries);
  await vi.runAllTimersAsync();
  return p;
}

describe("possibly-landed failures are NOT retried", () => {
  it.each(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE"])(
    "%s → one attempt only",
    async (code) => {
      const fn = vi.fn().mockRejectedValue(netError(code));
      await expect(run(fn, `Op-${code}`)).rejects.toBeTruthy();
      // The default is maxRetries: 2, so the old behaviour was 3 attempts.
      expect(fn).toHaveBeenCalledTimes(1);
    }
  );

  it("ECONNRESET on a create does not produce a second create", async () => {
    // The concrete damage: createUser runs on the default retries.
    const createUser = vi.fn().mockRejectedValue(netError("ECONNRESET"));
    await expect(run(createUser, "CreateUser-bob")).rejects.toBeTruthy();
    expect(createUser).toHaveBeenCalledTimes(1);
  });
});

describe("definitely-not-sent failures still retry", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])("%s → retried", async (code) => {
    const fn = vi.fn().mockRejectedValue(netError(code));
    await expect(run(fn, `Op-${code}`)).rejects.toBeTruthy();
    // 1 initial + 2 retries.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("recovers when a refused connection comes back", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(netError("ECONNREFUSED"))
      .mockResolvedValueOnce("ok");
    await expect(run(fn, "Op-recover")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("server-side failures still retry — delivery is not in question", () => {
  it.each([500, 502, 503])("%i → retried", async (status) => {
    const fn = vi.fn().mockRejectedValue(httpError(status));
    await expect(run(fn, `Op-${status}`)).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("4xx (other than auth) is not retried — the request was understood", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(run(fn, "Op-400")).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("the existing guarantees are untouched", () => {
  it.each([401, 403])("%i fails immediately, never retried", async (status) => {
    const fn = vi.fn().mockRejectedValue(httpError(status));
    await expect(run(fn, `Auth-${status}`)).rejects.toBeInstanceOf(DirectAdminError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a DirectAdminError (logical DA failure) is not retried", async () => {
    const fn = vi.fn().mockRejectedValue(new DirectAdminError("User exists", "CreateUser", 200));
    await expect(run(fn, "Op-logical")).rejects.toBeInstanceOf(DirectAdminError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maxRetries: 0 still means one attempt", async () => {
    const fn = vi.fn().mockRejectedValue(netError("ECONNREFUSED"));
    await expect(run(fn, "Op-none", 0)).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a successful call is not retried", async () => {
    const fn = vi.fn().mockResolvedValue("fine");
    await expect(run(fn, "Op-ok")).resolves.toBe("fine");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
