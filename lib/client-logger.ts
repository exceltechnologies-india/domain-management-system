/**
 * Client-side logger utility that forwards logs to the server
 * This allows us to capture client errors in server logs instead of exposing them in browser console
 */

type LogLevel = 'info' | 'warn' | 'error';

const sendLog = async (level: LogLevel, message: string, details?: unknown) => {
  try {
    // Only log in production or if explicitly enabled
    // We always send to server to persist logs
    
    await fetch('/api/v1/log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        level,
        message,
        details,
        url: typeof window !== 'undefined' ? window.location.href : '',
        timestamp: new Date().toISOString(),
      }),
      keepalive: true, // Ensure log is sent even if page unloads
    });
  } catch (e) {
    // Fallback if logging fails - do nothing to avoid infinite loops
  }
};

export const clientLogger = {
  info: (message: string, details?: unknown) => sendLog('info', message, details),
  warn: (message: string, details?: unknown) => sendLog('warn', message, details),
  error: (message: string, details?: unknown) => sendLog('error', message, details),
};
