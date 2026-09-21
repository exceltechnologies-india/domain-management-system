'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import toast from 'react-hot-toast';
import { apiClient } from '@/lib/api-client';
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

    const result = await apiClient.post<{ success?: boolean; message?: string }>(
      '/api/v1/domains/transfer',
      { domainName: domainName.trim(), authCode: authCode.trim() }
    );

    if (result.ok && result.data.success) {
      toast.success(result.data.message || 'Domain transfer initiated successfully');
      router.push('/dashboard/domains');
    } else if (result.ok) {
      toast.error('Failed to initiate domain transfer');
    } else {
      toast.error(result.error.message || 'Failed to initiate domain transfer');
    }
    setIsSubmitting(false);
  };

  // NextAuth session.user has { name?, email? } — UserLayout wants
  // { firstName, lastName, email }. Split `name` here to satisfy the contract.
  const layoutUser = session?.user
    ? {
        firstName: session.user.name?.split(" ")[0] ?? "",
        lastName: session.user.name?.split(" ").slice(1).join(" ") ?? "",
        email: session.user.email ?? "",
      }
    : null;

  return (
    <ClientOnly>
      <UserLayout user={layoutUser} onLogout={performLogout}>
        <div className="max-w-4xl mx-auto p-6">
          <button
            onClick={() => router.back()}
            className="flex items-center text-sm font-medium text-ink-3 hover:text-ink mb-6 transition-colors"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Domains
          </button>

          <div className="bg-paper rounded-2xl shadow-sm border border-hairline overflow-hidden">
            <div className="px-6 py-8 border-b border-hairline bg-paper-2/50">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 bg-amber-soft text-amber rounded-xl flex items-center justify-center shadow-sm">
                  <RefreshCw className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="font-serif text-2xl font-bold text-ink">Transfer Domain</h1>
                  <p className="text-sm text-ink-3 mt-1">
                    Move your existing domain to our platform for unified management.
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-8 md:px-10">
              <form onSubmit={handleTransfer} className="space-y-6 max-w-2xl">
                <div>
                  <label htmlFor="domainName" className="block text-sm font-semibold text-ink-2 mb-2">
                    Domain Name
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Globe className="h-5 w-5 text-ink-4" />
                    </div>
                    <input
                      type="text"
                      id="domainName"
                      placeholder="e.g., example.com"
                      value={domainName}
                      onChange={(e) => setDomainName(e.target.value)}
                      className="block w-full pl-10 pr-4 py-3 border border-hairline-strong rounded-xl focus:ring-2 focus:ring-amber focus:border-transparent transition-all"
                      disabled={isSubmitting}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="authCode" className="block text-sm font-semibold text-ink-2 mb-2">
                    Authorization Code (EPP Code)
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <ShieldCheck className="h-5 w-5 text-ink-4" />
                    </div>
                    <input
                      type="password"
                      id="authCode"
                      placeholder="Enter the EPP code from your current registrar"
                      value={authCode}
                      onChange={(e) => setAuthCode(e.target.value)}
                      className="block w-full pl-10 pr-4 py-3 border border-hairline-strong rounded-xl focus:ring-2 focus:ring-amber focus:border-transparent transition-all"
                      disabled={isSubmitting}
                    />
                  </div>
                  <p className="mt-2 text-xs text-ink-3">
                    You can obtain this code from your current domain registrar&apos;s control panel.
                  </p>
                </div>

                <div className="bg-indigo-soft text-indigo-ink p-4 rounded-xl text-sm leading-relaxed border border-indigo/25">
                  <h4 className="font-semibold mb-1">Transfer Requirements:</h4>
                  <ul className="list-disc pl-5 space-y-1 text-indigo-ink/80">
                    <li>The domain must be registered for at least 60 days.</li>
                    <li>The domain must be unlocked at your current registrar.</li>
                    <li>Disable domain privacy protection temporarily.</li>
                  </ul>
                </div>

                <div className="pt-4">
                  <button
                    type="submit"
                    disabled={isSubmitting || !domainName.trim() || !authCode.trim()}
                    className="w-full flex justify-center items-center py-3.5 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-paper bg-amber hover:brightness-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber disabled:opacity-60 disabled:cursor-not-allowed transition-all"
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
