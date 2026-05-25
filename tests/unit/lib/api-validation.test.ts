/**
 * Unit tests for lib/api-validation.ts — the centralised body / query
 * validation helpers introduced in rescan-4 S3 (batch 7z).
 *
 * The shared unit-test setup stubs NextResponse.json to return undefined.
 * We override that locally so we can introspect status + body on the
 * 400 responses the helper returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      _body: body, // expose for direct assertion (NextResponse.json is sync-only in stubs)
    })),
  },
}));

import { NextRequest } from "next/server";
import { validatedBody, validatedQuery, z } from "@/lib/api-validation";

function makeJsonRequest(body: unknown, malformed = false): NextRequest {
  return {
    json: async () => {
      if (malformed) throw new SyntaxError("Unexpected token");
      return body;
    },
  } as unknown as NextRequest;
}

function makeUrlRequest(url: string): NextRequest {
  return { url } as unknown as NextRequest;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("validatedBody", () => {
  const schema = z.object({
    email: z.string().email(),
    age: z.number().int().nonnegative(),
  });

  it("returns ok:true with parsed data on a valid body", async () => {
    const req = makeJsonRequest({ email: "user@example.com", age: 30 });
    const result = await validatedBody(req, schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.email).toBe("user@example.com");
      expect(result.data.age).toBe(30);
    }
  });

  it("returns 400 with INVALID_JSON code when JSON parse fails", async () => {
    const req = makeJsonRequest(null, true);
    const result = await validatedBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const resp = result.response as unknown as { status: number; _body: { error: string; code: string } };
      expect(resp.status).toBe(400);
      expect(resp._body.code).toBe("INVALID_JSON");
      expect(resp._body.error).toBe("Invalid JSON body");
    }
  });

  it("returns 400 with VALIDATION_ERROR when a field is missing", async () => {
    const req = makeJsonRequest({ email: "user@example.com" }); // missing age
    const result = await validatedBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const resp = result.response as unknown as { status: number; _body: { error: string; code: string } };
      expect(resp.status).toBe(400);
      expect(resp._body.code).toBe("VALIDATION_ERROR");
      // Message format is "<path>: <reason>" — pin the path is mentioned.
      expect(resp._body.error).toMatch(/age/);
    }
  });

  it("returns 400 when a field has the wrong type", async () => {
    const req = makeJsonRequest({ email: "not-an-email", age: 30 });
    const result = await validatedBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const resp = result.response as unknown as { _body: { error: string } };
      expect(resp._body.error).toMatch(/email/);
    }
  });

  it("joins multiple validation errors into one message", async () => {
    const req = makeJsonRequest({ email: "bad", age: -5 });
    const result = await validatedBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const resp = result.response as unknown as { _body: { error: string } };
      expect(resp._body.error).toMatch(/email/);
      expect(resp._body.error).toMatch(/age/);
      expect(resp._body.error).toContain(";"); // joiner
    }
  });

  it("preserves data on a passthrough schema (extra keys allowed)", async () => {
    const passthrough = z.object({ x: z.string() }).passthrough();
    const req = makeJsonRequest({ x: "ok", extra: "kept" });
    const result = await validatedBody(req, passthrough);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>).extra).toBe("kept");
    }
  });
});

describe("validatedQuery", () => {
  const schema = z.object({
    page: z.coerce.number().int().positive().default(1),
    q: z.string().optional(),
  });

  it("parses + coerces searchParams on a valid query", () => {
    const req = makeUrlRequest("https://example.com/api/x?page=3&q=foo");
    const result = validatedQuery(req, schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.page).toBe(3);
      expect(result.data.q).toBe("foo");
    }
  });

  it("applies defaults when params are absent", () => {
    const req = makeUrlRequest("https://example.com/api/x");
    const result = validatedQuery(req, schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.page).toBe(1);
      expect(result.data.q).toBeUndefined();
    }
  });

  it("returns 400 on a coercion failure (page=abc)", () => {
    const req = makeUrlRequest("https://example.com/api/x?page=abc");
    const result = validatedQuery(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const resp = result.response as unknown as { status: number; _body: { code: string; error: string } };
      expect(resp.status).toBe(400);
      expect(resp._body.code).toBe("VALIDATION_ERROR");
      expect(resp._body.error).toMatch(/page/);
    }
  });

  it("returns 400 when a constraint fails (page=0 not positive)", () => {
    const req = makeUrlRequest("https://example.com/api/x?page=0");
    const result = validatedQuery(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const resp = result.response as unknown as { _body: { error: string } };
      expect(resp._body.error).toMatch(/page/);
    }
  });
});
