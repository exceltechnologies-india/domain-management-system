'use client';

import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { useUser } from '@/hooks/useUser';
import { performLogout } from '@/lib/logout';
import UserLayout from '@/components/user/UserLayout';
import { DashboardLayoutSkeleton, DetailPageSkeleton } from '@/components/skeletons/PageSkeletons';
import ClientOnly from '@/components/ClientOnly';
import { formatIndianDateTime } from '@/lib/dateUtils';
import Link from 'next/link';
import {
  ArrowLeft, CheckCircle2, Clock, XCircle, AlertCircle,
  Globe, Server, ReceiptText, Loader2, RefreshCw,
} from 'lucide-react';
import { motion } from 'framer-motion';

// ── Types ─────────────────────────────────────────────────────────────────────

type DomainStatus = 'pending' | 'processing' | 'registered' | 'failed' | 'cancelled';
type OrderStatus = 'pending' | 'paid' | 'processing' | 'completed' | 'failed' | 'refunded';

interface BookingStep {
  step: string;
  message: string;
  timestamp: string;
  progress: number;
}

interface OrderDomain {
  domainName: string;
  price: number;
  currency: string;
  registrationPeriod: number;
  status: DomainStatus;
  itemType?: 'domain' | 'hosting';
  hostingPlan?: { name: string };
  bookingStatus?: BookingStep[];
  error?: string;
  expiresAt?: string;
  dnsActivated?: boolean;
  periodUnit?: string;
}

