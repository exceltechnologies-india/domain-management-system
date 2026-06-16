'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useLogout } from '@/lib/logout';
import { safeLocalStorage } from '@/lib/storage';
import { Award, Globe, ArrowLeft, ShoppingCart } from 'lucide-react';
import { useCartStore } from '@/store/cartStore';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import ProfileCompletionWarning from '@/components/ProfileCompletionWarning';
import HostingUpsell from '@/components/HostingUpsell';
import DomainCrossSell from '@/components/DomainCrossSell';
import DomainSetup from '@/components/DomainSetup';
import CartItemCard from '@/components/cart/CartItemCard';
import EmptyCart from '@/components/cart/EmptyCart';
import CartOrderSummary from '@/components/cart/CartOrderSummary';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { CartPageSkeleton } from '@/components/skeletons/PageSkeletons';
import { getMinRegistrationPeriod } from '@/lib/tld-min-periods';
import { ErrorBoundary } from '@/components/ErrorBoundary';

interface User {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  profileCompleted?: boolean;
}

const elementIsPending = (item: { domainName: string; linkedDomain?: string }) =>
  item.domainName.startsWith('hosting-') && !item.linkedDomain;

export default function CartPage() {
  const {
    items: cartItems,
    addItem,
    removeItem,
    updateItem,
    getTotalPrice,
    getItemCount,
    clearCart,
    mergeWithServerCart,
    isLoading,
    hasDomainItems,
    hasHostingItems,
  } = useCartStore();

  const [isClient, setIsClient] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();
  const handleLogout = useLogout();
  const { data: session, status } = useSession();

  useEffect(() => { setIsClient(true); }, []);

  // ── Fetch latest user profile from the server ─────────────────────────────
  const refreshUserFromServer = async (): Promise<User | null> => {
    try {
      const response = await fetch('/api/v1/auth/me', {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!response.ok) return null;
      const { user: serverUser } = await response.json();
      safeLocalStorage.setItem('user', JSON.stringify(serverUser));
      return serverUser;
    } catch {
      return null;
    }
  };

  // ── Resolve user on session change ────────────────────────────────────────
  useEffect(() => {
    if (status === 'loading') return;

    const init = async () => {
      if (session?.user) {
        const base: User = {
          firstName: session.user.name?.split(' ')[0] ?? '',
          lastName: session.user.name?.split(' ').slice(1).join(' ') ?? '',
          email: session.user.email ?? '',
          role: session.user.role ?? 'user',
          profileCompleted: session.user.profileCompleted,
        };
        if (base.role === 'admin') { router.push('/admin/dashboard'); return; }
        setUser(base);
        const fresh = await refreshUserFromServer();
        if (fresh) setUser((prev) => prev ? { ...prev, ...fresh } : fresh);
        void mergeWithServerCart();
        return;
      }
    };

    void init();
  }, [router, mergeWithServerCart, session, status]);

  // ── React to external profile-update events ───────────────────────────────
  useEffect(() => {
    const handleProfileUpdate = async () => {
      const fresh = await refreshUserFromServer();
      if (fresh) {
        setUser((prev) => prev ? { ...prev, ...fresh, profileCompleted: fresh.profileCompleted } : fresh);
      }
    };

    window.addEventListener('profileUpdated', handleProfileUpdate);
    const onStorage = (e: StorageEvent) => { if (e.key === 'user') void handleProfileUpdate(); };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('profileUpdated', handleProfileUpdate);
      window.removeEventListener('storage', onStorage);
    };
  }, [session]);

  // ── Enforce TLD minimum registration periods ──────────────────────────────
  useEffect(() => {
    if (isLoading || cartItems.length === 0) return;
    cartItems.forEach((item) => {
      if (item.itemType === 'hosting') return;
      const min = getMinRegistrationPeriod(item.domainName);
      if (item.registrationPeriod < min) {
        updateItem(item.domainName, { registrationPeriod: min }, item.itemType);
      }
    });
  }, [cartItems, isLoading, updateItem]);

  // ── Checkout ──────────────────────────────────────────────────────────────
  const handleCheckout = async () => {
    if (cartItems.length === 0) return;

    if (!user) {
      router.push(`/login?returnUrl=${encodeURIComponent('/checkout')}`);
      return;
    }

    // Always re-verify profile status from the server before allowing checkout
    if (!session?.user) {
      router.push(`/login?returnUrl=${encodeURIComponent('/checkout')}`);
      return;
    }

    const fresh = await refreshUserFromServer();
    const latestProfileCompleted = fresh?.profileCompleted ?? user.profileCompleted;

    if (fresh) {
      setUser((prev) => prev ? { ...prev, ...fresh, profileCompleted: latestProfileCompleted } : fresh);
    }

    if (latestProfileCompleted !== true) {
      // Send the customer to the profile/settings page with a returnUrl so
      // the page can bounce them back to the cart after a successful save.
      // The toast is still shown to explain *why* they're being redirected.
      toast.error('Please complete your profile before proceeding to checkout');
      router.push(`/dashboard/settings?returnUrl=${encodeURIComponent('/cart')}`);
      return;
    }

    // Block checkout if any standalone hosting item has no domain assigned
    const unlinked = cartItems.filter(
      (i) => i.itemType === 'hosting' && i.domainName.startsWith('hosting-') && !i.linkedDomain
    );
    if (unlinked.length > 0) {
      toast.error('Please set up a domain for all hosting plans before checking out');
      return;
    }

    router.push('/checkout');
  };

  const handleRegistrationPeriodChange = (
    domainName: string,
    newPeriod: number,
    itemType?: string,
    newUnit: 'months' | 'minutes' | 'years' | 'days' = 'months'
  ) => {
    if (newPeriod <= 0) {
      removeItem(domainName, itemType);
    } else {
      updateItem(domainName, { registrationPeriod: newPeriod, periodUnit: newUnit }, itemType);
    }
  };

  const handleSaveDomain = async (placeholderDomain: string, newDomain: string) => {
    const item = cartItems.find((i) => i.domainName === placeholderDomain);
    if (item) {
      updateItem(placeholderDomain, { ...item, linkedDomain: newDomain }, 'hosting');
      toast.success('Domain updated successfully');
    }
  };

  if (!isClient || isLoading) {
    return <CartPageSkeleton />;
  }

  const pendingHostingItems = cartItems.filter(
    (i) => i.itemType === 'hosting' && elementIsPending(i)
  );

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation user={user} onLogout={user ? handleLogout : undefined} />

      <div className="flex-1 w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 py-8 pt-24">
        <ErrorBoundary label="CartPage">
        <ProfileCompletionWarning returnUrl="/cart" />

        {/* ── Header strip ── */}
        {cartItems.length > 0 ? (
          <div className="mb-6">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors mb-3"
            >
              <ArrowLeft className="h-4 w-4" /> Continue shopping
            </Link>
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="px-5 sm:px-6 py-4 sm:py-5 flex items-start gap-4">
                <div className="p-2.5 bg-blue-50 rounded-xl shrink-0">
                  <ShoppingCart className="h-5 w-5 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Shopping Cart</h1>
                  <p className="text-xs sm:text-sm text-gray-500 mt-1">
                    {getItemCount()} item{getItemCount() !== 1 ? 's' : ''} ready for checkout
                  </p>
                </div>
                <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 px-2.5 py-1 rounded-full shrink-0">
                  {getItemCount()} item{getItemCount() !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center text-center mb-6 sm:mb-8">
            <Link
              href="/"
              className="p-2 text-gray-600 hover:text-primary-600 transition-colors duration-200 bg-white shadow-sm rounded-full mb-3"
              title="Return to Home"
            >
              <ArrowLeft className="h-5 w-5 sm:h-6 sm:w-6" />
            </Link>
            <h1 className="text-xl sm:text-2xl md:text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-gray-900 to-gray-500">
              Shopping Cart
            </h1>
          </div>
        )}

        {cartItems.length === 0 ? (
          <EmptyCart />
        ) : (
          <div className="flex flex-col lg:grid lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-6 lg:gap-8 min-h-[50vh]">
            {/* Cart items list */}
            <div className="order-1 lg:col-start-1 lg:row-start-1 lg:col-span-4 xl:col-span-5 2xl:col-span-5">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ShoppingCart className="h-4 w-4 text-gray-500" />
                    <h2 className="text-sm font-semibold text-gray-900">Cart Items</h2>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
                    {cartItems.length} item{cartItems.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="p-4 sm:p-6">
                  <div className="space-y-4">
                    {cartItems.map((item) => (
                      <CartItemCard
                        key={`${item.itemType}-${item.domainName}`}
                        item={item}
                        onRemove={removeItem}
                        onPeriodChange={handleRegistrationPeriodChange}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Upsells + features — below cart on mobile, below cart col on desktop */}
            <div className="order-3 lg:col-start-1 lg:row-start-2 lg:col-span-4 xl:col-span-5 2xl:col-span-5">
              <div className="mt-6 sm:mt-8 lg:mt-0 space-y-6 sm:space-y-8">
                {hasDomainItems() && !hasHostingItems() && <HostingUpsell />}

                {pendingHostingItems.map((item) => (
                  <DomainSetup
                    key={item.domainName}
                    hostingItem={item}
                    onUpdateDomain={handleSaveDomain}
                    onAddDomainToCart={addItem}
                  />
                ))}

                {!hasHostingItems() && !hasDomainItems() && <DomainCrossSell />}

                {/* Features */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center gap-2">
                    <Award className="h-4 w-4 text-gray-500" />
                    <h3 className="text-sm font-semibold text-gray-900">Features</h3>
                  </div>
                  <div className="p-4 sm:p-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <div className="flex items-center gap-3 p-3 sm:p-4 border border-gray-200 rounded-xl hover:border-blue-300 hover:shadow-sm transition-all">
                        <div className="bg-blue-50 p-2 rounded-lg flex-shrink-0">
                          <Globe className="h-4 w-4 sm:h-5 sm:w-5 text-blue-600" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm sm:text-base font-medium text-gray-900 truncate">
                            Simple Dashboard
                          </h4>
                          <p className="text-xs sm:text-sm text-gray-600">
                            Easy domain management interface
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 p-3 sm:p-4 border border-gray-200 rounded-xl hover:border-blue-300 hover:shadow-sm transition-all">
                        <div className="bg-purple-50 p-2 rounded-lg flex-shrink-0">
                          <Award className="h-4 w-4 sm:h-5 sm:w-5 text-purple-600" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-sm sm:text-base font-medium text-gray-900 truncate">
                            DirectAdmin Hosting Panel
                          </h4>
                          <p className="text-xs sm:text-sm text-gray-600">
                            Powerful control panel for your hosting
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Order summary sidebar */}
            <div className="order-2 lg:col-start-5 xl:col-start-6 2xl:col-start-6 lg:row-start-1 lg:row-span-2 lg:col-span-2 xl:col-span-2 2xl:col-span-3">
              <CartOrderSummary
                isLoggedIn={!!user}
                hasSession={!!session?.user}
                profileCompleted={user?.profileCompleted}
                itemCount={getItemCount()}
                totalPrice={getTotalPrice()}
                onCheckout={handleCheckout}
                onClearCart={clearCart}
                returnUrl="/checkout"
                allowsGuestCheckout={hasDomainItems() || hasHostingItems()}
              />
            </div>
          </div>
        )}
        </ErrorBoundary>
      </div>

      <Footer />
    </div>
  );
}
