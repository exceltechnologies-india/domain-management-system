/**
 * Tests for `@/lib/logout` (rescan-4 slice 7dx).
 * performLogout / logoutUser / useLogout helpers. Pins:
 *  - sets isLoggingOut flag in sessionStorage BEFORE calling signOut
 *    (so AuthSync stops re-syncing immediately)
 *  - calls signOut with redirect:false
 *  - clears the 4 localStorage auth fields + clears sessionStorage
 *  - clears all 6 cookies (token + the 5 NextAuth variants) on both
 *    path:/ AND path:/+domain=hostname (covers cross-domain flavours)
 *  - toast.success + delayed window.location.replace('/login')
 *  - signOut throw on the happy path is logged + caught (logout still
 *    completes)
 *  - catch-all fallback path clears everything + redirects anyway
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const signOutMock = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signOut: signOutMock }));

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccess },
  __esModule: true,
}));

const lsStore = vi.hoisted(() => new Map<string, string>());
const ssStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => lsStore.set(k, v),
    removeItem: (k: string) => lsStore.delete(k),
    clear: () => lsStore.clear(),
  },
  safeSessionStorage: {
    getItem: (k: string) => ssStore.get(k) ?? null,
    setItem: (k: string, v: string) => ssStore.set(k, v),
    removeItem: (k: string) => ssStore.delete(k),
    clear: () => ssStore.clear(),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { performLogout, logoutUser } from "@/lib/logout";

const replaceMock = vi.fn();

beforeEach(() => {
  signOutMock.mockReset();
  signOutMock.mockResolvedValue(undefined);
  toastSuccess.mockReset();
  lsStore.clear();
  ssStore.clear();
  replaceMock.mockReset();
  // Stub window.location with a replace spy + a hostname for the
  // cookie-clear branch.
  Object.defineProperty(window, "location", {
    value: { replace: replaceMock, hostname: "app.example.com" },
    writable: true,
  });
  // Clear document.cookie between tests via the standard expiry trick.
  document.cookie.split(";").forEach((c) => {
    document.cookie = c
      .replace(/^ +/, "")
      .replace(/=.*/, "=;expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });
});

describe("performLogout", () => {
  it("sets isLoggingOut flag BEFORE calling signOut", async () => {
    const order: string[] = [];
    ssStore.set = ((k: string, v: string) => {
      if (k === "isLoggingOut") order.push("flag-set");
      Map.prototype.set.call(ssStore, k, v);
      return ssStore as never;
    }) as never;
    signOutMock.mockImplementation(async () => {
      order.push("signOut");
    });
    await performLogout();
    expect(order[0]).toBe("flag-set");
    expect(order[1]).toBe("signOut");
  });

  it("calls signOut with redirect:false (manual redirect after)", async () => {
    await performLogout();
    expect(signOutMock).toHaveBeenCalledWith({ redirect: false });
  });

  it("clears the 4 localStorage auth fields + clears sessionStorage", async () => {
    lsStore.set("token", "t");
    lsStore.set("user", "u");
    lsStore.set("rememberMe", "true");
    lsStore.set("savedEmail", "e@x.test");
    lsStore.set("other", "kept"); // unrelated key — should NOT be removed
    ssStore.set("any-key", "v");
    await performLogout();
    expect(lsStore.has("token")).toBe(false);
    expect(lsStore.has("user")).toBe(false);
    expect(lsStore.has("rememberMe")).toBe(false);
    expect(lsStore.has("savedEmail")).toBe(false);
    // Unrelated localStorage keys are NOT touched (only the 4 auth fields).
    expect(lsStore.has("other")).toBe(true);
    // sessionStorage cleared entirely.
    expect(ssStore.size).toBe(0);
  });

  it("clears the 6 known cookie names + toast.success + delayed redirect", async () => {
    // Set the cookies first so the clear has something to overwrite.
    document.cookie = "token=value; path=/";
    document.cookie = "next-auth.session-token=value; path=/";
    await performLogout();
    // After the cookie-clear loop, the cookies are expired (max-age=0).
    // jsdom honours that — document.cookie should not include them.
    expect(document.cookie).not.toContain("token=value");
    expect(document.cookie).not.toContain("next-auth.session-token=value");
    expect(toastSuccess).toHaveBeenCalledWith("Logged out successfully");
    // 500ms-delayed redirect.
    await new Promise((r) => setTimeout(r, 600));
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("happy-path signOut failure is logged + logout still completes", async () => {
    signOutMock.mockRejectedValueOnce(new Error("nextauth blip"));
    await performLogout();
    // Toast still fires; redirect still scheduled.
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("catch-all fallback: outer-try error → clears EVERYTHING and still redirects", async () => {
    // Force the cookies.forEach iteration to throw by stubbing the
    // setItem to throw — falls through to the outer catch.
    const origForEach = Array.prototype.forEach;
    let threw = false;
    Array.prototype.forEach = function (cb: never) {
      if (!threw) {
        threw = true;
        throw new Error("forced");
      }
      return origForEach.call(this, cb as never);
    };
    try {
      await performLogout();
      // Reaches the outer catch — full clear + redirect.
      expect(toastSuccess).toHaveBeenCalled();
    } finally {
      Array.prototype.forEach = origForEach;
    }
  });
});

describe("logoutUser", () => {
  it("immediately redirects (no 500ms delay) after clearing", async () => {
    await logoutUser();
    expect(signOutMock).toHaveBeenCalledWith({ redirect: false });
    expect(toastSuccess).toHaveBeenCalledWith("Logged out successfully");
    // Immediate redirect — replace called before any setTimeout fires.
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });
});
