'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ArrowLeft, Globe, Save, RefreshCw, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, DetailPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import { performLogout } from '@/lib/logout';
import { formatIndianDateTime } from '@/lib/dateUtils';
import { apiClient } from '@/lib/api-client';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface Domain {
  id: string;
  name: string;
  status: string;
  registrar: string;
  nameservers: string[];
  expiryDate: string;
  autoRenew: boolean;
}

export default function ManageDomain() {
  const [user, setUser] = useState<User | null>(null);
  const [domain, setDomain] = useState<Domain | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [nameservers, setNameservers] = useState<string[]>([]);
  const [isNameserverLoading, setIsNameserverLoading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [nsMethod, setNsMethod] = useState<'default' | 'custom'>('default');
  const [customNs, setCustomNs] = useState<string[]>(['', '', '', '']);
  const [isHostedDomain, setIsHostedDomain] = useState(false);

  const router = useRouter();
  const params = useParams();
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === 'loading') return;

    if (session?.user) {
      const sUser = session.user;
      const userObj = {
        id: sUser.id ?? '',
        email: session.user.email || '',
        firstName: session.user.name?.split(' ')[0] || '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
        role: sUser.role || 'user',
      };
      setUser(userObj);
      void loadDomainDetails(userObj);
      return;
    }

    router.push('/login');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, session, status, params.id]);

  const loadDomainDetails = async (userObj: User) => {
    setIsLoading(true);

    // 1. Check services to see which domains are hosted
    const statusResult = await apiClient.get<{ hostedDomains?: string[] }>('/api/v1/user/services/status');
    const hostedDomains: string[] = statusResult.ok ? (statusResult.data.hostedDomains || []) : [];

    // Fetch all domains and find the one matching the ID
    // Ideally we should have a single domain endpoint, but this works for now
    const result = await apiClient.get<{ domains: Domain[] }>('/api/v1/user/domains');
    if (result.ok) {
      const foundDomain = result.data.domains.find((d: Domain) => d.id === params.id);

      if (foundDomain) {
        setDomain(foundDomain);

        // Check if this specific domain is hosted
        const isHosted = hostedDomains.includes(foundDomain.name);
        setIsHostedDomain(isHosted);

        void loadNameservers(foundDomain.name);
      } else {
        toast.error('Domain not found');
        router.push('/dashboard/domains');
      }
    } else {
      toast.error('Failed to load domain details');
    }
    setIsLoading(false);
  };

  const loadNameservers = async (domainName: string) => {
    setIsNameserverLoading(true);
    const result = await apiClient.get<{ nameservers?: string[] }>(`/api/v1/domains/nameservers?domainName=${encodeURIComponent(domainName)}`);
    if (result.ok) {
      const currentNs = result.data.nameservers || [];
      setNameservers(currentNs);

      // Determine if using default or custom
      const isDefault = currentNs.some((ns: string) => ns.toLowerCase().includes('orderbox-dns.com'));
      setNsMethod(isDefault ? 'default' : 'custom');

      if (!isDefault && currentNs.length > 0) {
        const paddedNs = [...currentNs, '', '', '', ''].slice(0, 4);
        setCustomNs(paddedNs);
      }
    }
    setIsNameserverLoading(false);
  };

  const handleUpdateNameservers = async () => {
    if (!domain) return;
    setIsUpdating(true);

    const result = await apiClient.post('/api/v1/user/domains/nameservers', {
      domainName: domain.name,
      method: nsMethod,
      nameservers: nsMethod === 'custom' ? customNs.filter(ns => ns.trim()) : undefined,
    });

    if (result.ok) {
      toast.success('Nameservers updated successfully');
      void loadNameservers(domain.name);
    } else {
      toast.error(result.error.message || 'Failed to update nameservers');
    }
    setIsUpdating(false);
  };

  if (!user || isLoading) {
    return <DashboardLayoutSkeleton><DetailPageSkeleton /></DashboardLayoutSkeleton>;
  }

  if (!domain) return null;

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={performLogout}>
        <div className="p-6 max-w-4xl mx-auto">
          <div className="mb-6">
            <button
              onClick={() => router.push('/dashboard/domains')}
              className="flex items-center text-ink-2 hover:text-ink mb-4 transition-colors"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Domains
            </button>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center min-w-0">
                <Globe className="h-8 w-8 text-amber mr-3 shrink-0" />
                <div className="min-w-0">
                  <h1 className="font-serif text-2xl font-bold text-ink truncate">{domain.name}</h1>
                  <p className="text-ink-3 text-sm">
                    Expires on {formatIndianDateTime(domain.expiryDate)}
                  </p>
                </div>
              </div>
              <span className={`shrink-0 px-3 py-1 rounded-full text-sm font-medium ${domain.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-paper-2 text-ink'
                }`}>
                {domain.status.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="bg-paper rounded-lg shadow-sm border border-hairline overflow-hidden">
            <div className="p-6 border-b border-hairline">
              <h2 className="text-lg font-semibold text-ink mb-4">Nameservers</h2>

              {isHostedDomain && (
                <div className="mb-6 bg-indigo-soft border-l-4 border-indigo p-4 rounded-md">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <CheckCircle className="h-5 w-5 text-indigo" aria-hidden="true" />
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-indigo-ink">Managed by Hosting</h3>
                      <div className="mt-2 text-sm text-indigo-ink/80">
                        <p>
                          This domain is connected to your hosting package. Nameservers are automatically managed by your hosting setup to ensure your website and services work correctly.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row gap-4">
                  <label className={`flex-1 relative border rounded-lg p-4 cursor-pointer transition-all ${nsMethod === 'default' ? 'border-amber bg-amber-soft ring-1 ring-amber' : 'border-hairline hover:border-hairline-strong hover:bg-paper-2'
                    }`}>
                    <input
                      type="radio"
                      name="nsMethod"
                      value="default"
                      checked={nsMethod === 'default'}
                      onChange={() => setNsMethod('default')}
                      className="sr-only"
                    />
                    <div className="flex items-center mb-1">
                      <div className={`w-4 h-4 rounded-full border mr-2 flex items-center justify-center ${nsMethod === 'default' ? 'border-amber' : 'border-hairline-strong'
                        }`}>
                        {nsMethod === 'default' && <div className="w-2 h-2 rounded-full bg-amber" />}
                      </div>
                      <span className={`font-medium ${nsMethod === 'default' ? 'text-amber-ink' : 'text-ink'}`}>
                        Default Nameservers
                      </span>
                    </div>
                    <p className={`text-sm ml-6 ${nsMethod === 'default' ? 'text-amber-ink' : 'text-ink-3'}`}>
                      Use our secure, managed nameservers
                    </p>
                  </label>

                  <label className={`flex-1 relative border rounded-lg p-4 cursor-pointer transition-all ${nsMethod === 'custom' ? 'border-amber bg-amber-soft ring-1 ring-amber' : 'border-hairline hover:border-hairline-strong hover:bg-paper-2'} ${isHostedDomain ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <input
                      type="radio"
                      name="nsMethod"
                      value="custom"
                      checked={nsMethod === 'custom'}
                      onChange={() => !isHostedDomain && setNsMethod('custom')}
                      disabled={isHostedDomain}
                      className="sr-only"
                    />
                    <div className="flex items-center mb-1">
                      <div className={`w-4 h-4 rounded-full border mr-2 flex items-center justify-center ${nsMethod === 'custom' ? 'border-amber' : 'border-hairline-strong'
                        }`}>
                        {nsMethod === 'custom' && <div className="w-2 h-2 rounded-full bg-amber" />}
                      </div>
                      <span className={`font-medium ${nsMethod === 'custom' ? 'text-amber-ink' : 'text-ink'}`}>
                        Custom Nameservers
                      </span>
                    </div>
                    <p className={`text-sm ml-6 ${nsMethod === 'custom' ? 'text-amber-ink' : 'text-ink-3'}`}>
                      {isHostedDomain ? 'Disabled for hosted domains' : 'Point to external hosting or DNS provider'}
                    </p>
                  </label>
                </div>

                {nsMethod === 'default' ? (
                  <div className="bg-paper-2/60 rounded-lg p-4 border border-hairline">
                    <div className="flex items-start">
                      <div className="flex-shrink-0">
                        <CheckCircle className="h-5 w-5 text-green-500" />
                      </div>
                      <div className="ml-3">
                        <h3 className="text-sm font-medium text-ink">Ready to use</h3>
                        <div className="mt-2 text-sm text-ink-3">
                          <p>Applying default nameservers will configure this domain to use our managed DNS infrastructure.</p>
                        </div>
                        <div className="mt-4">
                          <button
                            onClick={handleUpdateNameservers}
                            disabled={isUpdating || isNameserverLoading}
                            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-paper bg-amber hover:brightness-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber disabled:opacity-50"
                          >
                            {isUpdating ? 'Updating...' : 'Apply Default Nameservers'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 animate-in fade-in slide-in-from-top-2">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-ink-2 mb-1">Nameserver 1</label>
                        <input
                          type="text"
                          value={customNs[0]}
                          onChange={(e) => {
                            const newNs = [...customNs];
                            newNs[0] = e.target.value;
                            setCustomNs(newNs);
                          }}
                          placeholder="ns1.example.com"
                          className="w-full px-3 py-2 border border-hairline-strong rounded-md shadow-sm focus:ring-amber focus:border-amber sm:text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-ink-2 mb-1">Nameserver 2</label>
                        <input
                          type="text"
                          value={customNs[1]}
                          onChange={(e) => {
                            const newNs = [...customNs];
                            newNs[1] = e.target.value;
                            setCustomNs(newNs);
                          }}
                          placeholder="ns2.example.com"
                          className="w-full px-3 py-2 border border-hairline-strong rounded-md shadow-sm focus:ring-amber focus:border-amber sm:text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-ink-2 mb-1">Nameserver 3 <span className="text-ink-4 font-normal">(Optional)</span></label>
                        <input
                          type="text"
                          value={customNs[2]}
                          onChange={(e) => {
                            const newNs = [...customNs];
                            newNs[2] = e.target.value;
                            setCustomNs(newNs);
                          }}
                          placeholder="ns3.example.com"
                          className="w-full px-3 py-2 border border-hairline-strong rounded-md shadow-sm focus:ring-amber focus:border-amber sm:text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-ink-2 mb-1">Nameserver 4 <span className="text-ink-4 font-normal">(Optional)</span></label>
                        <input
                          type="text"
                          value={customNs[3]}
                          onChange={(e) => {
                            const newNs = [...customNs];
                            newNs[3] = e.target.value;
                            setCustomNs(newNs);
                          }}
                          placeholder="ns4.example.com"
                          className="w-full px-3 py-2 border border-hairline-strong rounded-md shadow-sm focus:ring-amber focus:border-amber sm:text-sm"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end pt-2">
                      <button
                        onClick={handleUpdateNameservers}
                        disabled={isUpdating || isNameserverLoading}
                        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-paper bg-amber hover:brightness-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber disabled:opacity-50"
                      >
                        {isUpdating ? 'Saving...' : 'Save Custom Nameservers'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-paper-2/60 p-4">
              <div className="flex items-start">
                <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 mr-3 flex-shrink-0" />
                <p className="text-sm text-ink-2">
                  Changing nameservers can take up to 24-48 hours to propagate globally. Your website and email may be inaccessible during this time.
                </p>
              </div>
            </div>
          </div>
        </div>
      </UserLayout>
    </ClientOnly>
  );
}
