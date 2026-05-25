/**
 * Centralised body / query validation helpers for Next.js route handlers
 * (rescan-4 S3, batch 7z).
 *
 * Before this module existed, ~66 of 73 API routes did
 *   const { x, y } = await request.json();
 * with no validation — relying on downstream code to catch type errors
 * or, worse, silently coercing undefined into MongoDB queries. Per-route
 * Zod schemas + this helper make the contract explicit and uniform.
 *
 * Two helpers:
 *
 *   - `validatedBody(req, schema)` — parses JSON, runs the schema, returns
 *     `{ ok: true, data } | { ok: false, response }`. On failure, `response`
 *     is a pre-built 400 NextResponse with the Zod issues collapsed into a
 *     single user-friendly message. Caller `return outcome.response` and
 *     the route exits with a uniform error shape.
 *
 *   - `validatedQuery(req, schema)` — same idea for `URL.searchParams`.
 *
 * Both helpers swallow the JSON parse error and return a 400 — never
 * throw — so route handlers don't need their own try/catch around the
 * parse step.
 */
import { NextRequest, NextResponse } from "next/server";
import { z, ZodError, type ZodSchema } from "zod";

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

function zodErrorToMessage(err: ZodError): string {
  // First issue is usually the most informative; surface a join for the
  // 95% case (single field) without overwhelming the user with the full
  // tree on multi-field errors.
  return err.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "body";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse + validate the JSON body of a Next.js request against a Zod
 * schema. Returns a discriminated union so callers branch on `ok`
 * instead of try/catch'ing.
 *
 * Example:
 *   const schema = z.object({ email: Schemas.email });
 *   const result = await validatedBody(request, schema);
 *   if (!result.ok) return result.response;
 *   const { email } = result.data;
 */
export async function validatedBody<T>(
  req: NextRequest,
  schema: ZodSchema<T>
): Promise<ValidationResult<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid JSON body", code: "INVALID_JSON" },
        { status: 400 }
      ),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: zodErrorToMessage(parsed.error),
          code: "VALIDATION_ERROR",
        },
        { status: 400 }
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

/**
 * Same idea for `URL.searchParams`. Schema is applied to the
 * URLSearchParams entries (each value is a string; use `z.coerce.*` on
 * the schema side to convert).
 *
 * Example:
 *   const schema = z.object({ page: z.coerce.number().int().positive().default(1) });
 *   const result = validatedQuery(request, schema);
 *   if (!result.ok) return result.response;
 */
export function validatedQuery<T>(
  req: NextRequest,
  schema: ZodSchema<T>
): ValidationResult<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: zodErrorToMessage(parsed.error),
          code: "VALIDATION_ERROR",
        },
        { status: 400 }
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

// Re-export z so route files can write `z.object(...)` without a second
// import line. Keeps the per-route schema definition co-located with the
// handler that consumes it.
export { z };
