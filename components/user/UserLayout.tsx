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
  Package,
} from 'lucide-react';
import RupeeIcon from '@/components/icons/RupeeIcon';
import ProfileCompletionWarning from '@/components/ProfileCompletionWarning';
import { DataLoading } from '@/components/user/LoadingComponents';
import { useCartStore } from '@/store/cartStore';

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
    { name: 'My Services', href: '/dashboard/services', icon: Package },
    { name: 'Billing', href: '/dashboard/invoices', icon: RupeeIcon },
    // Phase 1 integration: hands off to the Support Panel (DSP) via
    // lib/integrations/support-sso.ts instead of the in-app ticket page.
    // hardNav forces a full browser navigation (see render loop below) since
    // this is an API route that issues a cross-origin redirect, not a page.
    { name: 'Support', href: '/api/user/support/sso', icon: MessageCircle, hardNav: true },
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
    <div className="min-h-screen bg-gray-50 flex">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black bg-opacity-50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-72 shadow-xl transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        style={{
          backgroundColor: '#ffffff',
          borderRight: '1px solid #e5e7eb'
        }}
      >
        {/* Sidebar Header — white so the logo's dark/blue text (baked into the
            image, not currentColor) reads naturally instead of needing an
            inset backdrop chip. Matches the white sidebar body below it. */}
        <div className="flex items-center justify-between h-16 px-6 bg-white border-b border-gray-200">
          <div className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/anutech-logo-full.png" alt="Anutech Digital" className="h-8 w-auto" />
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-gray-500 hover:text-gray-700 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* User Info */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                <User className="h-6 w-6 text-blue-600" />
              </div>
            </div>
            <div className="ml-3">
              {user && !isLoading ? (
                <>
                  <p className="text-sm font-medium text-gray-900">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="text-xs text-gray-500">{user.email}</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-gray-500">Loading...</p>
                  <p className="text-xs text-gray-400">Please wait</p>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="mt-6 px-4" style={{ backgroundColor: '#ffffff' }}>
          <div className="space-y-1">
            {navigation.map((item) => {
              const Icon = item.icon;
              const linkClassName = `flex items-center px-4 py-3 text-sm font-medium rounded-xl transition-all duration-200 group ${isActive(item.href)
                ? 'bg-blue-50 text-blue-700 border-r-2 border-blue-700'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`;
              const iconClassName = `h-5 w-5 mr-3 transition-colors ${isActive(item.href)
                ? 'text-blue-700'
                : 'text-gray-400 group-hover:text-gray-600'
                }`;

              // hardNav items (e.g. Support) redirect through an API route to
              // an external app. Uses window.open() with a fixed window name
              // (not a plain <a target="..."> ) so repeated clicks reuse the
              // same tab instead of spawning a new one each time — a plain
              // named-target anchor doesn't reliably do this once rel="noopener"
              // is set (severs the name match in modern browsers). href is kept
              // so right-click > "open in new tab" still works as a plain
              // new-tab spawn, and middle-click still works normally.
              if (item.hardNav) {
                return (
                  <a
                    key={item.name}
                    href={item.href}
                    className={linkClassName}
                    onClick={(e) => {
                      e.preventDefault();
                      setSidebarOpen(false);
                      const w = window.open(item.href, 'dsp_support_panel');
                      if (w) w.focus();
                    }}
                  >
                    <Icon className={iconClassName} />
                    {item.name}
                  </a>
                );
              }

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={linkClassName}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon className={iconClassName} />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </nav>

      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <div className="bg-white shadow-sm border-b border-gray-200 sticky top-0 z-[100]">
          <div className="flex items-center justify-between h-16 px-6">
            <div className="flex items-center">
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden text-gray-500 hover:text-gray-700 transition-colors"
              >
                <Menu className="h-6 w-6" />
              </button>
              <h1 className="ml-4 lg:ml-0 text-xl font-semibold text-gray-900">
                {navigation.find(item => isActive(item.href))?.name || 'Dashboard'}
              </h1>
            </div>

            <div className="flex items-center space-x-4 relative z-50">
              {onLogout ? (
                <button
                  ref={logoutButtonRef}
                  onClick={handleLogoutClick}
                  type="button"
                  disabled={!user}
                  className={`relative z-50 pointer-events-auto flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${user
                    ? 'text-red-600 hover:bg-red-50 hover:text-red-700 cursor-pointer border border-red-200'
                    : 'text-gray-400 cursor-not-allowed border border-gray-200'
                    }`}
                  data-testid={user ? "logout-button-active" : "logout-button-disabled"}
                  title={!user ? 'Please wait for user data to load' : 'Click to logout'}
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  {!user ? 'Loading...' : 'Logout'}
                </button>
              ) : (
                <div
                  className="flex items-center px-3 py-2 text-sm font-medium text-gray-400"
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
          <motion.div
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

        {/* Floating Home Button */}
        {!hideFloatingButtons && (
          <Link
            href="/"
            className="fixed bottom-6 left-6 z-50 bg-blue-600 hover:bg-blue-700 text-white p-4 rounded-full shadow-lg hover:shadow-xl transition-all duration-300 transform hover:scale-110 group"
            title="Go back to homepage"
          >
            <Home className="h-6 w-6" />
            {/* Enhanced Tooltip */}
            <div className="absolute bottom-full left-0 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap pointer-events-none">
              Back to Homepage
              <div className="absolute top-full left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
            </div>
          </Link>
        )}


      </div>
    </div>
  );
}

export default UserLayout;
