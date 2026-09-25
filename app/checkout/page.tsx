'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { trackInitiateCheckout } from '@/lib/journey';
import { useLogout } from '@/lib/logout';
import { safeSessionStorage } from '@/lib/storage';
import { ArrowLeft, CreditCard, Globe, Info, Check, Smartphone } from 'lucide-react';
import toast from 'react-hot-toast';
import { useCartStore } from '@/store/cartStore';
import ClientOnly from '@/components/ClientOnly';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import { CheckoutPageSkeleton } from '@/components/skeletons/PageSkeletons';
import OrderTimeline from '@/components/checkout/OrderTimeline';
import { getMinRegistrationPeriod } from '@/lib/tld-min-periods';
import { getDeviceFingerprint } from '@/lib/device-fingerprint';
import { hostingCharge } from '@/lib/pricing/hosting-price';
import type { CartItem } from '@/lib/types';
import { logger } from '@/lib/logger';
import PanelCheckout from '@/components/purchase/PanelCheckout';

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  profileCompleted?: boolean;
  whatsappNumber?: string;
}

export default function CheckoutPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const handleLogout = useLogout();
  const [isPaymentInProgress, setIsPaymentInProgress] = useState(false);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const router = useRouter();
  const { data: session, status } = useSession();
  const { items: cartItems, getTotalPrice, getSubtotalPrice, getItemCount, clearCart, syncWithServer, isLoading, hasDomainItems, hasHostingItems } = useCartStore();
  const hasTrial = cartItems.some((i: CartItem) => i.isTrial === true);
  const trialItem = cartItems.find((i: CartItem) => i.isTrial === true);
  // What the trial converts to: ResellerOS's price incl. GST for the trial's
  // cycle — yearly, or monthly since 24 Sep 2026 — from the same function
  // create-order and the renewal route charge with. Computed from the plan id
  // first, because a cart saved before that date carries the old DMS figure in
  // hostingPlan.price. The stored per-month value is only a last resort for a
  // plan ResellerOS does not price.
  const trialCycle: 'monthly' | 'yearly' = trialItem?.billingCycle === 'monthly' ? 'monthly' : 'yearly';
  const trialPer = trialCycle === 'monthly' ? 'month' : 'year';
  const trialAfterPrice = (() => {
    if (!trialItem) return 0;
    const charge = hostingCharge(trialItem.hostingPlan?.id, trialCycle);
    if (charge) return charge.inclGst;
    const stored = trialItem.hostingPlan?.price;
    return typeof stored === 'number' && stored > 0 ? stored * (trialCycle === 'monthly' ? 1 : 12) : 0;
  })();

  // Fire InitiateCheckout (Pixel) + internal checkout_started once on mount.
  useEffect(() => {
    trackInitiateCheckout();
  }, []);

  useEffect(() => {
    // Wait for NextAuth to resolve
    if (status === 'loading') {
      return;
    }

    // Refresh user data from server to get latest profileCompleted status from DB
    const refreshUserData = async () => {
      try {
        const response = await fetch('/api/v1/auth/me', {
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include', // Use NextAuth cookies
        });

        if (response?.ok) {
          const data = await response.json();

          // Ensure profileCompleted is a strict boolean
          const profileCompleted = data.user?.profileCompleted === true ? true : false;

          // Server/DB is the source of truth - always use DB status
          const updatedUser = {
            ...(session?.user || {}),
            ...data.user,
            profileCompleted: profileCompleted, // Always use strict boolean from DB
          };

          // Redirect admin users to admin dashboard
          if (updatedUser.role === 'admin') {
            router.push('/admin/dashboard');
            return;
          }

          // Check if user has completed profile (required for checkout)
          // Use strict check: profileCompleted must be explicitly true
          if (profileCompleted !== true) {
            toast.error('Please complete your profile before checkout');
            router.push('/cart');
            return;
          }

          // A WhatsApp number is required to check out (renewal reminders +
          // contact). New signups/guests always have one; this catches legacy
          // customers whose profile predates the requirement — send them to
          // settings to add it, then bounce back to checkout. Checked
          // independently of profileCompleted, which is persisted and may be
          // stale-true for those accounts.
          const hasWhatsApp = !!(updatedUser.whatsappNumber && String(updatedUser.whatsappNumber).trim());
          if (!hasWhatsApp) {
            toast.error('Please add a WhatsApp number to your profile before checkout');
            router.push('/dashboard/settings?returnUrl=%2Fcheckout');
            return;
          }

          setUser(updatedUser);
          void syncWithServer();
        } else {
          router.push('/login');
        }
      } catch (error) {
        router.push('/login');
      }
    };

    void refreshUserData();
  }, [router, syncWithServer, session, status]);

  // Navigation prevention removed - users can freely navigate during payment

  // Redirect to dashboard if cart is empty (after cart has been loaded)
  // But not if payment is in progress or just completed
  useEffect(() => {
    if (!isLoading && cartItems.length === 0 && user && !isPaymentInProgress && !paymentCompleted) {
      // Immediate redirect without showing intermediate state
      router.replace('/dashboard');
    }
  }, [cartItems.length, isLoading, user, router, isPaymentInProgress, paymentCompleted]);

  // The ₹0 free trial is the one thing this page starts itself
  // (api/user/hosting/start-trial). Every PAID cart is ordered through
  // ResellerOS by <PanelCheckout> below (owner, 25 Sep 2026: "Route through
  // ResellerOS") — DMS creates no Razorpay order and records no payment.
  const handleStartTrial = async () => {
    if (!hasTrial) return;
    setIsProcessing(true);
    setIsPaymentInProgress(true);
    try {
      const deviceFingerprint = await getDeviceFingerprint().catch(() => '');
      const response = await fetch('/api/v1/user/hosting/start-trial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cartItems, deviceFingerprint }),
        credentials: 'include',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(typeof data.error === 'string' ? data.error : "We couldn't start your trial. Nothing was charged. Please try again.");
        setIsProcessing(false);
        setIsPaymentInProgress(false);
        return;
      }
      safeSessionStorage.setItem('paymentResult', JSON.stringify({
        status: 'success',
        amount: 0,
        mandateMode: 'manual',
        timestamp: Date.now(),
      }));
      setPaymentCompleted(true);
      clearCart();
      setIsPaymentInProgress(false);
      router.push('/payment-success');
    } catch (error: unknown) {
      logger.error('Trial start failed:', error);
      toast.error("We couldn't reach our server, so the trial wasn't started. Nothing was charged. Please try again.");
      setIsProcessing(false);
      setIsPaymentInProgress(false);
    }
  };

  if (!user || isLoading || cartItems.length === 0) {
    return <CheckoutPageSkeleton />;
  }

  return (
    <>
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation user={user} onLogout={user ? handleLogout : undefined} />

      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10">
          <div className="flex items-center py-4 pt-20 sm:pt-24">
            <button
              onClick={() => router.back()}
              disabled={isPaymentInProgress}
              className={`flex items-center mr-4 ${isPaymentInProgress
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-gray-600 hover:text-gray-900'
                }`}
            >
              <ArrowLeft className="h-5 w-5 mr-1" />
              Back to Cart
            </button>
            <h1 className="text-2xl font-bold text-gray-900">Checkout</h1>
          </div>
        </div>
      </header>

      <div className="flex-1 w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 py-8">
        <div className="grid lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8 gap-8 min-h-[50vh]">
          {/* Order Summary */}
          <div className="lg:col-span-4 xl:col-span-5 2xl:col-span-5">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="p-4 sm:p-6">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-lg font-semibold text-gray-900">Order Summary</h2>
                  <div className="flex items-center space-x-2 text-sm text-gray-600">
                    <Check className="h-4 w-4 text-green-600" />
                    <span>Ready for payment</span>
                  </div>
                </div>
                <div className="space-y-4">
                  {cartItems.map((item, index) => (
                    <div key={index} className="group relative p-4 sm:p-6 border border-gray-200 rounded-lg hover:border-primary-300 hover:shadow-md transition-all duration-200">
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 sm:gap-6">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <div className="bg-primary-100 p-2 rounded-lg">
                              <Globe className="h-5 w-5 text-primary-600" />
                            </div>
                            <div>
                              <h3 className="text-lg font-medium text-gray-900">
                                {item.itemType === 'hosting' && item.hostingPlan
                                  ? item.hostingPlan.name
                                  : item.domainName}
                              </h3>
                              {item.itemType === 'hosting' ? (
                                <p className="text-sm font-medium text-primary-600 mt-1">
                                  for {item.linkedDomain || item.domainName}
                                </p>
                              ) : (
                                <p className="text-sm font-medium text-gray-500 mt-1">
                                  Domain Registration
                                </p>
                              )}
                              <p className="text-sm text-gray-600">
                                        {item.isTrial
                                  ? `15-Day Free Trial → ${item.billingCycle === 'monthly' ? 'Monthly' : 'Yearly'} plan`
                                  : item.itemType === 'hosting' && item.periodUnit === 'days'
                                  ? `${item.registrationPeriod} day subscription`
                                  : item.itemType === 'hosting' && item.registrationPeriod === 12
                                  ? '1 year subscription'
                                  : `${item.registrationPeriod || 1} ${item.itemType === 'hosting' ? (item.periodUnit === 'days' ? 'day(s)' : 'month(s)') : 'year(s)'} ${item.itemType === 'hosting' ? 'subscription' : 'registration'}`
                                }
                                {getMinRegistrationPeriod(item.domainName) > 1 && (
                                  <span className="ml-2 text-xs text-amber-600">
                                    (Min: {getMinRegistrationPeriod(item.domainName)} year{getMinRegistrationPeriod(item.domainName) > 1 ? 's' : ''})
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>

                          {/* Domain Features */}
                          <div className="flex flex-wrap gap-2 mt-3">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <Check className="h-3 w-3 mr-1" />
                              Available
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-row sm:flex-col justify-between items-end sm:text-right border-t sm:border-t-0 border-gray-100 pt-3 sm:pt-0">
                          <div className="sm:hidden text-xs font-bold text-gray-400 uppercase tracking-wider">Price</div>
                          <div>
                            {item.isTrial ? (
                              <>
                                <p className="text-xl font-bold text-green-600">₹0.00</p>
                                <p className="text-xs text-gray-500">Free for 15 days</p>
                                {/* Post-trial charge for the trial's cycle —
                                    `trialAfterPrice`, ResellerOS's price incl.
                                    GST (see its definition above). */}
                                <p className="text-xs text-purple-600 font-medium mt-0.5">
                                  then ₹{trialAfterPrice.toFixed(2)}/{trialCycle === 'monthly' ? 'mo' : 'yr'}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="text-xl font-bold text-gray-900">
                                  ₹{item.itemType === 'hosting' && item.periodUnit === 'days'
                                    ? (1).toFixed(2)
                                    : (item.price * (item.registrationPeriod || 1)).toFixed(2)}
                                </p>
                                <p className="text-sm text-gray-600">
                                  ₹{item.itemType === 'hosting' && item.periodUnit === 'days' ? (item.registrationPeriod === 8 ? '1.00' : item.price) : item.price} per {item.itemType === 'hosting' && item.periodUnit === 'days' ? 'day' : (item.itemType === 'hosting' ? 'month' : 'year')}
                                </p>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* What's Included - Dynamic based on cart content */}
              <div className="px-6 pb-6">
                <div className="bg-primary-50 rounded-lg p-4">
                  <h3 className="font-semibold text-primary-900 mb-3 flex items-center">
                    <Info className="h-4 w-4 mr-2" />
                    What's Included
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    {cartItems.some(item => item.itemType === 'hosting') ? (
                      // Hosting Features
                      <>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          Hosting Control Panel
                        </div>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          Free SSL Certificates
                        </div>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          24/7 support
                        </div>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          99.9% Uptime Guarantee
                        </div>
                      </>
                    ) : (
                      // Domain Features
                      <>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          Domain Registration
                        </div>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          DNS Management
                        </div>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          Domain Lock
                        </div>
                        <div className="flex items-center text-primary-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          24/7 Support
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Post-payment timeline — sets expectations before user clicks Pay */}
              <OrderTimeline
                hasDomains={hasDomainItems()}
                hasHosting={hasHostingItems()}
                userEmail={user.email}
              />
            </div>
          </div>

          {/* Payment Section */}
          <div className="lg:col-span-2 xl:col-span-2 2xl:col-span-3">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 sticky top-24">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-6">Secure Payment</h2>

                {/* Trial pricing banner */}
                {hasTrial && (
                  <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-4">
                    <div className="flex items-start gap-3">
                      <span className="text-2xl">🎁</span>
                      <div>
                        <p className="font-semibold text-purple-900 text-sm">Free 15-Day Trial</p>
                        <p className="text-xs text-purple-700 mt-0.5">
                          {/* Was "your card will be saved for automatic yearly billing" — untrue
                              since trials moved to the no-card path (create-order: the only trial
                              path while DMS opens no subscriptions). */}
                          No card is taken and nothing is charged automatically. Before the trial ends we&apos;ll remind you to pay for the next {trialPer} from your dashboard. You can cancel anytime during the trial.
                        </p>
                        <div className="mt-2 space-y-0.5">
                          <div className="flex justify-between text-xs">
                            <span className="text-purple-700 font-medium">Today (day 1–15)</span>
                            <span className="font-bold text-green-700">₹0</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-purple-700 font-medium">After trial (day 15+)</span>
                            <span className="font-bold text-purple-900">₹{trialAfterPrice.toFixed(2)}/{trialPer}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Payment Amount Breakdown */}
                <div className="bg-gradient-to-br from-primary-50/50 to-indigo-50/50 rounded-xl p-5 mb-6 border border-primary-100/50">
                  <div className="space-y-3">
                    {!hasTrial && (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">Subtotal ({getItemCount()} items)</span>
                          <span className="text-gray-900 font-medium font-mono">₹{(getTotalPrice() / 1.18).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">GST (18%)</span>
                          <span className="text-gray-900 font-medium font-mono">₹{(getTotalPrice() - (getTotalPrice() / 1.18)).toFixed(2)}</span>
                        </div>
                      </>
                    )}
                     <div className={`${!hasTrial ? 'border-t border-primary-200/50 pt-3 ' : ''}flex justify-between items-baseline`}>
                      <span className="text-base font-bold text-gray-900">{hasTrial ? 'Due Today' : 'Estimated total'}</span>
                      <div className="text-right">
                        <span className={`text-3xl font-black font-mono tracking-tight ${hasTrial ? 'text-green-600' : 'text-primary-600'}`}>
                          ₹{getTotalPrice().toFixed(2)}
                        </span>
                        <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mt-1">
                          {hasTrial ? 'Free trial period' : 'Incl. 18% GST — the payment window shows the exact amount'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Payment Methods */}
                <div className="mb-6">
                  <h3 className="font-semibold text-gray-900 mb-3">Accepted Payment Methods</h3>
                  <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                    <div className="flex items-center">
                      <CreditCard className="h-3 w-3 mr-1" />
                      Credit Cards
                    </div>
                    <div className="flex items-center">
                      <CreditCard className="h-3 w-3 mr-1" />
                      Debit Cards
                    </div>
                    <div className="flex items-center">
                      <Smartphone className="h-3 w-3 mr-1" />
                      UPI
                    </div>
                    <div className="flex items-center">
                      <Smartphone className="h-3 w-3 mr-1" />
                      Net Banking
                    </div>
                  </div>
                </div>

                {/* Pay: a trial starts here; a paid cart is ordered through ResellerOS. */}
                {hasTrial ? (
                  <button
                    onClick={handleStartTrial}
                    disabled={isProcessing || isPaymentInProgress || cartItems.length === 0}
                    className="w-full bg-gradient-to-r from-primary-600 to-primary-700 hover:from-primary-700 hover:to-primary-800 disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-lg transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-105 mb-4 flex items-center justify-center space-x-2"
                  >
                    {isProcessing || isPaymentInProgress ? (
                      <>
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                        <span>Starting your trial…</span>
                      </>
                    ) : (
                      <>
                        <span>🎁</span>
                        <span>Start Free Trial — ₹0 Today</span>
                      </>
                    )}
                  </button>
                ) : (
                  <div className="mb-4">
                    <PanelCheckout
                      choice={{ kind: 'cart', items: cartItems, label: `${cartItems.length} item${cartItems.length === 1 ? '' : 's'} in your cart` }}
                      onBack={() => router.push('/cart')}
                      onClose={() => router.push('/dashboard')}
                      onPaid={() => {
                        setPaymentCompleted(true);
                        clearCart();
                      }}
                    />
                  </div>
                )}

                {/* Payment Progress Indicator */}
                {isPaymentInProgress && (
                  <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <div className="flex items-center">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-600 mr-3 flex-shrink-0"></div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-yellow-800">Payment in Progress</p>
                        <p className="text-xs text-yellow-700">
                          Please do not close this page or navigate away.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Support Info */}
                <div className="pt-6 border-t border-gray-200">
                  <p className="text-xs text-gray-600 text-center">
                    Need help? Contact our support team at{' '}
                    <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary-600 hover:underline">
                      {SUPPORT_EMAIL}
                    </a>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Footer />
    </div>
    </>
  );
}
