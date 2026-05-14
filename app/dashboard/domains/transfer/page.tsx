'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import toast from 'react-hot-toast';
import { ArrowLeft, RefreshCw, Loader2, Globe, ShieldCheck } from 'lucide-react';
import UserLayout from '@/components/user/UserLayout';
import ClientOnly from '@/components/ClientOnly';
import { performLogout } from '@/lib/logout';

export default function TransferDomainPage() {
  const [domainName, setDomainName] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();
  const { data: session } = useSession();

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!domainName.trim() || !authCode.trim()) {
      toast.error('Domain Name and Auth Code are required');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/domains/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domainName: domainName.trim(),
          authCode: authCode.trim()
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success(data.message || 'Domain transfer initiated successfully');
        router.push('/dashboard/domains');
      } else {
        toast.error(data.error || 'Failed to initiate domain transfer');
      }
    } catch (error) {
      toast.error('An unexpected error occurred during transfer');
    } finally {
      setIsSubmitting(false);
    }
  };

  const user = session?.user;

  return (
    <ClientOnly>
      <UserLayout user={user as any} onLogout={performLogout}>
        <div className="max-w-4xl mx-auto p-6">
          <button
            onClick={() => router.back()}
            className="flex items-center text-sm font-medium text-gray-500 hover:text-gray-900 mb-6 transition-colors"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Domains
          </button>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-8 border-b border-gray-100 bg-gray-50/50">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 bg-blue-100 text-blue-600 rounded-xl flex items-center justify-center shadow-sm">
                  <RefreshCw className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">Transfer Domain</h1>
                  <p className="text-sm text-gray-500 mt-1">
                    Move your existing domain to our platform for unified management.
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-8 md:px-10">
              <form onSubmit={handleTransfer} className="space-y-6 max-w-2xl">
                <div>
                  <label htmlFor="domainName" className="block text-sm font-semibold text-gray-700 mb-2">
                    Domain Name
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Globe className="h-5 w-5 text-gray-400" />
                    </div>
                    <input
                      type="text"
                      id="domainName"
                      placeholder="e.g., example.com"
                      value={domainName}
                      onChange={(e) => setDomainName(e.target.value)}
                      className="block w-full pl-10 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                      disabled={isSubmitting}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="authCode" className="block text-sm font-semibold text-gray-700 mb-2">
                    Authorization Code (EPP Code)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <ShieldCheck className="h-5 w-5 text-gray-400" />
                    </div>
                    <input
                      type="password"
                      id="authCode"
                      placeholder="Enter the EPP code from your current registrar"
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      className="block w-full pl-10 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                      disabled={isSubmitting}
                    />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    You can obtain this code from your current domain registrar&apos;s control panel.
                  </p>
                </div>

                <div className="bg-blue-50 text-blue-800 p-4 rounded-xl text-sm leading-relaxed border border-blue-100">
                  <h4 className="font-semibold mb-1">Transfer Requirements:</h4>
                  <ul className="list-disc pl-5 space-y-1 text-blue-700/80">
                    <li>The domain must be registered for at least 60 days.</li>
                    <li>The domain must be unlocked at your current registrar.</li>
                    <li>Disable domain privacy protection temporarily.</li>
                  </ul>
                </div>

                <div className="pt-4">
                  <button
                    type="submit"
                    disabled={isSubmitting || !domainName.trim() || !authCode.trim()}
                    className="w-full flex justify-center items-center py-3.5 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" />
                        Initiating Transfer...
                      </>
                    ) : (
                      'Start Domain Transfer'
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </UserLayout>
    </ClientOnly>
  );
}
