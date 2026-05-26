/**
 * Unit tests for the frontend Result-style API client (rescan-4 S1).
 * Pins the response → Result<T, ApiError> mapping, schema parsing, and
 * error normalisation contract so the migration callers in slice 33+
 * can rely on stable semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiClient } from "@/lib/api-client";

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

const mockJsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);

describe("apiClient.get", () => {
  it("returns ok=true with the parsed body on 200", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockJsonResponse(200, { hello: "world" })
    );

    const result = await apiClient.get("/api/test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ hello: "world" });
  });

  it("sends credentials:include automatically (NextAuth cookie ride)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(200, {}));
    global.fetch = fetchSpy;

    await apiClient.get("/api/test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({ credentials: "include", method: "GET" })
    );
  });

  it("does not set Content-Type on GET (no body)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(200, {}));
    global.fetch = fetchSpy;

    await apiClient.get("/api/test");
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("returns ok=false with status + message from the response error field on 4xx", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockJsonResponse(400, { error: "Invalid input", code: "VALIDATION_ERROR" })
    );

    const result = await apiClient.get("/api/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
      expect(result.error.message).toBe("Invalid input");
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("synthesises a fallback message when the error body has no .error field", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockJsonResponse(500, {})
    );

    const result = await apiClient.get("/api/test");
    if (!result.ok) expect(result.error.message).toMatch(/500/);
  });

  it("surfaces network errors as status=0", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Failed to fetch")
    );

    const result = await apiClient.get("/api/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(0);
      expect(result.error.message).toBe("Failed to fetch");
    }
  });

  it("runs the response through the supplied Zod schema on success", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockJsonResponse(200, { count: 7 })
    );

    const schema = z.object({ count: z.number() });
    const result = await apiClient.get("/api/test", schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.count).toBe(7);
  });

  it("returns ok=false when the response fails the schema", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockJsonResponse(200, { count: "seven" })
    );

    const schema = z.object({ count: z.number() });
    const result = await apiClient.get("/api/test", schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(200);
      expect(result.error.message).toBe("Response schema mismatch");
    }
  });
});

describe("apiClient.post / put / patch / delete", () => {
  it("post serialises body and sets Content-Type", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(201, { id: 1 }));
    global.fetch = fetchSpy;

    await apiClient.post("/api/test", { name: "x" });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("delete uses the DELETE method and sends no body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(204, {}));
    global.fetch = fetchSpy;

    await apiClient.delete("/api/test");
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("patch + put propagate method + body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(200, {}));
    global.fetch = fetchSpy;

    await apiClient.patch("/api/test", { active: true });
    expect(fetchSpy.mock.calls[0][1].method).toBe("PATCH");
    expect(fetchSpy.mock.calls[0][1].body).toBe(JSON.stringify({ active: true }));

    await apiClient.put("/api/test", { active: false });
    expect(fetchSpy.mock.calls[1][1].method).toBe("PUT");
    expect(fetchSpy.mock.calls[1][1].body).toBe(JSON.stringify({ active: false }));
  });

  it("merges custom headers on top of the defaults", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockJsonResponse(200, {}));
    global.fetch = fetchSpy;

    await apiClient.post(
      "/api/test",
      { x: 1 },
      undefined,
      { headers: { "x-request-id": "abc123" } }
    );
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["x-request-id"]).toBe("abc123");
  });
});
