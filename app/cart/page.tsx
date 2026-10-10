'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useLogout } from '@/lib/logout';
import { safeLocalStorage } from '@/lib/storage';
import { ArrowLeft } from 'lucide-react';
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
import { domainYearsOf, nearestDomainTerm } from '@/lib/reselleros/domain-terms';
import { useDomainTermPrices } from '@/hooks/useDomainTermPrices';
import { cartHasYearlyHosting } from '@/lib/reselleros/cart-lines';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { homeUrl } from '@/lib/reseller-os';

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
  // ResellerOS's price per term for each domain line — the line totals and the summary use it.
  const termTotals = useDomainTermPrices(cartItems);

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
      // Onto a term ResellerOS sells (1, 2, 3, 5 years), in years — a stored 4 becomes 3, and a
      // term the old picker saved as "months" is put back as years (9 Oct 2026).
      const years = domainYearsOf(item);
      const term = nearestDomainTerm(Math.max(years, min), min);
      if (term !== item.registrationPeriod || item.periodUnit !== 'years') {
        updateItem(item.domainName, { registrationPeriod: term, periodUnit: 'years' }, item.itemType);
      }
    });
  }, [cartItems, isLoading, updateItem]);

  // ── Checkout ──────────────────────────────────────────────────────────────
  const handleCheckout = async () => {
    if (cartItems.length === 0) return;

    if (!user) {
      // Send the customer back to /cart (NOT /checkout) after login. A guest
      // browsing the cart has their items in localStorage, but the server-
      // side cart is empty; if we redirected straight to /checkout, the
      // empty-cart guard there would immediately bounce them to /dashboard
      // (cart-merge happens client-side AFTER /cart loads). Landing back on
      // /cart lets the merge complete, then the customer can click the
      // now-blue "Proceed to Checkout" button to continue.
      router.push(`/login?returnUrl=${encodeURIComponent('/cart')}`);
      return;
    }

    // Always re-verify profile status from the server before allowing checkout
    if (!session?.user) {
      router.push(`/login?returnUrl=${encodeURIComponent('/cart')}`);
      return;
    }

    const fresh = await refreshUserFromServer();
    const latestProfileCompleted = fresh?.profileCompleted ?? user.profileCompleted;

    if (fresh) {
      setUser((prev) => prev ? { ...prev, ...fresh, profileCompleted: latestProfileCompleted } : fresh);
    }

    if (latestProfileCompleted !== true && cartItems.some((i) => i.itemType !== 'hosting')) {
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

  /* Phone and address are needed only to register a domain (3 Oct 2026), so the profile is
     asked for — banner, button and checkout gate — only when the cart holds one. A hosting-only
     order is still asked for its state at payment (PanelCheckout). */
  const cartHasDomain = cartItems.some((i) => i.itemType !== 'hosting');

  const pendingHostingItems = cartItems.filter(
    (i) => i.itemType === 'hosting' && elementIsPending(i)
  );

  return (
    <div className="min-h-screen bg-paper-2 flex flex-col">
      <Navigation user={user} onLogout={user ? handleLogout : undefined} />

      <div className="flex-1 w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 py-8 pt-24">
        <ErrorBoundary label="CartPage">
        {cartHasDomain && <ProfileCompletionWarning returnUrl="/cart" />}

        {/* ── Header strip ── */}
        {cartItems.length > 0 ? (
          <div className="mb-6">
            <Link
              href={homeUrl()}
              className="inline-flex items-center gap-1.5 min-h-[44px] text-sm text-ink-3 hover:text-ink transition-colors mb-1"
            >
              <ArrowLeft className="h-4 w-4" /> Continue shopping
            </Link>
            {/* One plain title (9 Oct 2026): a "Shopping Cart" card, a "Cart Items" card and the
                summary each carried their own "2 items" badge. */}
            <h1 className="text-2xl sm:text-3xl font-bold text-ink">Your cart</h1>
            <p className="text-sm text-ink-3 mt-1">
              {getItemCount()} item{getItemCount() !== 1 ? 's' : ''} · prices include 18% GST
            </p>
          </div>
        ) : null /* The empty cart's own heading is the page title ("Your cart is empty"). */}

        {cartItems.length === 0 ? (
          <EmptyCart />
        ) : (
          <div className="flex flex-col lg:grid lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-6 lg:gap-8 min-h-[50vh]">
            {/* Cart items list */}
            <div className="order-1 lg:col-start-1 lg:row-start-1 lg:col-span-4 xl:col-span-5 2xl:col-span-5">
              <div className="bg-paper rounded-2xl shadow-sm border border-hairline overflow-hidden">
                <div className="p-4 sm:p-6">
                  <div className="space-y-4">
                    {cartItems.map((item) => (
                      <CartItemCard
                        key={`${item.itemType}-${item.domainName}`}
                        item={item}
                        onRemove={removeItem}
                        onPeriodChange={handleRegistrationPeriodChange}
                        termTotals={termTotals[item.domainName.toLowerCase()]}
                        bundled={cartHasYearlyHosting(cartItems)}
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


              </div>
            </div>

            {/* Order summary sidebar */}
            <div className="order-2 lg:col-start-5 xl:col-start-6 2xl:col-start-6 lg:row-start-1 lg:row-span-2 lg:col-span-2 xl:col-span-2 2xl:col-span-3">
              <CartOrderSummary
                isLoggedIn={!!user}
                hasSession={!!session?.user}
                profileCompleted={cartHasDomain ? user?.profileCompleted : true}
                itemCount={getItemCount()}
                totalPrice={getTotalPrice()}
                onCheckout={handleCheckout}
                onClearCart={clearCart}
                returnUrl="/cart"
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
