'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { safeLocalStorage } from '@/lib/storage';
import { motion } from 'framer-motion';
import { formatIndianDateTime } from '@/lib/dateUtils';
import { performLogout } from '@/lib/logout';
import { confirmDialog } from '@/lib/confirm-dialog';
import {
  Globe, Plus, Edit3, Trash2, Save, X, RefreshCw, Server,
  AlertCircle, Clock, Settings, ExternalLink,
  Database, Copy, Network, CheckCircle2, Sparkles, ArrowRight,
} from 'lucide-react';
import toast from 'react-hot-toast';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, DNSPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import RefreshButton from '@/components/dashboard/RefreshButton';
import { logger } from '@/lib/logger';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface DNSRecord {
  id?: string;
  type: string;
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

interface Domain {
  id: string;
  name: string;
  status: string;
  registrationDate?: string;
  expiryDate?: string;
  resellerClubOrderId?: string;
  resellerClubCustomerId?: string;
  dnsActivated?: boolean;
  dnsActivatedAt?: string;
  dnsProvider?: 'resellerclub' | 'directadmin';
}

const getCookieValue = (name: string): string | null => {
  try {
    if (typeof document === 'undefined') return null;
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop()?.split(';').shift() || null;
  } catch (e) {
    // Access denied to document.cookie
    return null;
  }
  return null;
};

export default function DNSManagementPage() {
  const [user, setUser] = useState<User | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<string>('');
  const [dnsRecords, setDnsRecords] = useState<DNSRecord[]>([]);
  const [nameservers, setNameservers] = useState<string[]>([]);
  const [nameserverMethod, setNameserverMethod] = useState<string>('');
  const [isUpdatingNameservers, setIsUpdatingNameservers] = useState(false);
  const [ns1, setNs1] = useState('');
  const [ns2, setNs2] = useState('');
  const [ns3, setNs3] = useState('');
  const [ns4, setNs4] = useState('');
  const [nameserverPropagationStatus, setNameserverPropagationStatus] = useState<'idle' | 'awaiting' | 'verified' | 'error'>('idle');
  const [nsPropagationAttempts, setNsPropagationAttempts] = useState(0);
  const [targetNs, setTargetNs] = useState<string[]>([]);
  const [isLoadingDomains, setIsLoadingDomains] = useState(true);
  const [checkingServices, setCheckingServices] = useState(true);
  const [hasDomains, setHasDomains] = useState(true); // Default allow until checked
  const [hostedDomains, setHostedDomains] = useState<string[]>([]); // Domains managed by hosting
  const [isHostedDomain, setIsHostedDomain] = useState(false); // Current selected domain is hosted
  const [isDNSLoading, setIsDNSLoading] = useState(false);
  const [isNameserverLoading, setIsNameserverLoading] = useState(false);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const [isUsingMockData, setIsUsingMockData] = useState(false);
  const [dnsPropagationStatus, setDnsPropagationStatus] = useState<'checking' | 'propagating' | 'ready' | 'error'>('checking');
  const [propagationRetryCount, setPropagationRetryCount] = useState(0);
  const [newRecord, setNewRecord] = useState<DNSRecord>({
    type: 'A',
    name: '',
    value: '',
    ttl: 3600,
    priority: undefined,
  });
  const [editingRecord, setEditingRecord] = useState<string | null>(null);
  const [editRecord, setEditRecord] = useState<DNSRecord>({
    type: 'A',
    name: '',
    value: '',
    ttl: 3600,
    priority: undefined,
  });
  const router = useRouter();
  const { data: session, status } = useSession();
  const isInitialized = useRef(false);

  useEffect(() => {
    if (status === 'loading') {
      return;
    }

    if (session?.user) {
      const sUser = session.user as { id?: string; role?: string };
      const userObj = {
        id: sUser.id ?? '',
        email: session.user.email || '',
        firstName: session.user.name?.split(' ')[0] || '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
        role: sUser.role || 'user',
      };

      setUser(prev => {
        if (prev && prev.id === userObj.id && prev.email === userObj.email && prev.role === userObj.role) {
          return prev;
        }
        return userObj;
      });

      if (!isInitialized.current) {
        isInitialized.current = true;
        loadDomains();
      }
      return;
    }

    const token = getCookieValue('token') || safeLocalStorage.getItem('token');
    const userData = safeLocalStorage.getItem('user');

    if (!token || !userData) {
      router.push('/login');
      return;
    }

    try {
      const parsedUser = JSON.parse(userData);
      setUser(prev => {
        if (prev && prev.id === parsedUser.id && prev.email === parsedUser.email) {
          return prev;
        }
        return parsedUser;
      });

      if (!isInitialized.current) {
        isInitialized.current = true;
        loadDomains();
      }
    } catch (error) {
      router.push('/login');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, session, status]); // Removed searchParams dependency to avoid infinite loop

  // Effect to handle URL query parameters
  const searchParams = useSearchParams();

  useEffect(() => {
    if (domains.length > 0) {
      const domainId = searchParams?.get('domainId');
      if (domainId) {
        const domain = domains.find(d => d.id === domainId);
        if (domain) {
          setSelectedDomain(domainId);
        }
      }
    }
  }, [domains, searchParams]);

  // Check service status on mount
  useEffect(() => {
    const checkServices = async () => {
      try {
        const response = await fetch('/api/v1/user/services/status');
        if (response.ok) {
          const data = await response.json();
          setHasDomains(data.hasDomains);
          setHostedDomains(data.hostedDomains || []);

          // If user has no domains but has hosting, they shouldn't be here (unless they are a new user with nothing)
          // But if they are a completely new user (no domains, no hosting), we let them see the page (it will just be empty)
          // The critical case is: Has Hosting = TRUE, Has Domains = FALSE -> Redirect/Show Message
          if (data.hasHosting && !data.hasDomains) {
            setHasDomains(false);
          }
        }
      } catch (error) {
        logger.error("Failed to check services", error);
      } finally {
        setCheckingServices(false);
      }
    };

    if (user) {
      checkServices();
    }
  }, [user]);

  // Load DNS records when domains are loaded and a domain is selected


  const loadDomains = async () => {
    if (domains.length === 0) {
      setIsLoadingDomains(true);
    }
    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      // Use DNS-specific endpoint that only returns registered domains
      const dnsHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) dnsHeaders['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/api/v1/user/domains/dns', {
        headers: dnsHeaders
      });
      if (response.ok) {
        const data = await response.json();
        const validDomains = (data.domains || []).filter((d: Domain) => !d.name.startsWith('hosting-'));
        setDomains(validDomains);
      } else {

        setDomains([]);
      }
    } catch (error) {

      toast.error('Failed to load domains');
    } finally {
      setIsLoadingDomains(false);
    }
  };

  const loadDNSRecords = useCallback(async (domainId: string, isRetry: boolean = false) => {
    if (!domainId || domains.length === 0) return;
    if (!isRetry) {
      setIsDNSLoading(true);
      setDnsPropagationStatus('checking');
    }

    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      const domain = domains.find(d => d.id === domainId);
      if (!domain) {

        setDnsRecords([]);
        return;
      }


      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(`/api/v1/domains/dns?domainName=${encodeURIComponent(domain.name)}`, {
        headers,
      });

      if (response.ok) {
        const data = await response.json();
        setDnsRecords(data.records || []);
        setIsUsingMockData(false);
        setDnsPropagationStatus('ready');
        setPropagationRetryCount(0);
      } else {
        const errorData = await response.json().catch(() => ({}));

        // Check if it's a 404 error (domain not found in ResellerClub)
        if (response.status === 404) {
          setDnsRecords([]);

          // Check if this is a propagation issue
          if (propagationRetryCount < 3) {
            setDnsPropagationStatus('propagating');
            setPropagationRetryCount(prev => prev + 1);

            // Wait and retry after 30 seconds
            setTimeout(() => {
              loadDNSRecords(domainId, true);
            }, 30000);

            toast(`DNS zone is still propagating. Retrying in 30 seconds... (Attempt ${propagationRetryCount + 1}/3)`);
          } else {
            setDnsPropagationStatus('error');
            toast.error('DNS management API is currently unavailable. The domain is registered and DNS management is activated, but the API endpoints are not responding. Please contact support for assistance.');
          }
        } else {
          setDnsRecords([]);
          setDnsPropagationStatus('error');
          toast.error('Failed to load DNS records');
        }
      }
    } catch (error) {

      setDnsPropagationStatus('error');
      toast.error('Failed to load DNS records');
    } finally {
      setIsDNSLoading(false);
    }
  }, [domains, propagationRetryCount]);

  const loadNameservers = useCallback(async (domainId: string, silent: boolean = false) => {
    if (!domainId || domains.length === 0) return;
    if (!silent) setIsNameserverLoading(true);
    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      const domain = domains.find(d => d.id === domainId);
      if (!domain) {

        setNameservers([]);
        return;
      }


      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const response = await fetch(`/api/v1/domains/nameservers?domainName=${encodeURIComponent(domain.name)}`, {
        headers,
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setNameservers(data.nameservers || []);
          setNameserverMethod(data.method || '');

        } else {
          // Handle API success but lookup failure
          setNameservers([]);
          setNameserverMethod('');

          toast.error(data.message || 'Failed to retrieve nameserver information');
        }
      } else {
        const errorData = await response.json().catch(() => ({}));

        setNameservers([]);
        setNameserverMethod('');

        // Show specific error message based on status
        if (response.status === 404) {
          toast.error(errorData.message || 'Nameserver information not available for this domain');
        } else if (response.status === 500) {
          toast.error('Server error occurred while fetching nameserver information');
        } else {
          toast.error(errorData.message || 'Failed to load nameserver information');
        }
      }
    } catch (error) {

      setNameservers([]);
      toast.error('Failed to load nameserver information');
    } finally {
      setIsNameserverLoading(false);
    }
  }, [domains]);


  useEffect(() => {
    if (selectedDomain && domains.length > 0) {
      const domain = domains.find(d => d.id === selectedDomain);
      if (domain) {
        // Check if this domain is hosted
        const isHosted = hostedDomains.includes(domain.name);
        setIsHostedDomain(isHosted);

        loadDNSRecords(selectedDomain);
        loadNameservers(selectedDomain);
      }
    }
  }, [selectedDomain, domains, hostedDomains, loadDNSRecords, loadNameservers]);

  const handleDomainSelect = (domainId: string) => {
    setSelectedDomain(domainId);
  };

  const handleSetDefaultNameservers = async () => {
    if (!selectedDomain) return;
    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;
    const initialNsSnapshot = [...nameservers];
    setIsUpdatingNameservers(true);
    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      const response = await fetch('/api/v1/domains/nameservers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ domainName: domain.name, method: 'default' }),
      });
      if (response.ok) {
        toast.success('Nameservers set to default');
        setNameserverPropagationStatus('awaiting');
        setTargetNs([]);
        setNsPropagationAttempts(0);
        const poll = async () => {
          await loadNameservers(selectedDomain, true);
          const changed = JSON.stringify([...nameservers].sort()) !== JSON.stringify([...initialNsSnapshot].sort());
          if (changed && nameservers.length > 0) {
            setNameserverPropagationStatus('verified');
            return;
          }
          if (nsPropagationAttempts >= 10) {
            setNameserverPropagationStatus('error');
            return;
          }
          setNsPropagationAttempts(prev => prev + 1);
          setTimeout(poll, 30000);
        };
        setTimeout(poll, 1000);
      } else {
        const error = await response.json().catch(() => ({}));
        toast.error(error.error || 'Failed to set default nameservers');
      }
    } catch (e) {
      toast.error('Failed to set default nameservers');
    } finally {
      setIsUpdatingNameservers(false);
    }
  };

  const handleSetCustomNameservers = async () => {
    if (!selectedDomain) return;
    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;
    const list = [
      ns1.trim().toLowerCase(),
      ns2.trim().toLowerCase(),
      ns3.trim().toLowerCase(),
      ns4.trim().toLowerCase()
    ].filter(Boolean);
    const nsRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (list.length < 2 || !list.every(ns => nsRegex.test(ns))) {
      toast.error('Enter at least two valid nameservers');
      return;
    }
    setIsUpdatingNameservers(true);
    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      const response = await fetch('/api/v1/domains/nameservers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ domainName: domain.name, method: 'custom', nameservers: list }),
      });
      if (response.ok) {
        toast.success('Nameservers updated');
        setNameserverPropagationStatus('awaiting');
        setTargetNs(list.map(s => s.toLowerCase()));
        setNsPropagationAttempts(0);
        const poll = async () => {
          await loadNameservers(selectedDomain, true);
          const lower = nameservers.map(s => s.toLowerCase());
          const allPresent = targetNs.every(ns => lower.includes(ns));
          if (allPresent) {
            setNameserverPropagationStatus('verified');
            return;
          }
          if (nsPropagationAttempts >= 10) {
            setNameserverPropagationStatus('error');
            return;
          }
          setNsPropagationAttempts(prev => prev + 1);
          setTimeout(poll, 30000);
        };
        setTimeout(poll, 1000);
      } else {
        const error = await response.json().catch(() => ({}));
        toast.error(error.error || 'Failed to update nameservers');
      }
    } catch (e) {
      toast.error('Failed to update nameservers');
    } finally {
      setIsUpdatingNameservers(false);
    }
  };

  const handleAddRecord = async () => {
    if (!selectedDomain || !newRecord.name || !newRecord.value) {
      toast.error('Please fill in all required fields');
      return;
    }

    // Validate priority for MX and SRV records
    if ((newRecord.type === 'MX' || newRecord.type === 'SRV') && (!newRecord.priority || newRecord.priority < 0)) {
      toast.error('Priority is required for MX and SRV records');
      return;
    }

    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      const domain = domains.find(d => d.id === selectedDomain);
      if (!domain) return;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/api/v1/domains/dns', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          domainName: domain.name,
          recordData: newRecord,
        }),
      });

      if (response.ok) {
        toast.success('DNS record added successfully');
        setNewRecord({ type: 'A', name: '', value: '', ttl: 3600, priority: undefined });
        setShowAddRecord(false);
        loadDNSRecords(selectedDomain);
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to add DNS record');
      }
    } catch (error) {

      toast.error('Failed to add DNS record');
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!selectedDomain) return;

    // Find the record to get its data
    const record = dnsRecords.find(r => r.id === recordId);
    if (!record) {
      toast.error('Record not found');
      return;
    }

    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');
      const domain = domains.find(d => d.id === selectedDomain);
      if (!domain) return;

      const response = await fetch(`/api/v1/domains/dns?domainName=${encodeURIComponent(domain.name)}&recordId=${encodeURIComponent(recordId)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recordData: record,
        }),
      });

      if (response.ok) {
        toast.success('DNS record deleted successfully');
        loadDNSRecords(selectedDomain);
      } else {
        const error = await response.json();
        toast.error(error.error || 'Failed to delete DNS record');
      }
    } catch (error) {

      toast.error('Failed to delete DNS record');
    }
  };

  const handleEditRecord = (record: DNSRecord, index: number) => {
    const uniqueId = `${record.type}-${record.id}-${record.name}-${record.value}`;
    setEditingRecord(uniqueId);
    setEditRecord({
      type: record.type,
      name: record.name,
      value: record.value,
      ttl: record.ttl,
      priority: record.priority,
    });
  };

  const handleSaveEdit = async () => {
    if (!selectedDomain || !editingRecord) return;

    // Validate priority for MX and SRV records
    if ((editRecord.type === 'MX' || editRecord.type === 'SRV') && (!editRecord.priority || editRecord.priority < 0)) {
      toast.error('Priority is required for MX and SRV records');
      return;
    }

    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;

    try {
      const token = getCookieValue('token') || safeLocalStorage.getItem('token');

      // Get the original record to delete - find by unique identifier
      const originalRecord = dnsRecords.find(r => {
        const uniqueId = `${r.type}-${r.id}-${r.name}-${r.value}`;
        return uniqueId === editingRecord;
      });

      if (!originalRecord) {
        toast.error('Record not found');
        return;
      }

      const recordId = originalRecord.id as string;

      // First delete the original record
      const headersDelete: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headersDelete['Authorization'] = `Bearer ${token}`;
      const deleteResponse = await fetch(`/api/v1/domains/dns?domainName=${encodeURIComponent(domain.name)}&recordId=${encodeURIComponent(recordId)}`, {
        method: 'DELETE',
        headers: headersDelete,
        body: JSON.stringify({
          recordData: originalRecord,
        }),
      });

      if (!deleteResponse.ok) {
        const error = await deleteResponse.json();
        toast.error(error.error || 'Failed to delete original record');
        return;
      }

      // Then add the updated record
      const headersAdd: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headersAdd['Authorization'] = `Bearer ${token}`;
      const addResponse = await fetch('/api/v1/domains/dns', {
        method: 'POST',
        headers: headersAdd,
        body: JSON.stringify({
          domainName: domain.name,
          recordData: editRecord,
        }),
      });

      if (addResponse.ok) {
        toast.success('DNS record updated successfully');
        setEditingRecord(null);
        loadDNSRecords(selectedDomain);
      } else {
        const error = await addResponse.json();
        toast.error(error.error || 'Failed to add updated record');
        // Try to restore the original record
        await fetch('/api/v1/domains/dns', {
          method: 'POST',
          headers: headersAdd,
          body: JSON.stringify({
            domainName: domain.name,
            recordData: originalRecord,
          }),
        });
      }
    } catch (error) {

      toast.error('Failed to update DNS record');
    }
  };

  const handleCancelEdit = () => {
    setEditingRecord(null);
    setEditRecord({
      type: 'A',
      name: '',
      value: '',
      ttl: 3600,
      priority: undefined,
    });
  };

  const handleActivateDNS = async (force: boolean = false) => {
    const token = getCookieValue('token') || safeLocalStorage.getItem('token');
    // Allow proceeding even if explicit token is missing (session cookies might handle auth)

    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;

    setIsActivating(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const response = await fetch('/api/v1/domains/activate-dns', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          domainName: domain.name,
          force,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        toast.success(force ? 'DNS services synced successfully!' : 'DNS management activated successfully!');

        // Update the domain in the local state
        setDomains(prevDomains =>
          prevDomains.map(d =>
            d.id === selectedDomain
              ? { ...d, dnsActivated: true, dnsActivatedAt: data.dnsActivatedAt }
              : d
          )
        );

        // Reload domains to get updated data
        loadDomains();
      } else {
        const errorData = await response.json();
        toast.error(errorData.error || 'Failed to activate DNS management');
      }
    } catch (error) {

      toast.error('Failed to activate DNS management');
    } finally {
      setIsActivating(false);
    }
  };

  // Use performLogout directly - always available

  if (!user) {
    return <DashboardLayoutSkeleton><DNSPageSkeleton /></DashboardLayoutSkeleton>;
  }

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={() => performLogout()} hideFloatingButtons={true}>
        {checkingServices ? (
          <DNSPageSkeleton />
        ) : !hasDomains && !isLoadingDomains && domains.length === 0 ? (
          <div className="min-h-screen bg-gray-50 flex flex-col justify-center items-center p-4">
            <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8 text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <Server className="h-8 w-8 text-blue-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-4">DNS Managed via Hosting</h2>
              <p className="text-gray-600 mb-8">
                Since you only have hosting services with us, your DNS is managed directly through your Hosting Control Panel (DirectAdmin).
              </p>
              <button
                onClick={() => router.push('/dashboard/hosting')}
                className="w-full inline-flex justify-center items-center px-6 py-3 border border-transparent text-base font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors"
              >
                <Server className="h-5 w-5 mr-2" />
                Go to Hosting Panel
              </button>
            </div>
          </div>
        ) : isLoadingDomains ? (
          <DNSPageSkeleton />
        ) : (
          <div className="p-6 space-y-6">

            {/* ── Page header ── */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-50 rounded-xl">
                  <Network className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">DNS Management</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Manage nameservers and DNS records for your domains</p>
                </div>
              </div>
              <RefreshButton onClick={() => loadDomains()} isLoading={isLoadingDomains} />
            </div>

            {/* ── Select Domain card ── */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden"
            >
              <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Globe className="h-4 w-4 text-gray-500" />
                  <h3 className="text-sm font-semibold text-gray-900">Select Domain</h3>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
                  <Database className="h-3 w-3" />
                  {domains.length} domain{domains.length !== 1 ? 's' : ''} available
                </span>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Domain Name</label>
                    <select
                      value={selectedDomain}
                      onChange={(e) => handleDomainSelect(e.target.value)}
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                      disabled={isDNSLoading}
                    >
                      <option value="">Choose a domain…</option>
                      {domains.map((domain) => (
                        <option key={domain.id} value={domain.id}>
                          {domain.name} ({domain.status})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Status</label>
                    {(() => {
                      const status = selectedDomain ? domains.find(d => d.id === selectedDomain)?.status : null;
                      const cfg = status === 'active' || status === 'registered'
                        ? { dot: 'bg-green-500', cls: 'bg-green-50 text-green-700 border-green-200' }
                        : status
                          ? { dot: 'bg-amber-500', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                          : { dot: 'bg-gray-400', cls: 'bg-gray-50 text-gray-500 border-gray-200' };
                      return (
                        <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium ${cfg.cls}`}>
                          <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                          {status || 'No domain selected'}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </motion.div>

            {/* ── Hosting-only DNS message ── */}
            {selectedDomain && domains.find(d => d.id === selectedDomain)?.dnsProvider === 'directadmin' && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white border border-gray-200 rounded-2xl shadow-sm p-10 text-center"
              >
                <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-5">
                  <Server className="h-7 w-7 text-blue-600" />
                </div>
                <h2 className="text-lg font-semibold text-gray-900 mb-2">DNS Managed via Hosting</h2>
                <p className="text-sm text-gray-500 mb-6 max-w-lg mx-auto">
                  This domain is included with your hosting package. DNS records are managed directly through your Hosting Control Panel (DirectAdmin).
                </p>
                <button
                  onClick={() => router.push('/dashboard/hosting')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-sm"
                >
                  <Server className="h-4 w-4" />
                  Go to Hosting Panel
                  <ArrowRight className="h-4 w-4" />
                </button>
              </motion.div>
            )}

            {/* ── Nameservers card ── */}
            {selectedDomain && domains.find(d => d.id === selectedDomain)?.dnsProvider !== 'directadmin' && (
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden"
              >
                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Server className="h-4 w-4 text-gray-500 shrink-0" />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-gray-900">Nameservers</h3>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">
                        Current nameservers for <span className="font-mono">{domains.find(d => d.id === selectedDomain)?.name}</span>
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => selectedDomain && loadNameservers(selectedDomain)}
                    disabled={isNameserverLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isNameserverLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>

                {/* Current NS list */}
                <div className="p-6">
                  {isNameserverLoading ? (
                    <div className="flex items-center justify-center py-6 gap-2 text-sm text-gray-500">
                      <div className="animate-spin h-4 w-4 border-2 border-blue-600 border-t-transparent rounded-full" />
                      Loading nameservers…
                    </div>
                  ) : nameservers.length > 0 ? (
                    <div className="space-y-2">
                      {nameservers.map((ns, index) => (
                        <div key={index} className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl hover:border-gray-200 transition-colors">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md bg-white border border-gray-200 text-xs font-semibold text-gray-500">
                              {index + 1}
                            </span>
                            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                            <span className="font-mono text-sm text-gray-800 truncate">{ns}</span>
                          </div>
                          <button
                            onClick={() => { navigator.clipboard.writeText(ns); toast.success('Copied'); }}
                            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-white rounded-md transition-colors shrink-0"
                            title="Copy"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <div className="w-14 h-14 bg-red-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <AlertCircle className="h-7 w-7 text-red-500" />
                      </div>
                      <h4 className="text-sm font-semibold text-gray-900 mb-1.5">Nameserver Information Unavailable</h4>
                      <p className="text-sm text-gray-500 mb-4">Unable to retrieve nameserver information for this domain.</p>
                      <div className="bg-red-50 border border-red-200 rounded-xl p-4 max-w-md mx-auto text-left">
                        <p className="text-xs font-semibold text-red-800 mb-1.5">Possible reasons</p>
                        <ul className="text-xs text-red-700 space-y-1 list-disc list-inside">
                          <li>Domain is not registered or expired</li>
                          <li>WHOIS servers are temporarily unavailable</li>
                          <li>Domain uses private registration</li>
                          <li>Network connectivity issues</li>
                        </ul>
                      </div>
                    </div>
                  )}
                </div>

                {/* Propagation banners */}
                {nameserverPropagationStatus === 'awaiting' && (
                  <div className="mx-6 mb-4 p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 flex items-start gap-2.5">
                    <Clock className="h-4 w-4 mt-0.5 shrink-0" />
                    Awaiting propagation. We'll auto-refresh nameservers — this can take minutes to hours.
                  </div>
                )}
                {nameserverPropagationStatus === 'verified' && (
                  <div className="mx-6 mb-4 p-3.5 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800 flex items-center gap-2.5">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Nameservers propagated successfully.
                  </div>
                )}
                {nameserverPropagationStatus === 'error' && (
                  <div className="mx-6 mb-4 p-3.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800 flex items-start gap-2.5">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    Propagation not confirmed yet. It may take longer — please check again later.
                  </div>
                )}

                {/* Use default action */}
                <div className="px-6 py-4 border-t border-gray-100 bg-gradient-to-br from-blue-50/40 to-indigo-50/40">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-white rounded-lg border border-blue-100 shadow-sm">
                        <Sparkles className="h-4 w-4 text-blue-600" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-900">Use Our Default Nameservers</p>
                        <p className="text-xs text-gray-500 mt-0.5">Quickest setup — points DNS to our managed infrastructure.</p>
                      </div>
                    </div>
                    <button
                      onClick={handleSetDefaultNameservers}
                      disabled={isUpdatingNameservers || !selectedDomain}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-blue-700 bg-white border border-blue-200 rounded-xl hover:bg-blue-50 disabled:opacity-50 transition-colors"
                    >
                      {isUpdatingNameservers ? (
                        <div className="animate-spin h-3.5 w-3.5 border-2 border-blue-600 border-t-transparent rounded-full" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Apply Defaults
                    </button>
                  </div>
                </div>

                {/* Custom NS form */}
                <div className="px-6 py-5 border-t border-gray-100">
                  <div className="flex items-center gap-2.5 mb-4">
                    <Settings className="h-4 w-4 text-gray-500" />
                    <h4 className="text-sm font-semibold text-gray-900">Custom Nameservers</h4>
                    <span className="text-xs text-gray-400 font-normal">Point to another DNS provider</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {[
                      { label: 'Nameserver 1', value: ns1, set: setNs1, optional: false, placeholder: 'ns1.example.com' },
                      { label: 'Nameserver 2', value: ns2, set: setNs2, optional: false, placeholder: 'ns2.example.com' },
                      { label: 'Nameserver 3', value: ns3, set: setNs3, optional: true,  placeholder: 'ns3.example.com' },
                      { label: 'Nameserver 4', value: ns4, set: setNs4, optional: true,  placeholder: 'ns4.example.com' },
                    ].map((f) => (
                      <div key={f.label}>
                        <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">
                          {f.label}{f.optional && <span className="ml-1.5 text-gray-400 font-normal normal-case">(Optional)</span>}
                        </label>
                        <input
                          type="text"
                          value={f.value}
                          onChange={(e) => f.set(e.target.value)}
                          placeholder={f.placeholder}
                          className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/60 flex justify-end">
                  <button
                    onClick={handleSetCustomNameservers}
                    disabled={isUpdatingNameservers || !selectedDomain}
                    className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  >
                    {isUpdatingNameservers ? (
                      <>
                        <div className="animate-spin h-4 w-4 border-2 border-white/40 border-t-white rounded-full" />
                        Saving…
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4" />
                        Save Custom Nameservers
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}

              {/* ── DNS Records card ── */}
              {selectedDomain && domains.find(d => d.id === selectedDomain)?.dnsProvider !== 'directadmin' && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 }}
                  className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden"
                >
                  {/* Card header */}
                  <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <Database className="h-4 w-4 text-gray-500" />
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900">DNS Records</h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Managing DNS for <span className="font-mono">{domains.find(d => d.id === selectedDomain)?.name}</span>
                        </p>
                      </div>
                    </div>
                    {nameserverMethod !== 'custom' && (() => {
                      const domain = domains.find(d => d.id === selectedDomain);
                      const disabled = !!(domain && (!domain?.resellerClubCustomerId || !domain?.dnsActivated));
                      return (
                        <button
                          onClick={() => setShowAddRecord(!showAddRecord)}
                          disabled={disabled}
                          className={`inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl transition-colors shadow-sm w-full sm:w-auto ${
                            disabled
                              ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                              : 'bg-blue-600 text-white hover:bg-blue-700'
                          }`}
                        >
                          <Plus className="h-4 w-4" />
                          Add Record
                        </button>
                      );
                    })()}
                  </div>

                  {/* Status strip */}
                  <div className="p-6 space-y-3">

                    {/* DNS propagation pill */}
                    {dnsPropagationStatus === 'checking' && (
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-xs font-medium text-blue-700">
                        <div className="animate-spin h-3 w-3 border-2 border-blue-600 border-t-transparent rounded-full" />
                        Checking DNS zone status…
                      </div>
                    )}
                    {dnsPropagationStatus === 'propagating' && (
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-xs font-medium text-amber-700">
                        <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                        DNS zone propagating · auto-retry in 30s (Attempt {propagationRetryCount}/3)
                      </div>
                    )}
                    {dnsPropagationStatus === 'ready' && (
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-xs font-medium text-green-700">
                        <CheckCircle2 className="h-3 w-3" />
                        DNS zone is ready and accessible
                      </div>
                    )}
                    {dnsPropagationStatus === 'error' && (
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-xs font-medium text-red-700">
                          <AlertCircle className="h-3 w-3" />
                          DNS zone not accessible
                        </div>
                        <button
                          onClick={() => {
                            setPropagationRetryCount(0);
                            setDnsPropagationStatus('checking');
                            loadDNSRecords(selectedDomain);
                          }}
                          className="px-3 py-1 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-full hover:bg-red-50 transition-colors"
                        >
                          Retry
                        </button>
                      </div>
                    )}

                    {/* Activation state banners */}
                    {selectedDomain && domains.find(d => d.id === selectedDomain) && (() => {
                      const domain = domains.find(d => d.id === selectedDomain);
                      if (!domain?.resellerClubOrderId && !domain?.resellerClubCustomerId) {
                        return (
                          <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                            <p className="text-sm text-amber-800">
                              <strong>DNS Management Not Available.</strong> This domain wasn't registered through us — DNS management is only available for domains registered on our platform.
                            </p>
                          </div>
                        );
                      }
                      if (!domain?.dnsActivated) {
                        return (
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl">
                            <div className="flex items-start gap-3">
                              <div className="p-2 bg-white rounded-lg border border-blue-100 shadow-sm shrink-0">
                                <Sparkles className="h-4 w-4 text-blue-600" />
                              </div>
                              <div>
                                <p className="text-sm font-semibold text-gray-900">Activate DNS Management</p>
                                <p className="text-xs text-gray-600 mt-0.5">Turn on DNS management for this domain to start adding records.</p>
                              </div>
                            </div>
                            <button
                              onClick={() => handleActivateDNS()}
                              disabled={isActivating}
                              className={`inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl transition-colors shadow-sm shrink-0 ${
                                isActivating
                                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                                  : 'bg-blue-600 text-white hover:bg-blue-700'
                              }`}
                            >
                              {isActivating ? (
                                <>
                                  <div className="animate-spin h-4 w-4 border-2 border-white/40 border-t-white rounded-full" />
                                  Activating…
                                </>
                              ) : (
                                <>
                                  <Sparkles className="h-4 w-4" />
                                  Activate
                                </>
                              )}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
                          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-sm text-green-800">
                              <strong>DNS Management Active.</strong> You can manage records below.
                              {domain.dnsActivatedAt && (
                                <span className="block text-xs text-green-700 mt-0.5">
                                  Activated on {formatIndianDateTime(domain.dnsActivatedAt)}
                                </span>
                              )}
                            </p>
                            <button
                              onClick={async () => {
                                const ok = await confirmDialog({
                                  title: 'Re-sync DNS service?',
                                  message: 'This re-syncs the DNS activation with the registrar. Useful if you see "DNS Service not active" errors.',
                                  confirmText: 'Re-sync',
                                });
                                if (ok) handleActivateDNS(true);
                              }}
                              className="text-xs text-blue-600 hover:text-blue-700 hover:underline mt-1 font-medium"
                            >
                              Re-sync DNS service
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Custom NS info banner */}
                  {nameserverMethod === 'custom' && (
                    <div className="mx-6 mb-6 bg-gradient-to-br from-blue-50/70 to-indigo-50/70 border border-blue-200 rounded-2xl p-6 text-center">
                      <div className="inline-flex items-center justify-center w-12 h-12 bg-white rounded-2xl border border-blue-200 shadow-sm mb-3">
                        <ExternalLink className="h-5 w-5 text-blue-600" />
                      </div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-1.5">Managed by External Provider</h3>
                      <p className="text-sm text-gray-600 max-w-md mx-auto">
                        You're using <strong>Custom Nameservers</strong>. DNS records shown below are inactive — manage them at your nameserver provider (Cloudflare, AWS Route 53, etc.).
                      </p>
                    </div>
                  )}

                  {/* Add Record form */}
                  {showAddRecord && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mx-6 mb-6 border border-blue-200 rounded-2xl overflow-hidden shadow-sm"
                    >
                      <div className="px-5 py-3 bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-blue-100 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="p-1.5 bg-blue-600 rounded-lg">
                            <Plus className="h-3.5 w-3.5 text-white" />
                          </div>
                          <h4 className="text-sm font-semibold text-gray-900">Add New DNS Record</h4>
                        </div>
                        <button
                          onClick={() => setShowAddRecord(false)}
                          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-white rounded-lg transition-colors"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="p-6 bg-white">
                        <div className="grid grid-cols-12 gap-4">
                          {/* Type */}
                          <div className="col-span-12 sm:col-span-2">
                            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Type</label>
                            <select
                              value={newRecord.type}
                              onChange={(e) => setNewRecord({ ...newRecord, type: e.target.value, priority: undefined })}
                              className="w-full px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                            >
                              <option value="A">A</option>
                              <option value="AAAA">AAAA</option>
                              <option value="CNAME">CNAME</option>
                              <option value="MX">MX</option>
                              <option value="TXT">TXT</option>
                              <option value="NS">NS</option>
                              <option value="SRV">SRV</option>
                            </select>
                          </div>

                          {/* Name */}
                          <div className="col-span-12 sm:col-span-4">
                            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">
                              Name <span className="ml-1 text-gray-400 font-normal normal-case">(Host)</span>
                            </label>
                            <div className="relative">
                              <input
                                type="text"
                                value={newRecord.name}
                                onChange={(e) => setNewRecord({ ...newRecord, name: e.target.value })}
                                placeholder="@"
                                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow pr-20"
                              />
                              <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                                {newRecord.name === '@' || newRecord.name === '' ? (
                                  <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded">Root</span>
                                ) : (
                                  <span className="text-xs text-gray-400">Subdomain</span>
                                )}
                              </div>
                            </div>
                            <p className="mt-1.5 text-xs text-gray-500 truncate">
                              Resolves to: <span className="font-mono text-gray-700">{newRecord.name === '@' || newRecord.name === '' ? '' : `${newRecord.name}.`}{domains.find(d => d.id === selectedDomain)?.name}</span>
                            </p>
                          </div>

                          {/* Value */}
                          <div className="col-span-12 sm:col-span-4">
                            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">
                              Value <span className="ml-1 text-gray-400 font-normal normal-case">(Target)</span>
                            </label>
                            <input
                              type="text"
                              value={newRecord.value}
                              onChange={(e) => setNewRecord({ ...newRecord, value: e.target.value })}
                              placeholder={
                                newRecord.type === 'A' ? '192.168.1.1' :
                                  newRecord.type === 'CNAME' ? 'example.com' :
                                    'Value'
                              }
                              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                            />
                          </div>

                          {/* TTL */}
                          <div className="col-span-6 sm:col-span-1">
                            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">TTL</label>
                            <input
                              type="number"
                              value={newRecord.ttl}
                              onChange={(e) => setNewRecord({ ...newRecord, ttl: parseInt(e.target.value) || 3600 })}
                              min="300"
                              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                            />
                          </div>

                          {/* Priority (MX/SRV only) */}
                          {(newRecord.type === 'MX' || newRecord.type === 'SRV') && (
                            <div className="col-span-6 sm:col-span-1">
                              <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">
                                Priority <span className="text-red-500 normal-case">*</span>
                              </label>
                              <input
                                type="number"
                                value={newRecord.priority || ''}
                                onChange={(e) => setNewRecord({ ...newRecord, priority: e.target.value ? parseInt(e.target.value) : undefined })}
                                placeholder="10"
                                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                              />
                            </div>
                          )}
                        </div>

                        <div className="mt-6 flex items-center justify-end gap-3 pt-5 border-t border-gray-100">
                          <button
                            onClick={() => setShowAddRecord(false)}
                            className="px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleAddRecord}
                            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
                          >
                            <Save className="h-4 w-4" />
                            Add Record
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* Records list */}
                  {nameserverMethod !== 'custom' && (
                    <div className="border-t border-gray-100">
                      {isDNSLoading ? (
                        <div className="text-center py-12">
                          <div className="animate-spin rounded-full h-7 w-7 border-2 border-blue-600 border-t-transparent mx-auto mb-3" />
                          <p className="text-sm text-gray-500">Loading DNS records…</p>
                        </div>
                      ) : dnsRecords.length > 0 ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-gray-50 border-b border-gray-100">
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Value</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">TTL / Priority</th>
                                <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {dnsRecords.map((record, index) => {
                                const editKey = `${record.type}-${record.id}-${record.name}-${record.value}`;
                                const isEditing = editingRecord === editKey;
                                const typeColors: Record<string, string> = {
                                  A:     'bg-blue-50 text-blue-700 border-blue-200',
                                  AAAA:  'bg-indigo-50 text-indigo-700 border-indigo-200',
                                  CNAME: 'bg-purple-50 text-purple-700 border-purple-200',
                                  MX:    'bg-emerald-50 text-emerald-700 border-emerald-200',
                                  TXT:   'bg-amber-50 text-amber-700 border-amber-200',
                                  NS:    'bg-cyan-50 text-cyan-700 border-cyan-200',
                                  SRV:   'bg-pink-50 text-pink-700 border-pink-200',
                                };
                                const typeCls = typeColors[record.type] ?? 'bg-gray-100 text-gray-700 border-gray-200';
                                return (
                                  <tr key={editKey} className="hover:bg-blue-50/30 transition-colors group">
                                    {/* Type */}
                                    <td className="px-5 py-3.5">
                                      {isEditing ? (
                                        <select
                                          value={editRecord.type}
                                          onChange={(e) => setEditRecord({ ...editRecord, type: e.target.value })}
                                          className="w-full px-2 py-1 border border-gray-200 rounded-lg text-xs font-semibold"
                                        >
                                          <option value="A">A</option>
                                          <option value="AAAA">AAAA</option>
                                          <option value="CNAME">CNAME</option>
                                          <option value="MX">MX</option>
                                          <option value="NS">NS</option>
                                          <option value="TXT">TXT</option>
                                          <option value="SRV">SRV</option>
                                        </select>
                                      ) : (
                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border ${typeCls}`}>
                                          {record.type}
                                        </span>
                                      )}
                                    </td>
                                    {/* Name */}
                                    <td className="px-5 py-3.5 font-mono text-sm text-gray-700">
                                      {isEditing ? (
                                        <input
                                          type="text"
                                          value={editRecord.name}
                                          onChange={(e) => setEditRecord({ ...editRecord, name: e.target.value })}
                                          className="w-full px-2 py-1 border border-gray-200 rounded-lg text-sm font-mono"
                                        />
                                      ) : (
                                        record.name
                                      )}
                                    </td>
                                    {/* Value */}
                                    <td className="px-5 py-3.5 max-w-xs sm:max-w-md lg:max-w-lg">
                                      {isEditing ? (
                                        <input
                                          type="text"
                                          value={editRecord.value}
                                          onChange={(e) => setEditRecord({ ...editRecord, value: e.target.value })}
                                          className="w-full px-2 py-1 border border-gray-200 rounded-lg text-sm font-mono"
                                        />
                                      ) : (
                                        <div className="flex items-center gap-2">
                                          <span className="block truncate font-mono text-sm text-gray-800" title={record.value}>
                                            {record.value}
                                          </span>
                                          <button
                                            onClick={() => {
                                              navigator.clipboard.writeText(record.value);
                                              toast.success('Value copied');
                                            }}
                                            className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-blue-600 transition-all shrink-0"
                                            title="Copy value"
                                          >
                                            <Copy className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
                                      )}
                                    </td>
                                    {/* TTL / Priority */}
                                    <td className="px-5 py-3.5 text-sm text-gray-600">
                                      {isEditing ? (
                                        <div className="flex gap-2">
                                          <input
                                            type="number"
                                            value={editRecord.ttl}
                                            onChange={(e) => setEditRecord({ ...editRecord, ttl: parseInt(e.target.value) || 3600 })}
                                            className="w-20 px-2 py-1 border border-gray-200 rounded-lg text-sm"
                                            min="300"
                                            placeholder="TTL"
                                          />
                                          {(editRecord.type === 'MX' || editRecord.type === 'SRV') && (
                                            <input
                                              type="number"
                                              value={editRecord.priority || 10}
                                              onChange={(e) => setEditRecord({ ...editRecord, priority: parseInt(e.target.value) || 10 })}
                                              className="w-16 px-2 py-1 border border-gray-200 rounded-lg text-sm"
                                              min="0"
                                              max="65535"
                                              placeholder="Pri"
                                            />
                                          )}
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-1.5">
                                          <span className="font-mono">{record.ttl}s</span>
                                          {(record.type === 'MX' || record.type === 'SRV') && record.priority !== undefined && (
                                            <span className="text-xs text-gray-400">· Pri {record.priority}</span>
                                          )}
                                        </div>
                                      )}
                                    </td>
                                    {/* Actions */}
                                    <td className="px-5 py-3.5">
                                      <div className="flex items-center justify-end gap-1.5">
                                        {isEditing ? (
                                          <>
                                            <button
                                              onClick={handleSaveEdit}
                                              className="p-1.5 text-green-600 hover:text-green-700 hover:bg-green-50 rounded-lg transition-colors"
                                              title="Save"
                                            >
                                              <Save className="h-4 w-4" />
                                            </button>
                                            <button
                                              onClick={handleCancelEdit}
                                              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                              title="Cancel"
                                            >
                                              <X className="h-4 w-4" />
                                            </button>
                                          </>
                                        ) : !isHostedDomain ? (
                                          <>
                                            <button
                                              onClick={() => handleEditRecord(record, index)}
                                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                              title="Edit"
                                            >
                                              <Edit3 className="h-4 w-4" />
                                            </button>
                                            <button
                                              onClick={() => record.id ? handleDeleteRecord(record.id) : toast.error('Missing provider record id')}
                                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                              title="Delete"
                                            >
                                              <Trash2 className="h-4 w-4" />
                                            </button>
                                          </>
                                        ) : (
                                          <span className="inline-flex items-center gap-1 text-xs text-gray-400" title="Managed by hosting">
                                            <Server className="h-3.5 w-3.5" />
                                            Hosting
                                          </span>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="text-center py-12 px-6">
                          <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <Server className="h-7 w-7 text-gray-400" />
                          </div>
                          <h4 className="text-sm font-semibold text-gray-900 mb-1.5">No DNS Records Yet</h4>
                          <p className="text-sm text-gray-500 mb-5">Add a record above to get started.</p>

                          {dnsPropagationStatus === 'propagating' && (
                            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl max-w-md mx-auto text-left">
                              <div className="animate-pulse h-4 w-4 mt-0.5 rounded-full bg-amber-500 shrink-0" />
                              <div>
                                <p className="text-sm font-semibold text-amber-900">DNS Zone Propagating</p>
                                <p className="text-xs text-amber-700 mt-0.5">Usually takes 10–30 minutes after activation. Auto-retrying… (Attempt {propagationRetryCount}/3)</p>
                              </div>
                            </div>
                          )}

                          {dnsPropagationStatus === 'error' && (
                            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl max-w-md mx-auto text-left">
                              <AlertCircle className="h-4 w-4 mt-0.5 text-red-600 shrink-0" />
                              <div>
                                <p className="text-sm font-semibold text-red-900">DNS Management Unavailable</p>
                                <p className="text-xs text-red-700 mt-0.5">The DNS zone isn't accessible via API. Please contact support.</p>
                              </div>
                            </div>
                          )}

                          {dnsPropagationStatus === 'checking' && (
                            <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl max-w-md mx-auto text-left">
                              <div className="animate-spin h-4 w-4 mt-0.5 border-2 border-blue-600 border-t-transparent rounded-full shrink-0" />
                              <div>
                                <p className="text-sm font-semibold text-blue-900">Checking DNS Zone</p>
                                <p className="text-xs text-blue-700 mt-0.5">Verifying DNS zone status and accessibility…</p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              )}

              {/* ── Empty states ── */}
              {!selectedDomain && domains.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="bg-white border border-gray-200 rounded-2xl shadow-sm p-12 text-center"
                >
                  <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Globe className="h-7 w-7 text-blue-500" />
                  </div>
                  <h3 className="text-sm font-semibold text-gray-900 mb-1.5">Select a Domain</h3>
                  <p className="text-sm text-gray-500">Choose a domain from the dropdown above to manage its DNS records.</p>
                </motion.div>
              )}

              {domains.length === 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="bg-white border border-gray-200 rounded-2xl shadow-sm p-12 text-center"
                >
                  <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Globe className="h-7 w-7 text-gray-400" />
                  </div>
                  <h3 className="text-sm font-semibold text-gray-900 mb-1.5">No Domains Found</h3>
                  <p className="text-sm text-gray-500">You don't have any domains registered yet.</p>
                </motion.div>
              )}
          </div>
        )}
      </UserLayout>
    </ClientOnly >
  );
}
