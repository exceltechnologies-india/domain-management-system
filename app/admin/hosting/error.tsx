'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, Home, Terminal } from 'lucide-react';
import Link from 'next/link';
import Button from '@/components/Button';

export default function AdminHostingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to console for debugging
    console.error('Admin Hosting Error:', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6 bg-gray-50 rounded-xl border border-gray-200 m-4">
      <div className="text-center max-w-2xl mx-auto">
        <div className="mb-8">
          <div className="bg-red-100 rounded-full w-24 h-24 flex items-center justify-center mx-auto mb-6 shadow-sm">
            <AlertTriangle className="h-12 w-12 text-red-600" />
          </div>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">
            Hosting Dashboard Error
          </h2>
          <p className="text-gray-600 mb-8 max-w-md mx-auto">
            We encountered an unexpected issue while loading the hosting management interface.
          </p>
        </div>

        {/* Always show error details for Admin context */}
        <div className="bg-white border border-red-200 rounded-lg p-6 mb-8 text-left shadow-sm">
          <div className="flex items-center gap-2 mb-3 text-red-700 font-semibold">
            <Terminal className="h-5 w-5" />
            <span>Error Details (Admin View)</span>
          </div>
          <div className="bg-gray-900 rounded-md p-4 overflow-x-auto">
            <code className="text-sm text-red-400 font-mono">
              {error.message || "Unknown error occurred"}
            </code>
            {error.digest && (
              <div className="mt-2 pt-2 border-t border-gray-800 text-xs text-gray-500 font-mono">
                Digest: {error.digest}
              </div>
            )}
            {error.stack && (
              <div className="mt-2 pt-2 border-t border-gray-800 text-xs text-gray-500 font-mono whitespace-pre-wrap opacity-50">
                {error.stack.split('\n').slice(0, 3).join('\n')}...
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            variant="primary"
            onClick={reset}
            className="flex items-center gap-2 shadow-sm"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>
          <Link href="/admin">
            <Button variant="outline" className="flex items-center gap-2 bg-white">
              <Home className="h-4 w-4" />
              Return to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
