/**
 * Tests for `@/lib/request-id` (rescan-4 slice 7de).
 * The request-ID extractor used by structured logging on Cloud Run.
 * Pins the priority order:
 *  1. X-Cloud-Trace-Context (Cloud Run-provided trace id)
 *  2. X-Request-Id (client-provided)
 *  3. crypto.randomUUID() fallback
 */
import { describe, it, expect } from "vitest";
import { resolveRequestId, REQUEST_ID_HEADER } from "@/lib/request-id";

describe("resolveRequestId", () => {
  it("prefers X-Cloud-Trace-Context (Cloud Run) over X-Request-Id", () => {
    const headers = new Headers({
      "x-cloud-trace-context": "abc123def456/SPAN_ID;o=1",
      "x-request-id": "client-supplied-id",
    });
    expect(resolveRequestId(headers)).toBe("abc123def456");
  });

  it("extracts just the TRACE_ID before the '/' from X-Cloud-Trace-Context", () => {
    const headers = new Headers({
      "x-cloud-trace-context": "trace-only-no-span",
    });
    expect(resolveRequestId(headers)).toBe("trace-only-no-span");
  });

  it("falls back to X-Request-Id when X-Cloud-Trace-Context is absent", () => {
    const headers = new Headers({
      "x-request-id": "incoming-request-id",
    });
    expect(resolveRequestId(headers)).toBe("incoming-request-id");
  });

  it("generates a fresh UUID v4 when no relevant headers are present", () => {
    const headers = new Headers();
    const id = resolveRequestId(headers);
    // UUID v4 pattern: 8-4-4-4-12 hex chars, version-4 nibble.
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("two calls without headers produce different UUIDs (randomUUID is fresh per call)", () => {
    const a = resolveRequestId(new Headers());
    const b = resolveRequestId(new Headers());
    expect(a).not.toBe(b);
  });

  it("exports REQUEST_ID_HEADER as 'x-request-id'", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});
