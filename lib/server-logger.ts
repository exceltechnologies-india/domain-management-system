/**
 * Server-side logger.
 *
 * On Cloud Run (and any 12-factor environment) we write only to stdout/stderr.
 * Cloud Logging captures every line printed to stdout and — when the line is
 * a single JSON object — automatically parses it into a structured log entry
 * with severity, jsonPayload, etc. We rely on that:
 *
 * - In production (NODE_ENV=production), each call emits one JSON line:
 *     {"severity":"INFO","message":"…","time":"…","service":"app",…meta}
 *   Severity strings match Google Cloud Logging's LogSeverity enum so the
 *   web UI colour-codes entries correctly.
 *
 * - In development, output is human-readable with a coloured-ish prefix
 *   so it stays readable in a terminal.
 *
 * Including a request ID in a log entry:
 *   Any object argument is merged into the top-level JSON output, so the
 *   convention is to pass `{ requestId }` (and any other meta) as the
 *   trailing arg:
 *
 *     serverLogger.info("payment captured", { requestId, orderId });
 *
 *   In a route handler, the request ID is on the `x-request-id` header
 *   (set by middleware.ts; preferred source is Cloud Run's
 *   X-Cloud-Trace-Context so logs correlate with Cloud Trace spans):
 *
 *     const requestId = request.headers.get("x-request-id");
 *     serverLogger.info("...", { requestId });
 *
 * Retained features from the original implementation:
 * - Path sanitization: strips the project root dir from messages so internal
 *   paths are never exposed in logs visible to operators.
 * - Remote error reporting: fires-and-forgets a POST to the admin log-error
 *   endpoint for ERROR-level events so they appear in the DB dashboard too.
 */

type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

function sanitizePaths(message: string): string {
  // process.cwd may be absent in the Edge runtime (middleware). Treat that
  // case as a no-op rather than throwing.
  try {
    const rootDir = typeof process !== "undefined" ? process.cwd?.() : null;
    if (!rootDir) return message;
    const escapedRootDir = rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return message.replace(new RegExp(escapedRootDir, "g"), "<PROJECT_ROOT>");
  } catch {
    return message;
  }
}

// Logger arguments are intentionally heterogeneous — strings, Errors, plain
// objects, primitives — so `unknown` is the honest type. Each branch in
// compose()/remoteLog narrows from there.
type LogArg = unknown;

interface LogOptionsObj {
  service?: string;
  requestId?: string;
  statusCode?: number;
  ip?: string;
  [k: string]: unknown;
}

function remoteLog(args: LogArg[]) {
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL;
  if (!appUrl) return;

  try {
    const stack = (args.find((a) => a instanceof Error) as Error | undefined)?.stack;
    const optionsObj = args.find(
      (a) => typeof a === "object" && a !== null && !(a instanceof Error)
    ) as LogOptionsObj | undefined;
    const formattedArgs = args.map((a) =>
      typeof a === "object" && !(a instanceof Error) ? JSON.stringify(a) : String(a)
    );

    // 2s timeout — a hung log-error handler would otherwise queue indefinite
    // outbound fetches per `serverLogger.error()` call. The log-error route
    // breaks the recursion loop by using `console.error` (not
    // `serverLogger.error`) in its own catch.
    fetch(`${appUrl}/api/v1/admin/log-error`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": process.env.CRON_SECRET || "",
      },
      body: JSON.stringify({
        message: sanitizePaths(formattedArgs.join(" ")),
        source: "Server Logger",
        url: "server-side",
        stack: stack ? sanitizePaths(stack) : undefined,
        service: optionsObj?.service || "api",
        requestId: optionsObj?.requestId,
        statusCode: optionsObj?.statusCode,
        ip: optionsObj?.ip,
        metadata: optionsObj,
      }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    // never let logging crash the request
  }
}

/**
 * Reduce mixed (string | Error | object | primitive) arguments into a single
 * { message, meta } pair so production output is one JSON line per log entry.
 */
function compose(args: LogArg[]): { message: string; meta: Record<string, unknown> | null } {
  const parts: string[] = [];
  let meta: Record<string, unknown> | null = null;

  for (const a of args) {
    if (a instanceof Error) {
      parts.push(a.message);
      meta = { ...(meta ?? {}), errorName: a.name, stack: a.stack };
    } else if (typeof a === "object" && a !== null) {
      // Merge plain object args into meta rather than spelling them in the message.
      try {
        JSON.stringify(a); // ensure it's serializable
        meta = { ...(meta ?? {}), ...(a as Record<string, unknown>) };
      } catch {
        parts.push("[unserializable object]");
      }
    } else {
      parts.push(String(a));
    }
  }

  return { message: sanitizePaths(parts.join(" ")), meta };
}

// console.* is the only IO API available in both Node.js and Edge runtimes
// (process.stdout.write doesn't exist in middleware). Next.js routes both to
// Cloud Logging on Cloud Run, and Cloud Logging auto-parses single-line JSON.
function emit(severity: Severity, args: LogArg[]) {
  const isProd = process.env.NODE_ENV === "production";
  const { message, meta } = compose(args);

  // Pull requestId from the AsyncLocalStorage context if a handler set one
  // via withRequestLogContext. An explicit `{ requestId }` in the call args
  // takes precedence so callers can override (e.g. middleware passes its own).
  //
  // We read the storage off globalThis instead of importing it — request-
  // context.ts pulls node:async_hooks which Webpack rejects in the Edge
  // runtime (middleware). The globalThis hop keeps middleware's import path
  // clean while still letting Node route handlers benefit from auto-flow.
  let ambientRequestId: string | undefined;
  try {
    const storage = (
      globalThis as unknown as {
        __requestContextStorage?: { getStore?: () => { requestId?: string } | undefined };
      }
    ).__requestContextStorage;
    ambientRequestId = storage?.getStore?.()?.requestId;
  } catch {
    /* defensive: never let logging crash a request */
  }

  const mergedMeta = ambientRequestId
    ? { requestId: ambientRequestId, ...(meta ?? {}) }
    : meta;

  if (isProd) {
    const payload = JSON.stringify({
      severity,
      message,
      time: new Date().toISOString(),
      ...(mergedMeta ?? {}),
    });
    if (severity === "ERROR") {
      // eslint-disable-next-line no-console
      console.error(payload);
    } else if (severity === "WARNING") {
      // eslint-disable-next-line no-console
      console.warn(payload);
    } else {
      // eslint-disable-next-line no-console
      console.log(payload);
    }
    return;
  }

  // Dev: keep the original args so error stacks, objects, etc. render natively
  // in the terminal. Severity prefix only.
  const prefix = `[${severity}]`;
  switch (severity) {
    case "ERROR":
      // eslint-disable-next-line no-console
      console.error(prefix, ...args);
      break;
    case "WARNING":
      // eslint-disable-next-line no-console
      console.warn(prefix, ...args);
      break;
    case "DEBUG":
      // eslint-disable-next-line no-console
      console.debug(prefix, ...args);
      break;
    default:
      // eslint-disable-next-line no-console
      console.info(prefix, ...args);
  }
}

export const serverLogger = {
  log: (...args: LogArg[]) => emit("INFO", args),
  info: (...args: LogArg[]) => emit("INFO", args),
  debug: (...args: LogArg[]) => emit("DEBUG", args),
  warn: (...args: LogArg[]) => emit("WARNING", args),
  error: (...args: LogArg[]) => {
    emit("ERROR", args);
    remoteLog(args);
  },
};
