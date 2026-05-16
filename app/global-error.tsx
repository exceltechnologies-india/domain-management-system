'use client';

import NextError from 'next/error';
import { useEffect } from 'react';
import { logger } from '@/lib/logger';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    // Custom error tracking
    fetch('/api/v1/admin/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: (error as Error).message || 'Unknown Global Error',
        stack: (error as Error).stack,
        url: window?.location?.href || 'global',
        source: 'Global Boundary',
        service: 'frontend-client',
        metadata: { digest: error.digest }
      })
    }).catch(logger.error);
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={500} title="Critical Application Error" />
      </body>
    </html>
  );
}
