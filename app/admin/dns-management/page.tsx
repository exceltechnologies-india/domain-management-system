'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { motion } from 'framer-motion';
import { toast } from 'react-hot-toast';
import {
  Server,
  Database,
  Settings,
  Edit3,
  Trash2,
  Save,
  X,
  Plus,
  RefreshCw,
  Search,
  Filter,
  Users,
  Globe,
  Shield,
  AlertCircle,
  CheckCircle,
  Clock,
  Copy,
  Loader2,
  ArrowLeft
} from 'lucide-react';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminGenericPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { performLogout } from '@/lib/logout';
import { confirmDialog } from '@/lib/confirm-dialog';
import { apiClient } from '@/lib/api-client';

interface Domain {
  id: string;
  name: string;
  price: number;
  currency: string;
  registrationPeriod: number;
  status: string;
  expiresAt: string;
  resellerClubOrderId?: string;
  resellerClubCustomerId?: string;
  resellerClubContactId?: string;
  dnsActivated?: boolean;
  dnsActivatedAt?: string;
  customerName?: string;
  customerEmail?: string;
  orderId?: string;
}

interface DNSRecord {
  id: string;
  type: string;
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

interface NameserverInfo {
  nameservers: string[];
  method: string;
  whoisData?: {
    registrar: string;
    creationDate: string;
    expirationDate: string;
    lastUpdated: string;
    status: string;
  };
}

// Animated Loading Component
const AnimatedLoading = () => {
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setDots(prev => {
        if (prev === '') return '.';
        if (prev === '.') return '..';
        if (prev === '..') return '...';
        return '';
      });
    }, 500);

    return () => clearInterval(interval);
  }, []);

  return <span className="inline-block w-6 text-left">{dots}</span>;
};

export default function AdminDNSManagementPage() {
  return (
    <React.Suspense fallback={
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
        <p className="text-gray-600">Loading DNS Management...</p>
      </div>
    }>
      <AdminDNSManagementContent />
    </React.Suspense>
  );
}

function AdminDNSManagementContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get('domainId');
  const { data: session, status } = useSession();
  const [user, setUser] = useState<{ firstName: string; lastName: string; role: string } | null>(null);

  // Loading States
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true); // For domains list
  const [isDNSLoading, setIsDNSLoading] = useState(false);
  const [isNameserverLoading, setIsNameserverLoading] = useState(false);

  // Data States
  const [domains, setDomains] = useState<Domain[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<string>('');
  const [dnsRecords, setDnsRecords] = useState<DNSRecord[]>([]);
  const [nameservers, setNameservers] = useState<string[]>([]);

  // Action States
  const [isUpdatingNameservers, setIsUpdatingNameservers] = useState(false);
  const [ns1, setNs1] = useState("");
  const [ns2, setNs2] = useState("");
  const [ns3, setNs3] = useState("");
  const [ns4, setNs4] = useState("");
  const [nsMode, setNsMode] = useState<'default' | 'custom'>('default');
  const [nameserverPropagationStatus, setNameserverPropagationStatus] = useState<'idle' | 'awaiting' | 'verified' | 'error'>('idle');
  const [nsPropagationAttempts, setNsPropagationAttempts] = useState(0);
  const [targetNs, setTargetNs] = useState<string[]>([]);
  const [showAddRecord, setShowAddRecord] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const [dnsPropagationStatus, setDnsPropagationStatus] = useState<'checking' | 'propagating' | 'ready' | 'error'>('checking');
  const [propagationRetryCount, setPropagationRetryCount] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Record Editing/Adding State
  const [newRecord, setNewRecord] = useState<Omit<DNSRecord, 'id'>>({
    type: 'A',
    name: '',
    value: '',
    ttl: 3600,
    priority: undefined,
  });
  const [editingRecord, setEditingRecord] = useState<string | null>(null);
  const [editRecord, setEditRecord] = useState<Omit<DNSRecord, 'id'>>({
    type: 'A',
    name: '',
    value: '',
    ttl: 3600,
    priority: undefined,
  });

  // Auth Effect
  useEffect(() => {
    if (status === 'loading') return;

    if (session?.user) {
      const userObj = {
        firstName: session.user.name?.split(' ')[0] || '',
        lastName: session.user.name?.split(' ').slice(1).join(' ') || '',
        role: session.user.role || 'user',
      };

      if (userObj.role !== 'admin') {
        router.push('/dashboard');
        return;
      }

      setUser(userObj);
      setIsAuthLoading(false);
      void loadAllDomains(false);
      return;
    }

    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  // Load DNS/NS when domain selected
  useEffect(() => {
    if (selectedDomain && domains.length > 0) {
      const domain = domains.find(d => d.id === selectedDomain);
      if (domain) {
        void loadDNSRecords(selectedDomain);
        void loadNameservers(selectedDomain);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains, selectedDomain]);

  // Check URL params for deep linking (e.g. ?domainId=...)
  useEffect(() => {
    if (domains.length > 0 && deepLinkId && !selectedDomain) {
      if (domains.some(d => d.id === deepLinkId)) {
        setSelectedDomain(deepLinkId);
      }
    }
  }, [domains, deepLinkId, selectedDomain]);

  const loadAllDomains = async (refresh: boolean = true) => {
    if (refresh) setIsDataLoading(true);
    const result = await apiClient.get<{ domains?: Domain[] }>('/api/v1/admin/domains');
    if (result.ok) {
      setDomains(result.data.domains || []);
    } else {
      toast.error('Failed to load domains');
    }
    setIsDataLoading(false);
  };

  const loadDNSRecords = async (domainId: string, isRetry: boolean = false) => {
    if (!domainId || domains.length === 0) return;
    setIsDNSLoading(true);

    if (!isRetry) {
      setDnsPropagationStatus('checking');
    }

    const domain = domains.find(d => d.id === domainId);
    if (!domain) {
      setDnsRecords([]);
      setIsDNSLoading(false);
      return;
    }

    const result = await apiClient.get<{ records?: DNSRecord[] }>(`/api/v1/admin/domains/dns?domainName=${encodeURIComponent(domain.name)}`);

    if (result.ok) {
      setDnsRecords(result.data.records || []);
      setDnsPropagationStatus('ready');
      setPropagationRetryCount(0);
    } else if (result.error.status === 404) {
      setDnsRecords([]);
      if (propagationRetryCount < 3) {
        setDnsPropagationStatus('propagating');
        setPropagationRetryCount(prev => prev + 1);
        setTimeout(() => {
          void loadDNSRecords(domainId, true);
        }, 30000);
        toast(`DNS zone is still propagating. Retrying in 30 seconds... (Attempt ${propagationRetryCount + 1}/3)`);
      } else {
        setDnsPropagationStatus('error');
        toast.error('DNS management API is currently unavailable.');
      }
    } else {
      setDnsRecords([]);
      setDnsPropagationStatus('error');
      toast.error('Failed to load DNS records');
    }
    setIsDNSLoading(false);
  };

  const loadNameservers = async (domainId: string) => {
    if (!domainId || domains.length === 0) return;
    setIsNameserverLoading(true);
    const domain = domains.find(d => d.id === domainId);
    if (!domain) {
      setIsNameserverLoading(false);
      return;
    }

    const result = await apiClient.get<{ nameservers?: string[] }>(`/api/v1/domains/nameservers?domainName=${encodeURIComponent(domain.name)}`);

    if (result.ok) {
      const loadedNameservers = result.data.nameservers || [];
      setNameservers(loadedNameservers);

      // Auto-detect mode
      const isDefaultNs = loadedNameservers.every((ns: string) =>
        ns.toLowerCase().includes('deepak1299294') && ns.toLowerCase().includes('orderbox-dns.com')
      );

      if (isDefaultNs && loadedNameservers.length > 0) {
        setNsMode('default');
        setNs1(''); setNs2(''); setNs3(''); setNs4('');
      } else if (loadedNameservers.length > 0) {
        setNsMode('custom');
        setNs1(loadedNameservers[0] || '');
        setNs2(loadedNameservers[1] || '');
        setNs3(loadedNameservers[2] || '');
        setNs4(loadedNameservers[3] || '');
      }
    } else {
      setNameservers([]);
    }
    setIsNameserverLoading(false);
  };

  const handleDomainClick = (domainId: string) => {
    setSelectedDomain(domainId);
  };

  const handleSetDefaultNameservers = async () => {
    if (!selectedDomain) return;
    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;

    setIsUpdatingNameservers(true);
    const result = await apiClient.post('/api/v1/admin/domains/nameservers', { domainName: domain.name, method: 'default' });
    if (result.ok) {
      toast.success('Nameservers set to default');
      setNameserverPropagationStatus('awaiting');
      setTargetNs([]);
      setNsPropagationAttempts(0);
      // Start polling
      const poll = async () => {
        await loadNameservers(selectedDomain);
        // Check if changed
        // This is a simplistic check, real world might need better diffing
        // But for now we rely on the logic passing
      };
      setTimeout(poll, 1000);
    } else {
      toast.error(result.error.message || 'Failed to set default nameservers');
    }
    setIsUpdatingNameservers(false);
  };

  const handleSetCustomNameservers = async () => {
    if (!selectedDomain) return;
    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;
    const list = [ns1, ns2, ns3, ns4].map(s => s.trim().toLowerCase()).filter(Boolean);
    const nsRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

    if (list.length < 2 || !list.every(ns => nsRegex.test(ns))) {
      toast.error('Enter at least two valid nameservers');
      return;
    }

    setIsUpdatingNameservers(true);
    const result = await apiClient.post('/api/v1/admin/domains/nameservers', { domainName: domain.name, method: 'custom', nameservers: list });
    if (result.ok) {
      toast.success('Nameservers updated');
      setNameserverPropagationStatus('awaiting');
      setTargetNs(list);
      setNsPropagationAttempts(0);
    } else {
      toast.error('Failed to update nameservers');
    }
    setIsUpdatingNameservers(false);
  };

  const handleActivateDNS = async (domainId: string, force: boolean = false) => {
    const domain = domains.find(d => d.id === domainId);
    if (!domain) return;

    setIsActivating(true);
    const result = await apiClient.post('/api/v1/admin/domains/activate-dns', { domainName: domain.name, force });
    if (result.ok) {
      toast.success(force ? 'DNS services synced' : 'DNS management activated');
      void loadAllDomains();
      if (selectedDomain === domainId) void loadDNSRecords(domainId);
    } else {
      toast.error('Failed to activate DNS management');
    }
    setIsActivating(false);
  };

  const handleAddRecord = async () => {
    if (!selectedDomain) {
      toast.error('Please select a domain first');
      return;
    }
    if (!newRecord.name || !newRecord.value) {
      toast.error('Please fill in required fields');
      return;
    }
    if ((newRecord.type === 'MX' || newRecord.type === 'SRV') && (newRecord.priority === undefined || newRecord.priority < 0)) {
      toast.error('Priority is required for MX/SRV');
      return;
    }

    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;

    const result = await apiClient.post('/api/v1/admin/domains/dns', { domainName: domain.name, recordData: newRecord });
    if (result.ok) {
      toast.success('DNS record added');
      setNewRecord({ type: 'A', name: '', value: '', ttl: 3600, priority: undefined });
      setShowAddRecord(false);
      void loadDNSRecords(selectedDomain);
    } else {
      toast.error(result.error.status === 0 ? 'Failed to add DNS record' : result.error.message || 'Failed to add record');
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!selectedDomain) return;
    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;

    const record = dnsRecords.find(r => r.id === recordId);
    if (!record) return;

    const result = await apiClient.delete(`/api/v1/admin/domains/dns?domainName=${encodeURIComponent(domain.name)}&recordId=${encodeURIComponent(recordId)}`, { recordData: record });
    if (result.ok) {
      toast.success('DNS record deleted');
      void loadDNSRecords(selectedDomain);
    } else {
      toast.error('Failed to delete DNS record');
    }
  };

  const handleEditRecord = (record: DNSRecord) => {
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
    if ((editRecord.type === 'MX' || editRecord.type === 'SRV') && (editRecord.priority === undefined || editRecord.priority < 0)) {
      toast.error('Priority is required');
      return;
    }

    const domain = domains.find(d => d.id === selectedDomain);
    if (!domain) return;

    const originalRecord = dnsRecords.find(r => {
      const uniqueId = `${r.type}-${r.id}-${r.name}-${r.value}`;
      return uniqueId === editingRecord;
    });

    if (!originalRecord) return;

    // Delete old
    const deleteResult = await apiClient.delete(`/api/v1/admin/domains/dns?domainName=${encodeURIComponent(domain.name)}&recordId=${encodeURIComponent(originalRecord.id)}`, { recordData: originalRecord });
    if (!deleteResult.ok) {
      toast.error('Failed to update record (delete step)');
      return;
    }

    // Add new
    const addResult = await apiClient.post('/api/v1/admin/domains/dns', { domainName: domain.name, recordData: editRecord });
    if (addResult.ok) {
      toast.success('DNS record updated');
      setEditingRecord(null);
      void loadDNSRecords(selectedDomain);
    } else {
      toast.error('Failed to update record (add step)');
    }
  };

  const handleCancelEdit = () => {
    setEditingRecord(null);
    setEditRecord({ type: 'A', name: '', value: '', ttl: 3600, priority: undefined });
  };

  const filteredDomains = domains.filter(domain => {
    if (domain.name.startsWith('hosting-')) return false;
    const matchesSearch = domain.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      domain.customerName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      domain.customerEmail?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' ||
      (statusFilter === 'dns_activated' && domain.dnsActivated) ||
      (statusFilter === 'not_activated' && !domain.dnsActivated) ||
      (statusFilter === 'registered' && domain.status === 'registered');
    return matchesSearch && matchesStatus;
  });

  if (isAuthLoading) {
    return <AdminLayoutSkeleton><AdminGenericPageSkeleton /></AdminLayoutSkeleton>;
  }

  return (
    <AdminLayout user={user} onLogout={performLogout}>
      <div className="p-3 sm:p-4 lg:p-6">
        {/* Header */}
        <div className="mb-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-4">
              {deepLinkId && (
                <button
                  onClick={() => router.push('/admin/domains')}
                  className="p-2.5 bg-white border border-gray-200 rounded-xl text-gray-600 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all shadow-sm"
                  title="Back to Domains"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
              )}
              <div>
                <h1 className="text-2xl font-bold text-gray-900">DNS Management</h1>
                <p className="text-sm text-gray-600 mt-1">
                  {deepLinkId ? 'Manage records for ' + (domains.find(d => d.id === deepLinkId)?.name || 'selected domain') : 'Manage DNS records and nameservers for all domains'}
                </p>
              </div>
            </div>
            <RefreshButton
              onClick={() => loadAllDomains(true)}
              isLoading={isDataLoading}
              title="Refresh Data"
              className="w-full sm:w-auto shadow-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 lg:gap-6">
          {/* Domains List (Sidebar) */}
          {!deepLinkId && (
            <div className="xl:col-span-1">
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-[calc(100vh-14rem)] sticky top-6">
                <div className="p-4 border-b border-gray-200 bg-gray-50/50 rounded-t-xl">
                  <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    <Database className="h-4 w-4 text-gray-500" />
                    Domains
                  </h3>
                  <div className="space-y-3">
                    <div className="relative">
                      <Search className="h-4 w-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                      />
                    </div>
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                      <option value="all">All Statuses</option>
                      <option value="dns_activated">Active DNS</option>
                      <option value="not_activated">Setup Required</option>
                      <option value="registered">Registered</option>
                    </select>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
                  {isDataLoading ? (
                    <div className="space-y-3">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <div key={i} className="h-20 bg-gray-100 rounded-lg animate-pulse"></div>
                      ))}
                    </div>
                  ) : filteredDomains.length === 0 ? (
                    <div className="text-center py-8 px-4">
                      <p className="text-sm text-gray-500">No domains found matching your criteria</p>
                    </div>
                  ) : (
                    filteredDomains.map((domain) => (
                      <div
                        key={domain.id}
                        className={`p-3 rounded-lg border transition-all duration-200 cursor-pointer group ${selectedDomain === domain.id
                          ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500 shadow-sm'
                          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50 hover:shadow-sm'
                          }`}
                        onClick={() => handleDomainClick(domain.id)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                              <p className={`text-sm font-semibold truncate ${selectedDomain === domain.id ? 'text-blue-700' : 'text-gray-900'}`}>
                                {domain.name}
                              </p>
                              {domain.dnsActivated && (
                                <div className="flex items-center gap-1.5 bg-green-100 px-2 py-0.5 rounded-full">
                                  <CheckCircle className="h-3 w-3 text-green-600 flex-shrink-0" />
                                  <span className="text-[10px] font-bold text-green-700 uppercase tracking-wide">Active</span>
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-2 mb-1.5">
                              <Users className="h-3 w-3 text-gray-400" />
                              <p className="text-xs text-gray-600 truncate">
                                {domain.customerName}
                              </p>
                            </div>

                            <div className="flex items-center justify-between">
                              <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">
                                {domain.orderId}
                              </span>
                              {domain.dnsActivated && selectedDomain === domain.id && (
                                <button
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const ok = await confirmDialog({
                                      title: 'Re-sync DNS activation?',
                                      message: 'This will refresh the activation status from the registrar.',
                                      confirmText: 'Re-sync',
                                    });
                                    if (ok) void handleActivateDNS(domain.id, true);
                                  }}
                                  className="text-[10px] font-medium text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
                                  title="Re-sync DNS status"
                                >
                                  <RefreshCw className="h-3 w-3" />
                                  Sync
                                </button>
                              )}
                            </div>
                          </div>
                        </div>

                        {!domain.dnsActivated && (
                          <div className="mt-3 pt-3 border-t border-gray-200/50">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleActivateDNS(domain.id);
                              }}
                              disabled={isActivating}
                              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-blue-600 text-blue-600 rounded-md hover:bg-blue-600 hover:text-white transition-all disabled:opacity-50"
                            >
                              {isActivating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                              Enable DNS
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

          )}

          {/* Main Content Area */}
          <div className={deepLinkId ? "xl:col-span-5" : "xl:col-span-4"}>
            {/* States in priority order:
                1. isDataLoading → "Loading Domains…" spinner
                2. deepLinkId is set but domain not in list → "Domain not found"
                3. deepLinkId is set, domain exists, but selectedDomain not yet
                   resolved → "Opening Domain…" spinner (covers the brief
                   render gap before the deep-link effect fires)
                4. selectedDomain set → real domain UI
                5. otherwise → "Select a Domain" placeholder */}
            {isDataLoading || (deepLinkId && !selectedDomain) ? (
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center h-[600px] flex flex-col items-center justify-center">
                {!isDataLoading && deepLinkId && !domains.some(d => d.id === deepLinkId) ? (
                  <>
                    <div className="h-16 w-16 rounded-2xl bg-red-50 flex items-center justify-center mb-5">
                      <AlertCircle className="h-8 w-8 text-red-500" />
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-1.5">Domain not found</h3>
                    <p className="text-sm text-gray-500 max-w-sm mb-5">
                      The domain you're trying to open doesn't exist or you no longer have access to it.
                    </p>
                    <button
                      onClick={() => router.push('/admin/domains')}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      Back to Domains
                    </button>
                  </>
                ) : (
                  <>
                    <div className="relative mb-5">
                      <div className="h-16 w-16 rounded-2xl bg-blue-50 flex items-center justify-center">
                        <Globe className="h-8 w-8 text-blue-400" />
                      </div>
                      <div className="absolute -bottom-1 -right-1 h-6 w-6 bg-white rounded-full flex items-center justify-center shadow-sm border border-gray-100">
                        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                      </div>
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-1.5">
                      {deepLinkId ? "Opening Domain…" : "Loading Domains…"}
                    </h3>
                    <p className="text-sm text-gray-500 max-w-sm">
                      {deepLinkId
                        ? "Fetching DNS records and nameservers for the selected domain."
                        : "Pulling your domain list. This should only take a moment."}
                    </p>
                  </>
                )}
              </div>
            ) : selectedDomain ? (
              <div className="space-y-5">
                {/* ── Nameservers card ── */}
                <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5">
                      <Server className="h-4 w-4 text-gray-500" />
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900">Nameservers</h3>
                        <p className="text-xs text-gray-500 mt-0.5">Configure where your domain points to</p>
                      </div>
                    </div>
                    <button
                      onClick={() => loadNameservers(selectedDomain)}
                      disabled={isNameserverLoading}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isNameserverLoading ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>

                  <div className="p-6">
                    {isNameserverLoading ? (
                      <div className="flex flex-col items-center justify-center py-10">
                        <Loader2 className="animate-spin h-7 w-7 text-blue-600 mb-3" />
                        <span className="text-sm text-gray-500 font-medium">Fetching nameservers…</span>
                      </div>
                    ) : (
                      <>
                        {/* Current NS list */}
                        {nameservers.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-6">
                            {nameservers.map((ns, index) => (
                              <div key={index} className="flex items-center gap-3 px-3.5 py-2.5 bg-gray-50 border border-gray-100 rounded-xl hover:border-gray-200 transition-colors">
                                <span className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md bg-white border border-gray-200 text-xs font-semibold text-gray-500">
                                  {index + 1}
                                </span>
                                <span className="text-gray-800 font-mono text-sm flex-1 truncate">{ns}</span>
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)] flex-shrink-0" />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-center py-8 bg-gray-50 border border-gray-100 border-dashed rounded-xl mb-6">
                            <AlertCircle className="h-7 w-7 text-gray-400 mx-auto mb-2" />
                            <p className="text-sm text-gray-700 font-medium">No nameservers found</p>
                          </div>
                        )}

                        {/* Default vs Custom radio cards */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
                          <label className={`relative flex items-start gap-3 p-4 cursor-pointer rounded-xl border-2 transition-all ${nsMode === 'default' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 hover:bg-gray-50'}`}>
                            <input type="radio" name="nsMode" value="default" checked={nsMode === 'default'} onChange={() => setNsMode('default')} className="sr-only" />
                            <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${nsMode === 'default' ? 'border-blue-600 bg-blue-600' : 'border-gray-300 bg-white'}`}>
                              {nsMode === 'default' && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-900">Default Nameservers</p>
                              <p className="text-xs text-gray-500 mt-0.5">Use our secure, managed DNS infrastructure.</p>
                            </div>
                          </label>

                          <label className={`relative flex items-start gap-3 p-4 cursor-pointer rounded-xl border-2 transition-all ${nsMode === 'custom' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 hover:bg-gray-50'}`}>
                            <input type="radio" name="nsMode" value="custom" checked={nsMode === 'custom'} onChange={() => setNsMode('custom')} className="sr-only" />
                            <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${nsMode === 'custom' ? 'border-blue-600 bg-blue-600' : 'border-gray-300 bg-white'}`}>
                              {nsMode === 'custom' && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-900">Custom Nameservers</p>
                              <p className="text-xs text-gray-500 mt-0.5">Point your domain to an external provider.</p>
                            </div>
                          </label>
                        </div>

                        {/* Apply panel — default mode */}
                        {nsMode === 'default' ? (
                          <div className="flex items-center justify-between gap-4 p-4 bg-gradient-to-br from-blue-50/40 to-indigo-50/40 border border-blue-100 rounded-xl flex-wrap">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="p-2 bg-white rounded-lg border border-blue-100 shadow-sm shrink-0">
                                <CheckCircle className="h-4 w-4 text-green-500" />
                              </div>
                              <div>
                                <p className="text-sm font-semibold text-gray-900">Ready to Apply</p>
                                <p className="text-xs text-gray-500 mt-0.5">This will configure your domain to use our nameservers.</p>
                              </div>
                            </div>
                            <button
                              onClick={handleSetDefaultNameservers}
                              disabled={isUpdatingNameservers}
                              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors disabled:opacity-50 shadow-sm shrink-0"
                            >
                              {isUpdatingNameservers ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <CheckCircle className="h-4 w-4" />
                              )}
                              Apply Default Nameservers
                            </button>
                          </div>
                        ) : (
                          /* Custom NS form */
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {[
                                { v: ns1, set: setNs1, label: 'Nameserver 1', placeholder: 'ns1.example.com',         optional: false },
                                { v: ns2, set: setNs2, label: 'Nameserver 2', placeholder: 'ns2.example.com',         optional: false },
                                { v: ns3, set: setNs3, label: 'Nameserver 3', placeholder: 'ns3.example.com',         optional: true },
                                { v: ns4, set: setNs4, label: 'Nameserver 4', placeholder: 'ns4.example.com',         optional: true },
                              ].map((f) => (
                                <div key={f.label}>
                                  <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">
                                    {f.label}{f.optional && <span className="ml-1 text-gray-400 font-normal normal-case">(Optional)</span>}
                                  </label>
                                  <input
                                    type="text"
                                    value={f.v}
                                    onChange={(e) => f.set(e.target.value)}
                                    placeholder={f.placeholder}
                                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
                                  />
                                </div>
                              ))}
                            </div>
                            <div className="flex justify-end pt-1">
                              <button
                                onClick={handleSetCustomNameservers}
                                disabled={isUpdatingNameservers}
                                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors disabled:opacity-50 shadow-sm"
                              >
                                {isUpdatingNameservers ? (
                                  <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
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
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* ── DNS Zone Records card ── */}
                <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5">
                      <Database className="h-4 w-4 text-gray-500" />
                      <h3 className="text-sm font-semibold text-gray-900">DNS Zone Records</h3>
                      {dnsRecords.length > 0 && (
                        <span className="inline-flex items-center text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
                          {dnsRecords.length}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => setShowAddRecord(true)}
                      disabled={nsMode === 'custom' || dnsPropagationStatus !== 'ready'}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add Record
                    </button>
                  </div>

                  {nsMode === 'custom' ? (
                    <div className="py-16 px-6 text-center">
                      <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <Globe className="h-7 w-7 text-blue-500" />
                      </div>
                      <h3 className="text-sm font-semibold text-gray-900 mb-1.5">Managed by External Provider</h3>
                      <p className="text-sm text-gray-500 max-w-sm mx-auto">Switch to Default Nameservers to manage DNS records here.</p>
                    </div>
                  ) : (
                    <>
                      {/* Propagation Status Banner */}
                      {dnsPropagationStatus !== 'ready' && (
                        <div className="px-6 pt-4">
                          {dnsPropagationStatus === 'checking' && (
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-xs font-medium text-blue-700">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Verifying DNS zone…
                            </div>
                          )}
                          {dnsPropagationStatus === 'propagating' && (
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-xs font-medium text-amber-700">
                              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                              Propagation in progress…
                            </div>
                          )}
                          {dnsPropagationStatus === 'error' && (
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-xs font-medium text-red-700">
                              <AlertCircle className="h-3 w-3" />
                              DNS zone error
                            </div>
                          )}
                        </div>
                      )}

                      {isDNSLoading ? (
                        <div className="py-16 flex flex-col items-center justify-center">
                          <Loader2 className="h-7 w-7 text-blue-600 animate-spin mb-3" />
                          <p className="text-sm text-gray-500">Loading DNS records…</p>
                        </div>
                      ) : dnsRecords.length === 0 ? (
                        <div className="py-16 px-6 text-center">
                          <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <Database className="h-7 w-7 text-gray-400" />
                          </div>
                          <h3 className="text-sm font-semibold text-gray-900 mb-1.5">No DNS records yet</h3>
                          <p className="text-sm text-gray-500">Add a record above to get started.</p>
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-gray-50/60 border-b border-gray-100">
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Type</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Name</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider min-w-[200px]">Value</th>
                                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">TTL</th>
                                <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {dnsRecords.map((record) => {
                                const uniqueId = `${record.type}-${record.id}-${record.name}-${record.value}`;
                                const isEditing = editingRecord === uniqueId;
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
                                  <tr key={uniqueId} className="hover:bg-blue-50/30 transition-colors group">
                                    {isEditing ? (
                                      <>
                                        <td className="px-5 py-3"><input className="w-20 px-2 py-1.5 border border-gray-200 rounded-lg text-xs font-semibold" value={editRecord.type} onChange={e => setEditRecord({ ...editRecord, type: e.target.value })} /></td>
                                        <td className="px-5 py-3"><input className="w-32 md:w-full px-2 py-1.5 border border-gray-200 rounded-lg text-sm font-mono" value={editRecord.name} onChange={e => setEditRecord({ ...editRecord, name: e.target.value })} /></td>
                                        <td className="px-5 py-3"><input className="w-full min-w-[150px] px-2 py-1.5 border border-gray-200 rounded-lg text-sm font-mono" value={editRecord.value} onChange={e => setEditRecord({ ...editRecord, value: e.target.value })} /></td>
                                        <td className="px-5 py-3"><input className="w-20 px-2 py-1.5 border border-gray-200 rounded-lg text-sm" type="number" value={editRecord.ttl} onChange={e => setEditRecord({ ...editRecord, ttl: parseInt(e.target.value) })} /></td>
                                        <td className="px-5 py-3 text-right whitespace-nowrap">
                                          <div className="inline-flex items-center gap-1.5">
                                            <button onClick={handleSaveEdit} title="Save" className="p-1.5 text-green-600 hover:text-green-700 hover:bg-green-50 rounded-lg transition-colors">
                                              <Save className="h-4 w-4" />
                                            </button>
                                            <button onClick={handleCancelEdit} title="Cancel" className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
                                              <X className="h-4 w-4" />
                                            </button>
                                          </div>
                                        </td>
                                      </>
                                    ) : (
                                      <>
                                        <td className="px-5 py-3.5 whitespace-nowrap">
                                          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold border ${typeCls}`}>
                                            {record.type}
                                          </span>
                                        </td>
                                        <td className="px-5 py-3.5 text-sm font-mono text-gray-700 whitespace-nowrap">{record.name}</td>
                                        <td className="px-5 py-3.5 text-sm text-gray-800 font-mono break-all min-w-[200px]">{record.value}</td>
                                        <td className="px-5 py-3.5 text-sm text-gray-600 whitespace-nowrap font-mono">{record.ttl}s</td>
                                        <td className="px-5 py-3.5 text-right whitespace-nowrap">
                                          <div className="inline-flex items-center gap-1.5">
                                            <button onClick={() => handleEditRecord(record)} title="Edit" className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                                              <Edit3 className="h-4 w-4" />
                                            </button>
                                            <button onClick={() => handleDeleteRecord(record.id)} title="Delete" className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                                              <Trash2 className="h-4 w-4" />
                                            </button>
                                          </div>
                                        </td>
                                      </>
                                    )}
                                  </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                </div>
              </div>
            ) : (
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-8 text-center h-[600px] flex flex-col items-center justify-center">
                <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <Globe className="h-7 w-7 text-blue-500" />
                </div>
                <h3 className="text-sm font-semibold text-gray-900 mb-1.5">Select a Domain</h3>
                <p className="text-sm text-gray-500">Choose a domain from the sidebar to manage DNS.</p>
              </div>
            )}
          </div>
        </div>

        {/* Add Record Modal */}
        {showAddRecord && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
              <div className="p-4 border-b flex justify-between items-center">
                <h3 className="font-bold text-lg">Add DNS Record</h3>
                <button onClick={() => setShowAddRecord(false)}><X className="h-5 w-5 text-gray-400" /></button>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Type</label>
                  <select value={newRecord.type} onChange={e => setNewRecord({ ...newRecord, type: e.target.value })} className="w-full border rounded-lg px-3 py-2">
                    <option value="A">A</option>
                    <option value="AAAA">AAAA</option>
                    <option value="CNAME">CNAME</option>
                    <option value="MX">MX</option>
                    <option value="TXT">TXT</option>
                    <option value="SRV">SRV</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Name</label>
                  <input type="text" value={newRecord.name} onChange={e => setNewRecord({ ...newRecord, name: e.target.value })} placeholder="@ or www" className="w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Value</label>
                  <input type="text" value={newRecord.value} onChange={e => setNewRecord({ ...newRecord, value: e.target.value })} placeholder="e.g. 1.2.3.4" className="w-full border rounded-lg px-3 py-2" />
                </div>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="block text-sm font-medium mb-1">TTL</label>
                    <input type="number" value={newRecord.ttl} onChange={e => setNewRecord({ ...newRecord, ttl: parseInt(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
                  </div>
                  {['MX', 'SRV'].includes(newRecord.type) && (
                    <div className="flex-1">
                      <label className="block text-sm font-medium mb-1">Priority</label>
                      <input type="number" value={newRecord.priority || 0} onChange={e => setNewRecord({ ...newRecord, priority: parseInt(e.target.value) })} className="w-full border rounded-lg px-3 py-2" />
                    </div>
                  )}
                </div>
                <button onClick={handleAddRecord} className="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 mt-2">Add Record</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
