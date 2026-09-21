'use client';

// Updated Admin Layout with clean white design and mobile responsiveness
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  LayoutTemplate,
  BarChart3,
  Users,
  FileText,
  Settings,
  LogOut,
  Menu,
  X,
  Shield,
  Package,
  Globe,
  Server,
  AlertTriangle,
  Tag,
  Activity,
  MessageCircle,
  ShieldAlert,
  RefreshCcw,
  CalendarClock,
  Store,
} from 'lucide-react';
import SessionExpiredBanner from '@/components/admin/SessionExpiredBanner';
import { useInsideAdminShell } from '@/components/admin/AdminShellContext';

interface AdminLayoutProps {
  children: React.ReactNode;
  user: {
    firstName: string;
    lastName: string;
    role: string;
  } | null;
  onLogout?: () => void;
}

export default function AdminLayout({ children, user, onLogout }: AdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const insideShell = useInsideAdminShell();

  /**
   * A shell is already mounted above us (app/admin/layout.tsx), so render only
   * the page. Without this, every one of the 25 pages that still wraps itself
   * in <AdminLayout> would draw a SECOND sidebar inside the first.
   *
   * Hooks above this line, never below: an early return that skips a hook
   * changes the hook order between renders and React throws.
   */
  if (insideShell) {
    return <>{children}</>;
  }

  const navigation = [
    { name: 'Dashboard', href: '/admin/dashboard', icon: Activity },
    { name: 'Users', href: '/admin/user-management', icon: Users },
    { name: 'Orders', href: '/admin/order-management', icon: Package },
    { name: 'Invoices', href: '/admin/invoices', icon: FileText },
    { name: 'Payments', href: '/admin/payment-management', icon: FileText },
    { name: 'Pending Domains', href: '/admin/pending-domains', icon: AlertTriangle },
    { name: 'Integration Health', href: '/admin/integration-health', icon: ShieldAlert },
    { name: 'Recurring Charges', href: '/admin/recurring-charges', icon: RefreshCcw },
    { name: 'Renewals', href: '/admin/renewals', icon: CalendarClock },
    { name: 'Support Tickets', href: '/admin/support-tickets', icon: MessageCircle },
    { name: 'Resellers', href: '/admin/resellers', icon: Store },
    { name: 'Hosting', href: '/admin/hosting', icon: Server },
    { name: 'Domains', href: '/admin/domains', icon: Globe },
    { name: 'TLD Pricing', href: '/admin/pricing-management', icon: Tag },
    { name: 'Pages', href: '/admin/page-management', icon: LayoutTemplate },
    { name: 'Analytics', href: '/admin/analytics', icon: BarChart3 },
    { name: 'Settings', href: '/admin/settings', icon: Settings },
  ];

  const isActive = (href: string) => {
    if (href === '/admin/dashboard') {
      return pathname === '/admin/dashboard' || pathname === '/admin';
    }
    if (href === '/admin/domains') {
      return pathname.startsWith('/admin/domains') || pathname.startsWith('/admin/dns-management');
    }
    return pathname.startsWith(href);
  };

  return (
    <div className="h-screen bg-paper-2/40 flex overflow-hidden">
      {/* App-wide session-expiry prompt — fires on any apiClient 401/403 */}
      <SessionExpiredBanner />
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-60 flex flex-col bg-paper border-r border-hairline transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between h-14 px-4 border-b border-hairline flex-shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-md bg-ink text-paper grid place-items-center flex-shrink-0">
              <Shield className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold text-ink truncate">Admin Panel</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden p-1.5 -mr-1 rounded-md text-ink-3 hover:text-ink hover:bg-paper-2 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 min-h-0 overflow-y-auto px-2 py-3">
          <div className="space-y-0.5">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  /* py-2 on mobile, py-1.5 from lg. This element IS the mobile
                     drawer (it is only `lg:static`), so the flat py-1.5 that
                     matches the desktop rail's density shrank every row to a
                     32px touch target on a phone, across 17 rows. The
                     responsive pair keeps the ResellerOS measurement on desktop
                     without making the drawer hard to hit. UserLayout already
                     does this; the two shells now agree. */
                  className={`group flex items-center gap-2.5 px-3 py-2 lg:py-1.5 rounded-md text-sm transition-colors ${isActive(item.href)
                    ? 'bg-amber-soft text-amber-ink font-medium'
                    : 'text-ink-2 hover:bg-paper-2 hover:text-ink'
                    }`}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon className={`h-[15px] w-[15px] flex-shrink-0 transition-colors ${isActive(item.href) ? 'text-amber' : 'text-ink-3 group-hover:text-ink-2'
                    }`} />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </nav>

      </div>

      {/* Main content */}
      <div className="flex-1 lg:ml-0 flex flex-col overflow-hidden">
        {/* Top bar - aligned with sidebar header */}
        <div className="sticky top-0 z-30 h-14 border-b border-hairline bg-paper/95 backdrop-blur-sm flex items-center flex-shrink-0">
          <div className="flex items-center justify-between w-full gap-2 px-3 md:px-4">
            {/* Left side - Mobile menu button */}
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-1.5 -ml-1 text-ink-3 hover:text-ink hover:bg-paper-2 rounded-md transition-colors"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* Right side - Admin user info */}
            <div className="flex items-center gap-2 ml-auto">
              {/* Admin User Info - Right aligned */}
              <div className="flex items-center gap-2.5 border border-hairline bg-paper-2 rounded-md px-2 py-1">
                <div className="h-7 w-7 bg-ink rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-[10px] font-semibold text-paper uppercase">
                    {user?.firstName ? user.firstName.charAt(0) : 'A'}
                    {user?.lastName ? user.lastName.charAt(0) : 'U'}
                  </span>
                </div>
                <div className="hidden sm:block">
                  <p className="text-sm font-medium text-ink leading-tight">
                    {user?.firstName} {user?.lastName}
                  </p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Administrator</p>
                </div>
                {onLogout && (
                  <button
                    onClick={onLogout}
                    className="p-1.5 text-ink-3 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                    title="Logout"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {/* `key={pathname}` is what makes the fade a PAGE transition rather
              than a one-off. A CSS animation runs when the element is created;
              without the key React keeps this wrapper across a client-side
              navigation, so the fade played once on first load and never
              again. Measured before the fix: opacity pinned at 1 and
              getAnimations().length === 0 across an entire nav.

              It also covers the gap. These pages are client components that
              fetch on mount, so `main` briefly holds no text at all — content
              vanished, then popped back in three steps. Fading the new route
              in turns that flash into a reveal. */}
          <div key={pathname} className="animate-in fade-in duration-300 ease-out">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
