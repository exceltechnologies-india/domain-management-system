'use client';

import { ShieldX, Home, LogIn } from 'lucide-react';
import Link from 'next/link';
import { homeUrl } from '@/lib/reseller-os';

export default function ForbiddenPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-paper-2 via-rose-soft to-rose-soft flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-paper rounded-2xl shadow-xl border border-hairline p-8 text-center">
        <div className="w-20 h-20 bg-gradient-to-br from-red-500 to-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg">
          <ShieldX className="h-10 w-10 text-paper" />
        </div>

        <p className="text-6xl font-extrabold text-rose mb-2">403</p>
        <h1 className="text-2xl font-bold text-ink mb-3">Access Denied</h1>
        <p className="text-ink-3 text-sm leading-relaxed mb-8">
          You don&apos;t have permission to view this page. Please log in with an
          account that has the required access, or return to the homepage.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-rose text-paper text-sm font-medium rounded-lg hover:bg-rose/90 transition-colors"
          >
            <LogIn className="h-4 w-4" />
            Log In
          </Link>
          <Link
            href={homeUrl()}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-paper-2 text-ink-2 text-sm font-medium rounded-lg hover:bg-hairline/50 transition-colors"
          >
            <Home className="h-4 w-4" />
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}