interface Order {
  orderId: string;
  purchaseOrderNumber: string;
  amount: number;
  currency: string;
  status: OrderStatus;
  orderType?: string;
  domains: OrderDomain[];
  successfulDomains: string[];
  invoiceNumber?: string;
  /** Set once an invoice has been issued (our engine, or historically Zoho). */
  invoiceProvider?: 'primary' | 'zoho';
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TERMINAL_DOMAIN_STATUSES: DomainStatus[] = ['registered', 'failed', 'cancelled'];

function isOrderTerminal(order: Order): boolean {
  if (['completed', 'failed', 'refunded'].includes(order.status)) return true;
  return order.domains.every((d) => TERMINAL_DOMAIN_STATUSES.includes(d.status));
}

function domainStatusConfig(status: DomainStatus) {
  switch (status) {
    case 'registered':
      return { label: 'Registered', color: 'text-green-700', bg: 'bg-green-100', icon: CheckCircle2 };
    case 'pending':
      return { label: 'Pending', color: 'text-amber-700', bg: 'bg-amber-100', icon: Clock };
    case 'processing':
      return { label: 'Processing', color: 'text-amber-ink', bg: 'bg-indigo-soft', icon: Loader2 };
    case 'failed':
      return { label: 'Failed', color: 'text-red-700', bg: 'bg-red-100', icon: XCircle };
    case 'cancelled':
      return { label: 'Cancelled', color: 'text-ink-2', bg: 'bg-paper-2', icon: XCircle };
  }
}

function orderStatusConfig(status: OrderStatus) {
  switch (status) {
    case 'completed':
      return { label: 'Completed', color: 'text-green-700', bg: 'bg-green-100' };
    case 'paid':
      return { label: 'Paid', color: 'text-amber-ink', bg: 'bg-indigo-soft' };
    case 'processing':
      return { label: 'Processing', color: 'text-amber-ink', bg: 'bg-indigo-soft' };
    case 'pending':
      return { label: 'Pending', color: 'text-amber-700', bg: 'bg-amber-100' };
    case 'failed':
      return { label: 'Failed', color: 'text-red-700', bg: 'bg-red-100' };
    case 'refunded':
      return { label: 'Refunded', color: 'text-ink-2', bg: 'bg-paper-2' };
  }
}

const STEP_LABELS: Record<string, string> = {
  payment_verified: 'Payment verified',
  customer_created: 'Customer account created',
  contact_created: 'Registrant contact created',
  domain_registering: 'Submitting registration request',
  domain_pending: 'Awaiting registry confirmation',
  domain_registered: 'Domain registered',
  domain_failed: 'Registration failed',
  dns_activated: 'DNS management activated',
  hosting_deferred: 'Provisioning queued — waiting for server availability',
};

// ── Domain Card ───────────────────────────────────────────────────────────────

function DomainCard({ domain }: { domain: OrderDomain }) {
  const cfg = domainStatusConfig(domain.status);
  const Icon = cfg.icon;
  const isProcessing = ['pending', 'processing'].includes(domain.status);
  const steps = domain.bookingStatus ?? [];
  const latestStep = steps[steps.length - 1];
  const progress = latestStep?.progress ?? (domain.status === 'registered' ? 100 : 0);

  return (
    <div className="bg-white rounded-xl border border-hairline overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between gap-4 border-b border-hairline">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2 rounded-lg flex-shrink-0 ${cfg.bg}`}>
            {domain.itemType === 'hosting'
              ? <Server className={`h-4 w-4 ${cfg.color}`} />
              : <Globe className={`h-4 w-4 ${cfg.color}`} />}
          </div>
          <div className="min-w-0">
            <p className="font-mono font-semibold text-ink truncate text-sm">
              {domain.itemType === 'hosting' && domain.hostingPlan
                ? domain.hostingPlan.name
                : domain.domainName}
            </p>
            <p className="text-xs text-ink-3">
              {domain.registrationPeriod} {domain.periodUnit === 'months' ? 'month' : 'year'}{domain.registrationPeriod !== 1 ? 's' : ''} ·{' '}
              ₹{domain.price.toFixed(2)}
            </p>
          </div>
        </div>
        <span className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${cfg.bg} ${cfg.color}`}>
          <Icon className={`h-3.5 w-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
          {cfg.label}
        </span>
      </div>

      {/* Progress bar */}
      {progress > 0 && (
        <div className="px-5 pt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-ink-3">Progress</span>
            <span className="text-xs font-medium text-ink-2">{progress}%</span>
          </div>
          <div className="h-1.5 bg-paper-2 rounded-full overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${domain.status === 'failed' ? 'bg-red-400' : 'bg-indigo'}`}
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            />
          </div>
        </div>
      )}

      {/* Timeline steps */}
      {steps.length > 0 && (
        <div className="px-5 py-3 space-y-2">
          {steps.map((step, i) => {
            const isLast = i === steps.length - 1;
            const isFailed = step.step === 'domain_failed';
            return (
              <div key={i} className="flex items-start gap-2.5">
                <div className="flex flex-col items-center flex-shrink-0 pt-0.5">
                  <div className={`h-4 w-4 rounded-full flex items-center justify-center ${
                    isFailed
                      ? 'bg-red-100'
                      : isLast && isProcessing
                      ? 'bg-indigo-soft'
                      : 'bg-green-100'
                  }`}>
                    {isFailed
                      ? <XCircle className="h-3 w-3 text-red-600" />
                      : isLast && isProcessing
                      ? <Loader2 className="h-3 w-3 text-amber-ink animate-spin" />
                      : <CheckCircle2 className="h-3 w-3 text-green-600" />}
                  </div>
                  {i < steps.length - 1 && (
                    <div className="w-px h-4 bg-hairline mt-0.5" />
                  )}
                </div>
                <div className="pb-1 min-w-0">
                  <p className={`text-xs font-medium ${isFailed ? 'text-red-700' : 'text-ink'}`}>
                    {STEP_LABELS[step.step] ?? step.step}
                  </p>
                  {step.message && step.message !== STEP_LABELS[step.step] && (
                    <p className="text-[11px] text-ink-3 leading-tight mt-0.5">{step.message}</p>
                  )}
                  <p className="text-[10px] text-ink-4 mt-0.5">{formatIndianDateTime(new Date(step.timestamp))}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/*
        Customer-facing failure display intentionally relies on the friendly
        copy in the bookingStatus chain (rendered just above). We DO NOT
        surface `domain.error` here because — since dms-00194-mlz — that
        field carries the raw upstream provisioning error (DA license caps,
        ResellerClub error codes, etc.) for admin diagnostics. Customers
        seeing "Cannot Execute Your Request - License is limited to 2
        accounts" is wrong UX — they don't know what DA is. The admin
        order-management page (`/admin/order-management`) reads
        `domain.error` directly and surfaces it to operators.
      */}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrderStatusPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const { user, isLoading: isAuthLoading } = useUser();

  const {
    data,
    isLoading,
    error,
    mutate,
    isValidating,
  } = useSWR<{ order: Order }>(
    user && orderId ? `/api/v1/user/orders/${orderId}` : null,
    fetcher,
    {
      refreshInterval: (data) => {
        if (!data?.order) return 5000;
        return isOrderTerminal(data.order) ? 0 : 5000;
      },
      revalidateOnFocus: true,
    }
  );

  const order = data?.order;

  if (isAuthLoading || isLoading) {
    return <DashboardLayoutSkeleton><DetailPageSkeleton /></DashboardLayoutSkeleton>;
  }

  if (error || !order) {
    return (
      <ClientOnly>
        <UserLayout user={user} onLogout={performLogout}>
          <div className="max-w-2xl mx-auto px-4 py-12 text-center">
            <AlertCircle className="h-12 w-12 text-ink-4 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-ink mb-2">Order not found</h1>
            <p className="text-ink-3 mb-6 text-sm">
              This order may not exist or may belong to a different account.
            </p>
            <Link
              href="/dashboard/orders"
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber hover:brightness-90 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Orders
            </Link>
          </div>
        </UserLayout>
      </ClientOnly>
    );
  }

  const terminal = isOrderTerminal(order);
  const orderCfg = orderStatusConfig(order.status);
  const allRegistered = order.domains.every((d) => d.status === 'registered');
  const failedItems = order.domains.filter((d) => d.status === 'failed');
  const pendingItems = order.domains.filter((d) => d.status === 'pending' || d.status === 'processing');
  const anyFailed = failedItems.length > 0;

  const itemLabel = (d: OrderDomain) =>
    d.itemType === 'hosting' && d.hostingPlan ? d.hostingPlan.name : d.domainName;
  const listLabels = (items: OrderDomain[]) => {
    const names = items.map(itemLabel);
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  };

  return (
    <ClientOnly>
      <UserLayout user={user} onLogout={performLogout}>
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">

          {/* Header */}
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard/orders"
              className="p-2 text-ink-3 hover:text-ink hover:bg-paper-2 rounded-lg transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold text-ink truncate">
                Order{order.purchaseOrderNumber ? ` ${order.purchaseOrderNumber}` : ''}
              </h1>
              <p className="text-xs text-ink-3 font-mono mt-0.5">{order.orderId}</p>
            </div>
            <button
              onClick={() => mutate()}
              disabled={isValidating}
              title="Refresh"
              className="p-2 text-ink-3 hover:text-ink hover:bg-paper-2 rounded-lg transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${isValidating ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Live indicator */}
          {!terminal && (
            <div className="flex items-center gap-2 px-4 py-2.5 bg-indigo-soft border border-indigo/25 rounded-xl text-sm text-amber-ink">
              <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo" />
              </span>
              <span>Live — refreshing every 5 seconds</span>
            </div>
          )}

          {/* Summary card */}
          <div className="bg-white rounded-xl border border-hairline">
            <div className="p-5 border-b border-hairline">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-xs text-ink-3 mb-1">Total charged</p>
                  <p className="text-3xl font-black text-ink">
                    ₹{order.amount.toFixed(2)}
                    <span className="text-sm font-normal text-ink-4 ml-2">{order.currency}</span>
                  </p>
                </div>
                <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide ${orderCfg.bg} ${orderCfg.color}`}>
                  {orderCfg.label}
                </span>
              </div>
            </div>

            <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-xs text-ink-4 mb-0.5">Date</p>
                <p className="font-medium text-ink-2 text-xs">{formatIndianDateTime(new Date(order.createdAt))}</p>
              </div>
              {order.invoiceNumber && (
                <div>
                  <p className="text-xs text-ink-4 mb-0.5">Invoice</p>
                  <div className="flex items-center gap-1.5">
                    <p className="font-mono font-medium text-ink-2 text-xs">{order.invoiceNumber}</p>
                    {order.invoiceProvider && (
                      <Link
                        href={`/dashboard/invoices/${order.orderId}/view`}
                        className="text-amber-ink hover:text-amber-ink"
                        title="View invoice"
                      >
                        <ReceiptText className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </div>
                </div>
              )}
              <div>
                <p className="text-xs text-ink-4 mb-0.5">Items</p>
                <p className="font-medium text-ink-2 text-xs">{order.domains.length} service{order.domains.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
          </div>

          {/* All-success banner */}
          {allRegistered && terminal && (
            <div className="flex items-center gap-3 px-5 py-4 bg-green-50 border border-green-200 rounded-xl text-green-800">
              <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-green-600" />
              <p className="text-sm font-medium">
                All services registered successfully. Your order is complete.
              </p>
            </div>
          )}

          {/* Any-failure banner — scoped to the actually-failed items, with explicit reassurance for anything still pending */}
          {anyFailed && (
            <div className="flex items-start gap-3 px-5 py-4 bg-red-50 border border-red-200 rounded-xl text-red-800">
              <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-600 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">
                  {failedItems.length === 1
                    ? `${listLabels(failedItems)} failed to register.`
                    : `${failedItems.length} services failed to register: ${listLabels(failedItems)}.`}
                </p>
                <p className="text-xs text-red-600 mt-0.5">
                  Our team has been notified. Contact{' '}
                  <a href={`mailto:${process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in'}`} className="underline">
                    support
                  </a>{' '}
                  if not resolved within 24 hours.
                </p>
                {pendingItems.length > 0 && (
                  <p className="text-xs text-ink-2 mt-2">
                    {pendingItems.length === 1
                      ? `${listLabels(pendingItems)} is still registering — that's normal and unaffected by the failure above.`
                      : `${pendingItems.length} other services (${listLabels(pendingItems)}) are still registering — that's normal and unaffected.`}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Per-domain status */}
          <div>
            <h2 className="text-sm font-semibold text-ink-2 mb-3 px-0.5">
              Services ({order.domains.length})
            </h2>
            <div className="space-y-3">
              {order.domains.map((domain, i) => (
                <motion.div
                  key={domain.domainName}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                >
                  <DomainCard domain={domain} />
                </motion.div>
              ))}
            </div>
          </div>

          {/* Footer links */}
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              href="/dashboard/domains"
              className="inline-flex items-center gap-1.5 text-sm text-amber-ink hover:text-indigo-ink font-medium"
            >
              <Globe className="h-4 w-4" />
              View My Domains
            </Link>
            <Link
              href="/dashboard/orders"
              className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink"
            >
              <ReceiptText className="h-4 w-4" />
              All Orders
            </Link>
          </div>
        </div>
      </UserLayout>
    </ClientOnly>
  );
}
