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

function remoteLog(args: any[]) {
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL;
  if (!appUrl) return;

  try {
    const stack = args.find((a) => a instanceof Error)?.stack;
    const optionsObj = args.find(
      (a) => typeof a === "object" && a !== null && !(a instanceof Error)
    );
    const formattedArgs = args.map((a) =>
      typeof a === "object" && !(a instanceof Error) ? JSON.stringify(a) : String(a)
    );

    fetch(`${appUrl}/api/admin/log-error`, {
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
    }).catch(() => {});
  } catch {
    // never let logging crash the request
  }
}

/**
 * Reduce mixed (string | Error | object | primitive) arguments into a single
 * { message, meta } pair so production output is one JSON line per log entry.
 */
function compose(args: any[]): { message: string; meta: Record<string, unknown> | null } {
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
        meta = { ...(meta ?? {}), ...a };
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
function emit(severity: Severity, args: any[]) {
  const isProd = process.env.NODE_ENV === "production";
  const { message, meta } = compose(args);

  if (isProd) {
    const payload = JSON.stringify({
      severity,
      message,
      time: new Date().toISOString(),
      ...(meta ?? {}),
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
  log: (...args: any[]) => emit("INFO", args),
  info: (...args: any[]) => emit("INFO", args),
  debug: (...args: any[]) => emit("DEBUG", args),
  warn: (...args: any[]) => emit("WARNING", args),
  error: (...args: any[]) => {
    emit("ERROR", args);
    remoteLog(args);
  },
};
