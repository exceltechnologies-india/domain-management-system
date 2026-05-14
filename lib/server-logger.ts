/**
 * Server-side logger.
 *
 * On Cloud Run (and any 12-factor environment) we write only to stdout/stderr.
 * Cloud Logging captures every line printed to stdout, so no file I/O is needed
 * or wanted (the container filesystem is ephemeral and read-only in prod).
 *
 * Retained features:
 * - Path sanitization: strips the project root dir from messages so internal
 *   paths are never exposed in logs visible to operators.
 * - Remote error reporting: fires-and-forgets a POST to the admin log-error
 *   endpoint for ERROR-level events so they appear in the DB dashboard too.
 */

function sanitizePaths(message: string): string {
  const rootDir = process.cwd();
  const escapedRootDir = rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return message.replace(new RegExp(escapedRootDir, 'g'), '<PROJECT_ROOT>');
}

function remoteLog(args: any[]) {
  const appUrl = process.env.NEXTAUTH_URL || process.env.APP_URL;
  if (!appUrl) return; // no remote logging without a known base URL

  try {
    const stack = args.find((a) => a instanceof Error)?.stack;
    const optionsObj = args.find(
      (a) => typeof a === 'object' && a !== null && !(a instanceof Error)
    );
    const formattedArgs = args.map((a) =>
      typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : String(a)
    );

    fetch(`${appUrl}/api/admin/log-error`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': process.env.CRON_SECRET || '',
      },
      body: JSON.stringify({
        message: sanitizePaths(formattedArgs.join(' ')),
        source: 'Server Logger',
        url: 'server-side',
        stack: stack ? sanitizePaths(stack) : undefined,
        service: optionsObj?.service || 'api',
        requestId: optionsObj?.requestId,
        statusCode: optionsObj?.statusCode,
        ip: optionsObj?.ip,
        metadata: optionsObj,
      }),
    }).catch(() => {}); // fire-and-forget
  } catch {
    // never let logging crash the request
  }
}

export const serverLogger = {
  log: (...args: any[]) => {
    console.log(...args);
  },

  info: (...args: any[]) => {
    console.info(...args);
  },

  warn: (...args: any[]) => {
    console.warn(...args);
  },

  error: (...args: any[]) => {
    console.error(...args);
    remoteLog(args);
  },
};
