'use client';

import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { useEffect } from 'react';
import Link from 'next/link';
import Button from '@/components/Button';
import { logger } from '@/lib/logger';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Always echo to the browser console FIRST so a dev with the page
    // open immediately sees what went wrong — without this, the error
    // boundary silently swallowed the message and the only paper trail
    // was the (often 403'd) admin/log-error forwarder.
    // eslint-disable-next-line no-console
    console.error('[error-boundary]', error);

    // Then forward to the server-side log collection for ops postmortem
    fetch('/api/v1/admin/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message || 'Unknown Client Error',
        stack: error.stack,
        url: window.location.href,
        source: 'Client Boundary',
        service: 'frontend-client',
        metadata: { digest: error.digest }
      })
    }).catch(logger.error);
  }, [error]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation />

      <div className="flex items-center justify-center min-h-[80vh] px-4 pt-24">
        <div className="text-center max-w-2xl mx-auto">
          {/* Error Icon */}
          <div className="mb-8">
            <div className="bg-red-100 rounded-full w-32 h-32 flex items-center justify-center mx-auto mb-6">
              <AlertTriangle className="h-16 w-16 text-red-600" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4">
              Oops! Something went wrong
            </h1>
            <p className="text-xl text-gray-600 mb-8">
              We encountered an unexpected error. Don't worry, our team has been notified
              and we're working to fix it as soon as possible.
            </p>
          </div>

          {/* Error Details (only in development) */}
          {process.env.NODE_ENV === 'development' && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8 text-left">
              <h3 className="font-semibold text-red-800 mb-2">Error Details:</h3>
              <p className="text-sm text-red-700 font-mono break-all">
                {error.message}
              </p>
              {error.digest && (
                <p className="text-xs text-red-600 mt-2">
                  Error ID: {error.digest}
                </p>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
            <Button
              variant="primary"
              size="lg"
              className="flex items-center gap-2"
              onClick={reset}
            >
              <RefreshCw className="h-5 w-5" />
              Try Again
            </Button>
            <Link href="/">
              <Button variant="outline" size="lg" className="flex items-center gap-2">
                <Home className="h-5 w-5" />
                Go Home
              </Button>
            </Link>
          </div>

        </div>
      </div>

      <Footer />
    </div>
  );
}
