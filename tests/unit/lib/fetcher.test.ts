/**
 * Tests for `@/lib/fetcher` (rescan-4 slice 7dd).
 * The SWR fetcher used by every dashboard useSWR call. Pins the
 * credentials:include cookie behaviour, JSON content-type header, and
 * the typed-error shape on a non-2xx response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetcher } from "@/lib/fetcher";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetcher", () => {
  it("calls fetch with credentials:'include' and JSON content-type", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1 }),
    });
    await fetcher("/api/v1/auth/me");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/me", {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
  });

  it("returns the parsed JSON on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: "Ada" }),
    });
    const data = await fetcher<{ name: string }>("/api/x");
    expect(data).toEqual({ name: "Ada" });
  });

  it("on non-2xx, throws an Error with .status and .info attached", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: "Unauthorized" }),
    });
    let captured: (Error & { status?: number; info?: unknown }) | undefined;
    try {
      await fetcher("/api/x");
    } catch (err) {
      captured = err as Error & { status: number; info: unknown };
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured?.status).toBe(401);
    expect(captured?.info).toEqual({ message: "Unauthorized" });
  });

  it("non-2xx with non-JSON body → .info defaults to {}", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("invalid json");
      },
    });
    let captured: (Error & { status?: number; info?: unknown }) | undefined;
    try {
      await fetcher("/api/x");
    } catch (err) {
      captured = err as Error & { status: number; info: unknown };
    }
    expect(captured?.status).toBe(500);
    expect(captured?.info).toEqual({});
  });
});
