/**
 * Request ID extraction / generation, Edge-runtime safe.
 *
 * Cloud Run sends `X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=TRACE_TRUE`. When
 * present, we use TRACE_ID as the request ID so structured-log entries
 * automatically correlate with traces in Cloud Logging.
 *
 * If the header is absent (local dev, non-Cloud-Run host, or a client that
 * supplies its own `x-request-id`), we fall back to:
 *   1. an incoming `x-request-id` header verbatim, OR
 *   2. a fresh UUID v4 generated via `crypto.randomUUID()`
 *      (works in both Node and Edge runtimes).
 */

const TRACE_HEADER = "x-cloud-trace-context";
const REQUEST_ID_HEADER = "x-request-id";

export function resolveRequestId(headers: Headers): string {
  const trace = headers.get(TRACE_HEADER);
  if (trace) {
    // Format: "TRACE_ID/SPAN_ID;o=TRACE_TRUE" — TRACE_ID alone is sufficient.
    const traceId = trace.split("/")[0];
    if (traceId) return traceId;
  }

  const existing = headers.get(REQUEST_ID_HEADER);
  if (existing) return existing;

  // Both Node and Edge runtimes expose crypto.randomUUID() globally.
  return crypto.randomUUID();
}

export { REQUEST_ID_HEADER };
