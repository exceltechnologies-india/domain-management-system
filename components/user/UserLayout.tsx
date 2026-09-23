'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  Globe,
  ShoppingCart,
  Settings,
  LogOut,
  Menu,
  X,
  User,
  Home,
  CreditCard,
  History,
  Search,
  Server,
  Network, // Importing Network instead of Share2 as it's more appropriate for DNS
  MessageCircle,
} from 'lucide-react';
import RupeeIcon from '@/components/icons/RupeeIcon';
import ProfileCompletionWarning from '@/components/ProfileCompletionWarning';
import { DataLoading } from '@/components/user/LoadingComponents';
import { useCartStore } from '@/store/cartStore';
import { homeUrl } from '@/lib/reseller-os';

interface UserLayoutProps {
  children: React.ReactNode;
  user: {
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  onLogout?: () => void | Promise<void>;
  isLoading?: boolean;
  hideFloatingButtons?: boolean;
}

function UserLayout({ children, user, onLogout, isLoading = false, hideFloatingButtons = false }: UserLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const pathname = usePathname();
  const logoutButtonRef = useRef<HTMLButtonElement>(null);
  const { getItemCount } = useCartStore();
  const [cartCount, setCartCount] = useState(0);

  // Track component lifecycle and props
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Update cart count when mounted and subscribe to cart changes
  useEffect(() => {
    if (isMounted) {
      setCartCount(getItemCount());
      const unsubscribe = useCartStore.subscribe((state) => {
        setCartCount(state.getItemCount());
      });
      return unsubscribe;
    }
  }, [isMounted, getItemCount]);

  // Track when onLogout prop changes
  const onLogoutRef = useRef(onLogout);
  useEffect(() => {
    if (onLogoutRef.current !== onLogout) {
      onLogoutRef.current = onLogout;
    }
  }, [onLogout]);

  // Handler for logout button that properly awaits async logout
  const handleLogoutClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!onLogout) {
      return;
    }

    if (!user) {
      return;
    }

