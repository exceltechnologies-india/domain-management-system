'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useLogout } from '@/lib/logout';
import { safeLocalStorage, safeSessionStorage } from '@/lib/storage';
import { ArrowLeft, CreditCard, Shield, ShieldCheck, ShoppingCart, Globe, Info, Check, Smartphone } from 'lucide-react';
import toast from 'react-hot-toast';
import { useCartStore } from '@/store/cartStore';
import ClientOnly from '@/components/ClientOnly';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import { CheckoutPageSkeleton } from '@/components/skeletons/PageSkeletons';
import OrderTimeline from '@/components/checkout/OrderTimeline';
import { getMinRegistrationPeriod } from '@/lib/tld-min-periods';
import { getDeviceFingerprint } from '@/lib/device-fingerprint';
import type { CartItem } from '@/lib/types';
import { logger } from '@/lib/logger';
import { useRazorpayCheckout } from '@/components/RazorpayCheckoutFrame';

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  profileCompleted?: boolean;
}

export default function CheckoutPage() {
  const [user, setUser] = useState<User | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const handleLogout = useLogout();
  const [isPaymentInProgress, setIsPaymentInProgress] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const router = useRouter();
  const { data: session, status } = useSession();
  const { items: cartItems, getTotalPrice, getSubtotalPrice, getItemCount, clearCart, syncWithServer, isLoading, hasDomainItems, hasHostingItems } = useCartStore();
  const razorpay = useRazorpayCheckout();
  const hasTrial = cartItems.some((i: CartItem) => i.isTrial === true);
  const trialItem = cartItems.find((i: CartItem) => i.isTrial === true);
  const trialYearlyPrice = trialItem ? (trialItem.hostingPlan?.price ?? 0) : 0;

  useEffect(() => {
    // Wait for NextAuth to resolve
    if (status === 'loading') {
      return;
    }

    // Refresh user data from server to get latest profileCompleted status from DB
    const refreshUserData = async () => {
      try {
        let response;
        let userObj: User | null = null;

        // Check if user is logged in via NextAuth (social login)
        if (session?.user) {
          // Social login - use NextAuth cookies
          response = await fetch('/api/v1/auth/me', {
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'include', // Use NextAuth cookies
          });
        } else {
          // Credential login - use JWT token
          const token = safeLocalStorage.getItem('token');
          const userData = safeLocalStorage.getItem('user');

          if (!token || !userData) {
            router.push('/login');
            return;
          }

          userObj = JSON.parse(userData);
          response = await fetch('/api/v1/auth/me', {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          });
        }

        if (response?.ok) {
          const data = await response.json();

          // Ensure profileCompleted is a strict boolean
          const profileCompleted = data.user?.profileCompleted === true ? true : false;

          // Server/DB is the source of truth - always use DB status
          const updatedUser = {
            ...(userObj || session?.user || {}),
            ...data.user,
            profileCompleted: profileCompleted, // Always use strict boolean from DB
          };

          // Update localStorage with latest status from DB
          safeLocalStorage.setItem('user', JSON.stringify(updatedUser));

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

          setUser(updatedUser);
          syncWithServer();
        } else {
          // If API call fails, check localStorage for fallback
          const userData = safeLocalStorage.getItem('user');
          if (userData) {
            try {
              const localUser = JSON.parse(userData);

              if (localUser.role === 'admin') {
                router.push('/admin/dashboard');
                return;
              }

              // Still check DB status even if API call fails
              // For now, redirect to settings if profileCompleted is not explicitly true
              if (localUser.profileCompleted !== true) {
                toast.error('Please complete your profile before checkout');
                router.push('/cart');
                return;
              }

              setUser(localUser);
              syncWithServer();
            } catch (e) {
              router.push('/login');
            }
          } else {
            router.push('/login');
          }
        }
      } catch (error) {
        // Fallback: check localStorage
        const userData = safeLocalStorage.getItem('user');
        if (userData) {
          try {
            const localUser = JSON.parse(userData);
            if (localUser.profileCompleted !== true) {
              toast.error('Please complete your profile before checkout');
              router.push('/cart');
              return;
            }
            setUser(localUser);
            syncWithServer();
          } catch (e) {
            router.push('/login');
          }
        } else {
          router.push('/login');
        }
      }
    };

    refreshUserData();
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

  const handlePayment = async () => {
    if (cartItems.length === 0) {
      toast.error('Cart is empty');
      return;
    }

    // Validate registration periods for all domains
    const invalidDomains = cartItems.filter(item => {
      const minPeriod = getMinRegistrationPeriod(item.domainName);
      return item.registrationPeriod < minPeriod;
    });

    if (invalidDomains.length > 0) {
      const domainNames = invalidDomains.map(d => d.domainName).join(', ');
      toast.error(`Invalid registration period for ${domainNames}. Please check the minimum requirements.`);
      return;
    }

    setIsProcessing(true);
    setIsPaymentInProgress(true);
    try {
      const token = safeLocalStorage.getItem('token');

      // Device fingerprint — used server-side for trial-abuse defenses.
      // Best-effort; absence is non-fatal for non-trial orders.
      const deviceFingerprint = await getDeviceFingerprint().catch(() => '');
      const trialOtpToken = safeSessionStorage.getItem('trial-otp-token') || undefined;

      // Create payment order
      const response = await fetch('/api/v1/payments/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          cartItems: cartItems,
          deviceFingerprint,
          otpToken: trialOtpToken,
        }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.error || 'Failed to create payment order. Please try again.');
        setIsProcessing(false);
        setIsPaymentInProgress(false);
        return;
      }

      const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      if (!keyId) {
        throw new Error('Payment configuration missing: Razorpay key is not set');
      }

      const { razorpayOrderId, razorpaySubscriptionId } = data;

      // Function to verify and finalize
      const verifyPayment = async (orderId: string, paymentId: string, signature: string, subscriptionId?: string) => {
        setIsVerifying(true);
        try {
          const verifyResponse = await fetch('/api/v1/payments/verify', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
              razorpay_order_id: orderId,
              razorpay_payment_id: paymentId,
              razorpay_signature: signature,
              razorpay_subscription_id: subscriptionId,
              cartItems: cartItems,
            }),
            credentials: 'include',
          });

          const verifyData = await verifyResponse.json();

          if (verifyResponse.ok) {
            safeSessionStorage.setItem('paymentResult', JSON.stringify({
              ...verifyData,
              status: 'success',
              amount: getTotalPrice(),
              timestamp: Date.now()
            }));
            setPaymentCompleted(true);
            clearCart();
            setIsPaymentInProgress(false);
            router.push('/payment-success');
          } else {
            toast.error(verifyData.error || 'Payment verification failed');
            setIsVerifying(false);
            setIsProcessing(false);
          }
        } catch (error) {
          logger.error("Verification failed:", error);
          toast.error("An error occurred during verification.");
          setIsVerifying(false);
          setIsProcessing(false);
        }
      };

      const prefill = {
        name: (user ? `${user.firstName} ${user.lastName}` : '').trim(),
        email: (user?.email || '').trim(),
      };

      // Linear flow: order first (if any), then subscription (if any), then verify once.
      interface RazorpayPaymentResult {
        razorpay_order_id?: string;
        razorpay_payment_id: string;
        razorpay_signature?: string;
        razorpay_subscription_id?: string;
      }
      let orderPaymentData: RazorpayPaymentResult | null = null;

      try {
        if (razorpayOrderId) {
          orderPaymentData = await razorpay.open({
            key: keyId,
            name: 'AnuTech Digital',
            description: `Payment for ${cartItems.length} items`,
            order_id: razorpayOrderId,
            prefill,
            theme: { color: '#3b82f6' },
          });

          if (razorpaySubscriptionId) {
            toast.success('Domain payment authorized! Setting up subscription...');
          }
        }

        if (razorpaySubscriptionId) {
          const subResponse = await razorpay.open({
            key: keyId,
            name: 'AnuTech Digital',
            description: 'Hosting Subscription',
            subscription_id: razorpaySubscriptionId,
            prefill,
            theme: { color: '#3b82f6' },
          });

          await verifyPayment(
            orderPaymentData?.razorpay_order_id || '',
            orderPaymentData?.razorpay_payment_id || subResponse.razorpay_payment_id,
            orderPaymentData?.razorpay_signature || subResponse.razorpay_signature,
            subResponse.razorpay_subscription_id
          );
        } else if (orderPaymentData) {
          await verifyPayment(
            orderPaymentData.razorpay_order_id || '',
            orderPaymentData.razorpay_payment_id,
            orderPaymentData.razorpay_signature || ''
          );
        } else {
          throw new Error("No payment target created");
        }
      } catch (err: unknown) {
        // Iframe rejected: user dismissed, or upstream error
        if ((err as { kind?: string })?.kind === 'dismissed') {
          setIsProcessing(false);
          setIsPaymentInProgress(false);
          return;
        }
        throw err;
      }
    } catch (error: unknown) {
      setIsProcessing(false);
      setIsPaymentInProgress(false);
      const message = error instanceof Error ? error.message : 'Payment initialization failed.';
      toast.error(message);
    }
  };

  if (!user || isLoading || cartItems.length === 0) {
    return <CheckoutPageSkeleton />;
  }

  // Render the processing overlay if verification is in progress
  if (isVerifying) {
    // Build a cart-aware processing step label
    const hasDomains = hasDomainItems();
    const hasHosting = hasHostingItems();
    const processingLabel =
      hasDomains && hasHosting
        ? 'Setting up hosting & registering domains...'
        : hasHosting
        ? 'Setting up your hosting account...'
        : 'Registering your domain(s)...';

    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-white/95 backdrop-blur-md">
        <div className="max-w-md w-full px-6 text-center">
          <div className="relative mb-10">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-32 w-32 rounded-full border-4 border-blue-50 border-t-blue-600 animate-spin"></div>
            </div>
            <div className="relative flex items-center justify-center h-32 w-32 mx-auto">
              <ShieldCheck className="h-14 w-14 text-blue-600" />
            </div>
          </div>
          <h2 className="text-3xl font-bold text-gray-900 mb-3 font-outfit">Finalizing Your Order</h2>
          <p className="text-lg text-gray-600 mb-8 leading-relaxed">
            {hasDomains && hasHosting
              ? 'We are securing your domains and setting up your hosting.'
              : hasHosting
              ? 'We are setting up your hosting account.'
              : 'We are registering your domain(s).'}
            {' '}
            <span className="block mt-2 font-semibold text-blue-600 px-4 py-2 bg-blue-50 rounded-full inline-block">Please do not refresh or close this page.</span>
          </p>
          <div className="space-y-4 text-left bg-white shadow-xl shadow-blue-900/5 p-6 rounded-2xl border border-blue-50">
            <div className="flex items-center text-sm font-medium text-gray-700">
              <div className="h-2 w-2 rounded-full bg-green-500 shadow-sm shadow-green-200 mr-3"></div>
              Payment Authorized
            </div>
            <div className="flex items-center text-sm font-medium text-gray-700">
              <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse shadow-sm shadow-blue-200 mr-3"></div>
              {processingLabel}
            </div>
            <div className="flex items-center text-sm font-medium text-gray-400">
              <div className="h-2 w-2 rounded-full bg-gray-200 mr-3"></div>
              Generating invoices & confirmation
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <razorpay.Frame />
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation user={user} onLogout={user ? handleLogout : undefined} />

      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
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

      <div className="flex-1 max-w-7xl mx-auto px-3 sm:px-4 lg:px-6 py-8">
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
                    <div key={index} className="group relative p-4 sm:p-6 border border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-md transition-all duration-200">
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 sm:gap-6">
                        <div className="flex-1">
                          <div className="flex items-center space-x-3 mb-2">
                            <div className="bg-blue-100 p-2 rounded-lg">
                              <Globe className="h-5 w-5 text-blue-600" />
                            </div>
                            <div>
                              <h3 className="text-lg font-medium text-gray-900">
                                {item.itemType === 'hosting' && item.hostingPlan
                                  ? item.hostingPlan.name
                                  : item.domainName}
                              </h3>
                              {item.itemType === 'hosting' ? (
                                <p className="text-sm font-medium text-blue-600 mt-1">
                                  for {item.linkedDomain || item.domainName}
                                </p>
                              ) : (
                                <p className="text-sm font-medium text-gray-500 mt-1">
                                  Domain Registration
                                </p>
                              )}
                              <p className="text-sm text-gray-600">
                                        {item.isTrial
                                  ? '15-Day Free Trial → Yearly subscription'
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
                                <p className="text-xs text-purple-600 font-medium mt-0.5">then ₹{item.price * 12}/yr</p>
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
                <div className="bg-blue-50 rounded-lg p-4">
                  <h3 className="font-semibold text-blue-900 mb-3 flex items-center">
                    <Info className="h-4 w-4 mr-2" />
                    What's Included
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    {cartItems.some(item => item.itemType === 'hosting') ? (
                      // Hosting Features
                      <>
                        <div className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          DirectAdmin Control Panel
                        </div>
                        <div className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          Free SSL Certificates
                        </div>
                        <div className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          24/7 support
                        </div>
                        <div className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          99.9% Uptime Guarantee
                        </div>
                      </>
                    ) : (
                      // Domain Features
                      <>
                        <div className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          Domain Registration
                        </div>
                        <div className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          DNS Management
                        </div>
                        <div className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600" />
                          Domain Lock
                        </div>
                        <div className="flex items-center text-blue-800">
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
                          Your card will be saved for automatic yearly billing after the trial ends. You can cancel anytime during the trial.
                        </p>
                        <div className="mt-2 space-y-0.5">
                          <div className="flex justify-between text-xs">
                            <span className="text-purple-700 font-medium">Today (day 1–15)</span>
                            <span className="font-bold text-green-700">₹0</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-purple-700 font-medium">After trial (day 15+)</span>
                            <span className="font-bold text-purple-900">₹{trialItem?.price ? trialItem.price * 12 : '—'}/year</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Payment Amount Breakdown */}
                <div className="bg-gradient-to-br from-blue-50/50 to-indigo-50/50 rounded-xl p-5 mb-6 border border-blue-100/50">
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
                     <div className={`${!hasTrial ? 'border-t border-blue-200/50 pt-3 ' : ''}flex justify-between items-baseline`}>
                      <span className="text-base font-bold text-gray-900">{hasTrial ? 'Due Today' : 'Total Amount'}</span>
                      <div className="text-right">
                        <span className={`text-3xl font-black font-mono tracking-tight ${hasTrial ? 'text-green-600' : 'text-blue-600'}`}>
                          ₹{getTotalPrice().toFixed(2)}
                        </span>
                        <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mt-1">
                          {hasTrial ? 'Free trial period' : 'Including 18% GST'}
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

                {/* Payment Button */}
                <button
                  onClick={handlePayment}
                  disabled={isProcessing || isPaymentInProgress || cartItems.length === 0}
                  className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-lg transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-105 mb-4 flex items-center justify-center space-x-2"
                >
                  {isProcessing || isPaymentInProgress ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                      <span>{isPaymentInProgress ? 'Payment in Progress...' : 'Processing...'}</span>
                    </>
                  ) : hasTrial ? (
                    <>
                      <span>🎁</span>
                      <span>Start Free Trial — ₹0 Today</span>
                    </>
                  ) : (
                    <>
                      <CreditCard className="h-5 w-5" />
                      <span>
                        Pay ₹{getTotalPrice().toFixed(2)}
                      </span>
                    </>
                  )}
                </button>

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
                    <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
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
