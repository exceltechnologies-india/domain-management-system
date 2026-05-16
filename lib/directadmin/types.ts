/**
 * Shared types for DirectAdmin API responses.
 *
 * DirectAdmin returns URL-encoded form data (`key=value&list[]=a&list[]=b`)
 * for most endpoints, sometimes JSON, sometimes HTML (when an auth check
 * intercepts the request and the login page bounces back). The parser in
 * `client.ts` normalises this into a record; downstream submodules read
 * the documented keys for whichever CMD they invoked.
 *
 * Each response carries an open index signature — DA's responses are
 * narrow per-CMD but vary subtly across versions, and adding a field
 * shouldn't break the typechecker.
 */

import { AxiosError } from "axios";

/**
 * Object form of a parsed DirectAdmin response — the URL-encoded-string
 * path of `parseResponseData` returns this. Values are strings; keys
 * suffixed with `[]` (e.g. `list[]=a&list[]=b`) collapse into string[].
 */
export type DAParsedRecord = { [k: string]: string | string[] | undefined };

/**
 * The full return shape of `parseResponseData` — either the parsed
 * object form, or the raw string when the input wasn't URL-encoded.
 * Callers that know the endpoint returns key=value should narrow to
 * `DAParsedRecord` themselves.
 */
export type DAParsedResponse = string | DAParsedRecord;

/**
 * Standard DA error payload — either parsed into the `error=1&text=...`
 * shape, or carrying loose fields like `details`, `result`, etc.
 */
export interface DAErrorPayload {
  error?: string;
  text?: string;
  details?: string;
  result?: string;
  code?: string;
  [k: string]: unknown;
}

/**
 * Narrow an unknown catch-block error into the DA-specific bits we read:
 * HTTP status, `response.data`, and the network-error code.
 */
export function unwrapDAError(err: unknown): {
  status?: number;
  data?: DAErrorPayload | string;
  code?: string;
  message: string;
} {
  if (err instanceof AxiosError) {
    return {
      status: err.response?.status,
      data: err.response?.data as DAErrorPayload | string | undefined,
      code: err.code,
      message: err.message,
    };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
  };
}
