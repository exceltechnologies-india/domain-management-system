'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
  ChevronRight,
} from 'lucide-react';
import RupeeIcon from '@/components/icons/RupeeIcon';
import ProfileCompletionWarning from '@/components/ProfileCompletionWarning';
import { DataLoading } from '@/components/user/LoadingComponents';
import { useCartStore } from '@/store/cartStore';
import { homeUrl } from '@/lib/reseller-os';
import PurchaseDialogs from '@/components/purchase/PurchaseDialogs';
import { buyHref } from '@/lib/purchase/buy-dialog';

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
  const router = useRouter();
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

  const pageName = navigation.find((item) => isActive(item.href))?.name || 'Dashboard';
  const initial = (user?.firstName || user?.email || '?').trim().charAt(0).toUpperCase();
  const navLink = (active: boolean) =>
    `flex items-center gap-2.5 px-3 py-2 lg:py-1.5 text-[13px] rounded-md transition-colors group ${
      active ? 'bg-amber-soft text-amber-ink font-medium' : 'text-ink-2 hover:bg-paper-2 hover:text-ink'
    }`;

  return (
    <div className="min-h-screen bg-paper-2/40 flex">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar, in the ResellerOS shell pattern (10 Oct 2026): the brand at the top, the
          sections, and the signed-in account at the bottom. */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-60 bg-paper border-r border-hairline flex flex-col transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
      >
        <div className="flex items-center justify-between h-14 px-3 border-b border-hairline">
          <Link href={homeUrl()} className="flex min-w-0 items-center gap-2.5" title="Go back to homepage">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/anutech-digital-logo.png" alt="" width={30} height={30} className="h-[30px] w-[30px] flex-none" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink">Anutech Digital</span>
              <span className="block truncate text-[11px] text-ink-3">Customer Portal</span>
            </span>
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden rounded-md p-1.5 text-ink-3 hover:bg-paper-2 hover:text-ink transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Customer Portal">
          <div className="space-y-0.5">
            {navigation.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link key={item.name} href={item.href} className={navLink(active)} aria-current={active ? 'page' : undefined} onClick={() => setSidebarOpen(false)}>
                  <Icon className={`h-4 w-4 flex-shrink-0 transition-colors ${active ? 'text-amber' : 'text-ink-3 group-hover:text-ink-2'}`} />
                  {item.name}
                </Link>
              );
            })}
          </div>

          {/* In-panel purchase. DMS has no public shop any more (owner decision, 24 Sep 2026), so
              these dialogs are the only way a signed-in customer adds hosting or a domain here. */}
          <div className="mt-4 pt-3 border-t border-hairline space-y-0.5">
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-4">Buy</p>
            <Link href={buyHref('hosting')} onClick={() => setSidebarOpen(false)} className={navLink(false)}>
              <Server className="h-4 w-4 flex-shrink-0 text-ink-3" />
              Buy hosting
            </Link>
            <Link href={buyHref('domain')} onClick={() => setSidebarOpen(false)} className={navLink(false)}>
              <Search className="h-4 w-4 flex-shrink-0 text-ink-3" />
              Register domain
            </Link>
          </div>
        </nav>

        {/* The signed-in account, at the foot like ResellerOS. */}
        <div className="border-t border-hairline px-3 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-ink text-sm font-semibold text-paper" aria-hidden>
              {user && !isLoading ? initial : <User className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              {user && !isLoading ? (
                <>
                  <p className="truncate text-sm font-medium text-ink">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="truncate text-xs text-ink-3" title={user.email}>{user.email}</p>
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
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar: breadcrumb, a domain search and the cart, as in ResellerOS. z-[100] predates the
            restyle and is kept: menus inside page content sit at z-50. */}
        <div className="sticky top-0 z-[100] border-b border-hairline bg-paper/95 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2 h-14 px-3 md:px-4">
            <div className="flex items-center min-w-0 gap-2">
              <button
                onClick={() => setSidebarOpen(true)}
                aria-label="Open navigation menu"
                className="lg:hidden rounded-md p-1.5 text-ink-3 hover:bg-paper-2 hover:text-ink transition-colors"
              >
                <Menu className="h-5 w-5" />
              </button>
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
                <Link href={homeUrl()} className="hidden py-1 text-ink-3 hover:text-ink sm:inline-block">Home</Link>
                <ChevronRight className="hidden h-3.5 w-3.5 flex-none text-ink-4 sm:inline" aria-hidden />
                <h1 className="truncate font-medium text-ink">{pageName}</h1>
              </nav>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0 relative z-50">
              {/* Find a domain from any page: opens the Register a domain pop-up with the name. */}
              <form
                role="search"
                className="hidden md:block"
                onSubmit={(e) => {
                  e.preventDefault();
                  const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
                  router.push(buyHref('domain', q) as never);
                }}
              >
                <label className="relative block">
                  <span className="sr-only">Find a domain</span>
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4" aria-hidden />
                  <input
                    name="q"
                    type="search"
                    placeholder="Find a domain…"
                    autoComplete="off"
                    className="h-9 w-56 rounded-md border border-hairline bg-paper-2/60 pl-8 pr-3 text-sm text-ink placeholder:text-ink-4 focus:border-amber/40 focus:bg-paper focus:outline-none focus:ring-2 focus:ring-amber/20"
                  />
                </label>
              </form>
              <Link
                href="/cart"
                aria-label={cartCount > 0 ? `Cart, ${cartCount} item${cartCount === 1 ? '' : 's'}` : 'Cart'}
                className="relative grid h-9 w-9 place-items-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink"
              >
                <ShoppingCart className="h-4 w-4" />
                {cartCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-amber px-1 text-[10px] font-semibold text-paper">
                    {cartCount}
                  </span>
                )}
              </Link>
              {onLogout ? (
                <button
                  ref={logoutButtonRef}
                  onClick={handleLogoutClick}
                  type="button"
                  disabled={!user}
                  className={`relative z-50 pointer-events-auto flex items-center h-9 px-2.5 text-sm font-medium rounded-md border transition-colors ${user
                    ? 'text-ink-2 border-hairline bg-paper hover:bg-rose/10 hover:text-rose-ink hover:border-rose/30 cursor-pointer'
                    : 'text-ink-4 border-hairline cursor-not-allowed'
                    }`}
                  data-testid={user ? 'logout-button-active' : 'logout-button-disabled'}
                  title={!user ? 'Please wait for user data to load' : 'Sign out'}
                  aria-label={!user ? 'Loading' : 'Logout'}
                >
                  <LogOut className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">{!user ? 'Loading...' : 'Logout'}</span>
                </button>
              ) : (
                <div className="flex items-center px-2.5 py-1.5 text-sm font-medium text-ink-4" data-testid="logout-button-inactive">
                  <LogOut className="h-4 w-4 mr-2" />
                  <span className="text-xs">No logout handler</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto">
          {/* `key={pathname}`: framer-motion's `initial` applies on MOUNT, so without a key the
              entrance played once and every later page change was an instant swap. Kept in step
              with AdminLayout deliberately. */}
          <motion.div
            key={pathname}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="h-full pb-20 sm:pb-8"
          >
            <ProfileCompletionWarning onlyWithDomains />
            {isLoading ? (
              <div className="p-6">
                <DataLoading type="card" count={3} />
              </div>
            ) : (
              children
            )}
          </motion.div>
        </main>

        {/* PurchaseDialogs reads useSearchParams, which Next requires under a Suspense boundary. */}
        <Suspense fallback={null}>
          <PurchaseDialogs />
        </Suspense>

        {/* The floating Home button is gone (10 Oct 2026): "Home" is in the breadcrumb and the logo,
            as in ResellerOS. `hideFloatingButtons` is still accepted so callers need not change. */}
        {hideFloatingButtons ? null : null}
      </div>
    </div>
  );
}

export default UserLayout;
