/**
 * Typed frontend API client (rescan-4 S1, batch 7aa).
 *
 * The frontend used to spread `fetch("/api/...")` across ~58 files, each
 * with its own response/error handling. New endpoints required hunting
 * down every consumer; there was no central place to attach request-id
 * headers or tracing; per-component handlers diverged in how they
 * surfaced 4xx / 5xx errors.
 *
 * This module gives the frontend a single typed surface that:
 *
 *  - Returns a `Result<T, ApiError>` discriminated union instead of
 *    throwing. Callers `switch (result.ok)` and stay typed end-to-end.
 *  - Optionally parses the response through a Zod schema — same
 *    runtime contract the API routes use on the server side (S3 sweep).
 *  - Carries `credentials: "include"` automatically so the NextAuth
 *    session cookie rides every request.
 *  - Normalises error shape — `{ status, message, code?, body? }` —
 *    pulling `error` and `code` from the response JSON when present
 *    (which is the contract our `validatedBody` helper standardised).
 *
 * Migration is incremental — existing `fetcher.ts` SWR users + raw
 * `fetch()` callers can stay; new code and refactored components
 * should prefer `apiClient`.
 */
import type { ZodSchema } from "zod";

export interface ApiError {
  /** HTTP status. 0 means network failure (fetch threw). */
  status: number;
  /** User-friendly message — best-effort pulled from the response body's `error` field, else a synthesised string. */
  message: string;
  /** Server-supplied error code (e.g. "VALIDATION_ERROR", "UNAUTHORIZED"). */
  code?: string;
  /** Raw response body when parseable; useful for callers that need richer detail than message alone. */
  body?: unknown;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export interface RequestOptions {
  /** AbortController.signal for cancellation. */
  signal?: AbortSignal;
  /** Additional headers — merged on top of the defaults. */
  headers?: Record<string, string>;
}

async function request<T>(
  method: string,
  url: string,
  body: unknown | undefined,
  schema: ZodSchema<T> | undefined,
  opts: RequestOptions
): Promise<ApiResult<T>> {
  const hasBody = body !== undefined;
  const headers: Record<string, string> = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(opts.headers ?? {}),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: "include",
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    // fetch threw — network error, CORS, abort, etc. Surface as status=0
    // so callers can distinguish "request never reached the server" from
    // "server returned an error".
    return {
      ok: false,
      error: {
        status: 0,
        message: err instanceof Error ? err.message : "Network error",
      },
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = await res.json();
  } catch {
    // Response wasn't JSON — that's fine for some routes (e.g. file
    // downloads), but for the standard JSON contract this means an
    // empty/malformed body. Leave parsedBody as undefined.
    parsedBody = undefined;
  }

  if (!res.ok) {
    const errBody = parsedBody as { error?: string; code?: string } | undefined;
    return {
      ok: false,
      error: {
        status: res.status,
        message: errBody?.error ?? `Request failed: ${res.status}`,
        code: errBody?.code,
        body: parsedBody,
      },
    };
  }

  if (schema) {
    const parsed = schema.safeParse(parsedBody);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          status: res.status,
          message: "Response schema mismatch",
          body: parsedBody,
        },
      };
    }
    return { ok: true, data: parsed.data };
  }

  return { ok: true, data: parsedBody as T };
}

export const apiClient = {
  get<T = unknown>(url: string, schema?: ZodSchema<T>, opts: RequestOptions = {}) {
    return request<T>("GET", url, undefined, schema, opts);
  },
  post<T = unknown>(url: string, body: unknown, schema?: ZodSchema<T>, opts: RequestOptions = {}) {
    return request<T>("POST", url, body, schema, opts);
  },
  put<T = unknown>(url: string, body: unknown, schema?: ZodSchema<T>, opts: RequestOptions = {}) {
    return request<T>("PUT", url, body, schema, opts);
  },
  patch<T = unknown>(url: string, body: unknown, schema?: ZodSchema<T>, opts: RequestOptions = {}) {
    return request<T>("PATCH", url, body, schema, opts);
  },
  delete<T = unknown>(url: string, schema?: ZodSchema<T>, opts: RequestOptions = {}) {
    return request<T>("DELETE", url, undefined, schema, opts);
  },
};
