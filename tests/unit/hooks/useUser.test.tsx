/**
 * Hook tests for `useUser` (rescan-4 M14 — hooks).
 * The shared dashboard auth hook. Mocks next-auth/react, next/navigation,
 * swr, safeLocalStorage, fetcher. Pins:
 *  - sessionReady=false (status='loading') → isLoading=true, user=null
 *  - No auth (no session, no token) → router.push('/login')
 *  - Authenticated session w/o /api/auth/me data yet → fallback to
 *    sessionUser derived from session.user fields
 *  - /api/auth/me data wins over sessionUser
 *  - Admin role → window.location.replace('/admin/dashboard')
 *  - localStorage 'user' is the legacy fallback (when no session)
 *  - safe-destructure: useSession() returning undefined doesn't crash
 */
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

type SessionResult = {
  data: { user?: { id?: string; email?: string; name?: string; role?: string } } | null;
  status: "loading" | "authenticated" | "unauthenticated";
} | undefined;

const useSessionMock = vi.hoisted(() =>
  vi.fn<() => SessionResult>(() => ({ data: null, status: "unauthenticated" }))
);
vi.mock("next-auth/react", () => ({ useSession: useSessionMock }));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

type SwrReturn = { data: unknown; isLoading: boolean };
const useSwrMock = vi.hoisted(() => vi.fn<() => SwrReturn>(() => ({ data: undefined, isLoading: false })));
vi.mock("swr", () => ({
  default: useSwrMock,
}));

vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));

const lsStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => lsStore.set(k, v),
    removeItem: (k: string) => lsStore.delete(k),
  },
}));

import { useUser } from "@/hooks/useUser";

beforeEach(() => {
  useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
  pushMock.mockReset();
  useSwrMock.mockReturnValue({ data: undefined, isLoading: false });
  lsStore.clear();
  // window.location.replace stub
  Object.defineProperty(window, "location", {
    value: { ...window.location, replace: vi.fn() },
    writable: true,
  });
});

describe("useUser", () => {
  it("status='loading' → isLoading=true, user=null", () => {
    useSessionMock.mockReturnValue({ data: null, status: "loading" });
    const { result } = renderHook(() => useUser());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();
  });

  it("unauthenticated + no token → pushes to /login", () => {
    useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
    renderHook(() => useUser());
    expect(pushMock).toHaveBeenCalledWith("/login");
  });

  it("unauthenticated WITH legacy token in localStorage → no push to /login", () => {
    useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
    lsStore.set("token", "legacy-token");
    renderHook(() => useUser());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("authenticated session before SWR resolves → fallback user from session.user fields", () => {
    useSessionMock.mockReturnValue({
      data: { user: { id: "u1", email: "ada@example.test", name: "Ada Lovelace", role: "user" } },
      status: "authenticated",
    });
    useSwrMock.mockReturnValue({ data: undefined, isLoading: true });
    const { result } = renderHook(() => useUser());
    expect(result.current.user).toEqual({
      id: "u1",
      email: "ada@example.test",
      firstName: "Ada",
      lastName: "Lovelace",
      role: "user",
    });
    expect(result.current.isLoading).toBe(false); // session resolved → not loading
  });

  it("/api/auth/me data wins over the sessionUser fallback", () => {
    useSessionMock.mockReturnValue({
      data: { user: { name: "Ada Lovelace", email: "stale@old.test" } },
      status: "authenticated",
    });
    useSwrMock.mockReturnValue({
      data: {
        user: {
          id: "u1",
          email: "fresh@new.test",
          firstName: "Fresh",
          lastName: "User",
          role: "user",
        },
      },
      isLoading: false,
    });
    const { result } = renderHook(() => useUser());
    expect(result.current.user?.email).toBe("fresh@new.test");
    expect(result.current.user?.firstName).toBe("Fresh");
  });

  it("admin role → window.location.replace('/admin/dashboard')", () => {
    useSessionMock.mockReturnValue({
      data: { user: { name: "Ada Lovelace", role: "admin" } },
      status: "authenticated",
    });
    renderHook(() => useUser());
    expect((window.location.replace as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "/admin/dashboard"
    );
  });

  it("localStorage 'user' is the legacy fallback when there's no session", () => {
    useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
    lsStore.set("token", "legacy");
    lsStore.set(
      "user",
      JSON.stringify({
        id: "u1",
        email: "legacy@user.test",
        firstName: "Legacy",
        lastName: "User",
        role: "user",
      })
    );
    const { result } = renderHook(() => useUser());
    expect(result.current.user?.email).toBe("legacy@user.test");
  });

  it("safe-destructure: useSession() returning undefined does NOT crash + treats as loading", () => {
    useSessionMock.mockReturnValue(undefined);
    expect(() => renderHook(() => useUser())).not.toThrow();
    const { result } = renderHook(() => useUser());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();
  });
});
