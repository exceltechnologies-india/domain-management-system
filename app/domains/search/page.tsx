'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, useEffect } from 'react';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import DomainSearch from '@/components/DomainSearch';
import { useSession } from 'next-auth/react';

interface User {
  firstName: string;
  lastName: string;
  role: string;
}

function SearchContent() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') || '';
  const [user, setUser] = useState<User | null>(null);
  const { data: session } = useSession();

  useEffect(() => {
    if (session?.user) {
      setUser({
        firstName: session.user.name?.split(' ')[0] || '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
        role: session.user.role || 'user',
      });
    } else {
      setUser(null);
    }
  }, [session]);

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--google-bg-secondary)' }}>
      <Navigation user={user} />
      
      <main className="flex-grow pt-16 sm:pt-20 pb-8 sm:pb-12">
        {/* Functional Search Header */}
        <div className="bg-white border-b border-gray-100 mb-6 sm:mb-8 shadow-sm">
          <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <nav className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
                  <Link href="/" className="hover:text-blue-600 transition-colors">Home</Link>
                  <span className="text-gray-300">/</span>
                  <span className="text-blue-600">Domain Search</span>
                </nav>
                <h1 className="text-xl sm:text-2xl font-black text-gray-900 tracking-tight">
                  Search Results {query && <span className="text-gray-400">— {query}</span>}
                </h1>
              </div>
              <div className="flex items-center gap-3">
                <div className="bg-blue-50 text-blue-600 px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse"></div>
                  Real-time Availability
                </div>
                <Link
                  href="/domains/bulk-search"
                  className="text-xs font-bold text-gray-500 hover:text-blue-600 border border-gray-200 hover:border-blue-300 px-3 py-1.5 rounded-full transition-colors"
                >
                  Bulk Search
                </Link>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6">
          <DomainSearch 
            initialSearchTerm={query} 
            autoSearch={!!query} 
            className="w-full"
            theme="light"
            showHeroText={false}
            compact={true}
          />
        </div>
      </main>

      <Footer />
    </div>
  );
}

export default function DomainSearchPage() {
  return (
    <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
    }>
      <SearchContent />
    </Suspense>
  );
}