    try {
      await onLogout();
    } catch (error) {
      // Error handling if needed
    }
  }, [onLogout, user]);

  const navigation = [
    { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Domains', href: '/dashboard/domains', icon: Globe },
    { name: 'Hosting', href: '/dashboard/hosting', icon: Server },
    { name: 'Invoices', href: '/dashboard/invoices', icon: RupeeIcon },
    { name: 'Support', href: '/dashboard/support', icon: MessageCircle },
    { name: 'Account Settings', href: '/dashboard/settings', icon: Settings },
  ];

  const isActive = (href: string) => {
    if (href === '/dashboard') {
      return pathname === '/dashboard' || pathname === '/dashboard/';
    }
    // DNS management is reached from the Domains section ("Manage DNS"), so
    // keep the Domains nav item highlighted there instead of dropping the
    // active state (which made the page read as "Dashboard").
    if (href === '/dashboard/domains') {
      return (
        pathname.startsWith('/dashboard/domains') ||
        pathname.startsWith('/dashboard/dns-management')
      );
    }
    return pathname.startsWith(href);
  };

  return (
    <div className="min-h-screen bg-paper-2/40 flex">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar.
          The white fill and the divider used to be inline `style` rules. Inline
          styles beat utility classes, so leaving them would have kept this panel
          plain white against the warm paper chrome. They are classes now for
          that reason alone — nothing reads them. */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-60 bg-paper border-r border-hairline transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between h-14 px-3 border-b border-hairline">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-md bg-ink text-paper grid place-items-center">
              <User className="h-5 w-5" />
            </div>
            <span className="text-sm font-semibold text-ink">User Panel</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden rounded-md p-1.5 text-ink-3 hover:bg-paper-2 hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* User Info */}
        <div className="px-3 py-3 border-b border-hairline">
          <div className="flex items-center gap-2.5">
            <div className="flex-shrink-0">
              <div className="h-9 w-9 rounded-full bg-amber-soft flex items-center justify-center">
                <User className="h-4 w-4 text-amber" />
              </div>
            </div>
            <div className="min-w-0">
              {user && !isLoading ? (
                <>
                  <p className="text-sm font-medium text-ink break-words">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="text-xs text-ink-3 break-words">{user.email}</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-ink-3">Loading...</p>
                  <p className="text-xs text-ink-4">Please wait</p>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="px-2 py-3">
          <div className="space-y-0.5">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex items-center gap-2.5 px-3 py-2 lg:py-1.5 text-sm rounded-md transition-colors group ${isActive(item.href)
                    ? 'bg-amber-soft text-amber-ink font-medium'
                    : 'text-ink-2 hover:bg-paper-2 hover:text-ink'
                    }`}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon
                    className={`h-4 w-4 flex-shrink-0 transition-colors ${isActive(item.href)
                      ? 'text-amber'
                      : 'text-ink-3 group-hover:text-ink-2'
                      }`}
                  />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </nav>

      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar.
            z-[100] predates this restyle and is kept: menus inside page content
            sit at z-50, so dropping the header to the design system's z-30 would
            let them cover it. Colour and height are the only changes here. */}
        <div className="sticky top-0 z-[100] border-b border-hairline bg-paper/95 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2 h-14 px-3 md:px-4">
            <div className="flex items-center min-w-0">
              <button
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation menu"
                className="lg:hidden rounded-md p-1.5 text-ink-3 hover:bg-paper-2 hover:text-ink transition-colors"
              >
                <Menu className="h-5 w-5" />
              </button>
              <h1 className="ml-3 lg:ml-0 font-serif text-lg text-ink truncate">
                {navigation.find(item => isActive(item.href))?.name || 'Dashboard'}
              </h1>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0 relative z-50">
              {onLogout ? (
                <button
                  ref={logoutButtonRef}
                  onClick={handleLogoutClick}
                  type="button"
                  disabled={!user}
                  className={`relative z-50 pointer-events-auto flex items-center px-2.5 py-1.5 text-sm font-medium rounded-md border transition-colors ${user
                    ? 'text-rose-700 border-rose-200 bg-paper hover:bg-rose-50 hover:text-rose-800 cursor-pointer'
                    : 'text-ink-4 border-hairline cursor-not-allowed'
                    }`}
                  data-testid={user ? "logout-button-active" : "logout-button-disabled"}
                  title={!user ? 'Please wait for user data to load' : 'Click to logout'}
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  {!user ? 'Loading...' : 'Logout'}
                </button>
              ) : (
                <div
                  className="flex items-center px-2.5 py-1.5 text-sm font-medium text-ink-4"
                  data-testid="logout-button-inactive"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  <span className="text-xs">No logout handler</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto">
          {/* `key={pathname}` for the same reason AdminLayout has one:
              framer-motion's `initial` applies on MOUNT, and without a key
              React keeps this wrapper across a client-side navigation — so the
              entrance played once on first load and every page change after
              that was an instant swap. The two shells are kept in step
              deliberately; a fix to one that skips the other is how they drift. */}
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="h-full pb-20 sm:pb-8"
          >
            <ProfileCompletionWarning />
            {isLoading ? (
              <div className="p-6">
                <DataLoading type="card" count={3} />
              </div>
            ) : (
              children
            )}
          </motion.div>
        </main>

        {/* Floating Home Button — the customer panel's only way "out", so it
            follows the front door: ResellerOS when it owns it, DMS's own `/`
            when DMS is running standalone. */}
        {!hideFloatingButtons && (
          <Link
            href={homeUrl()}
            className="fixed bottom-6 left-6 z-50 bg-amber hover:brightness-90 text-paper p-3.5 rounded-full shadow-[0_2px_8px_rgba(0,0,0,0.10)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.14)] transition-all duration-200 group"
            title="Go back to homepage"
          >
            <Home className="h-5 w-5" />
            {/* Enhanced Tooltip */}
            <div className="absolute bottom-full left-0 mb-2 px-2.5 py-1.5 bg-ink text-paper text-xs rounded-md opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none">
              Back to Homepage
              <div className="absolute top-full left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-ink"></div>
            </div>
          </Link>
        )}


      </div>
    </div>
  );
}

export default UserLayout;
