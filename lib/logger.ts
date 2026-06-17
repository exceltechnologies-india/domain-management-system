/**
 * Secure Logger Utility
 *
 * Only logs in development environment.
 * In production, logs are suppressed for security.
 */

const isDevelopment = process.env.NODE_ENV === "development";

// Helper to safely send logs to server
const sendToServer = async (level: string, args: unknown[]) => {
  if (typeof window === 'undefined') return; // Only run on client

  try {
    // Sanitize args to prevent circular reference errors during JSON stringify
    const messages = args.map(arg => {
      if (arg instanceof Error) {
        return { message: arg.message, stack: arg.stack, name: arg.name };
      }
      if (typeof arg === 'object' && arg !== null) {
        try {
          // Simple circular reference check
          JSON.stringify(arg);
          return arg;
        } catch (e) {
          return '[Circular Object]';
        }
      }
      return arg;
    });

    // Server schema (app/api/log/route.ts) expects `{level, message:
    // string, details?: unknown}` — message MUST be a string and is
    // required (zod validation rejects with 400 otherwise). Collapse
    // the variadic args into a single space-joined `message` string,
    // and pass the full structured array as `details` so the server
    // logger receives the same shape as before for diagnostic context.
    const message = messages
      .map((m) =>
        typeof m === 'string'
          ? m
          : typeof m === 'object' && m !== null
          ? JSON.stringify(m)
          : String(m)
      )
      .join(' ')
      .slice(0, 8000); // schema caps at 8000 chars
    const payload = JSON.stringify({ level, message, details: messages });
    const url = '/api/v1/log';

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true // Important for logs during page lifecycle changes
      }).catch(() => {}); // Ignore network errors for logging to prevent loops
    }
  } catch (e) {
    // Fail silently
  }
};

export const logger = {
  log: (...args: unknown[]) => {
    if (isDevelopment) {
      console.log(...args);
    }
    // sendToServer('info', args); // Optional: uncomment if you want all logs on server
  },

  error: (...args: unknown[]) => {
    if (isDevelopment) {
      console.error(...args);
    }
    void sendToServer('error', args);
  },

  warn: (...args: unknown[]) => {
    if (isDevelopment) {
      console.warn(...args);
    }
    void sendToServer('warn', args);
  },

  info: (...args: unknown[]) => {
    if (isDevelopment) {
      console.info(...args);
    }
    // sendToServer('info', args);
  },

  debug: (...args: unknown[]) => {
    if (isDevelopment) {
      console.debug(...args);
    }
  },
};
