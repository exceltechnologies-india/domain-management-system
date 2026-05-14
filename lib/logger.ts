/**
 * Secure Logger Utility
 *
 * Only logs in development environment.
 * In production, logs are suppressed for security.
 */

const isDevelopment = process.env.NODE_ENV === "development";

// Helper to safely send logs to server
const sendToServer = async (level: string, args: any[]) => {
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

    // Use sendBeacon if available for better reliability on unload
    // otherwise fallback to fetch
    const payload = JSON.stringify({ level, messages });
    const url = '/api/log';

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
  log: (...args: any[]) => {
    if (isDevelopment) {
      console.log(...args);
    }
    // sendToServer('info', args); // Optional: uncomment if you want all logs on server
  },

  error: (...args: any[]) => {
    if (isDevelopment) {
      console.error(...args);
    }
    sendToServer('error', args);
  },

  warn: (...args: any[]) => {
    if (isDevelopment) {
      console.warn(...args);
    }
    sendToServer('warn', args);
  },

  info: (...args: any[]) => {
    if (isDevelopment) {
      console.info(...args);
    }
    // sendToServer('info', args);
  },

  debug: (...args: any[]) => {
    if (isDevelopment) {
      console.debug(...args);
    }
  },
};
