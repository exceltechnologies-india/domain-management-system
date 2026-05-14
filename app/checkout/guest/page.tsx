'use client';

import { useState, useEffect, Suspense, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, CreditCard, Globe, Check, ShieldCheck, Smartphone, Info,
  User as UserIcon, Mail, Phone, MapPin, Building, Hash, Navigation as NavigationIcon, Loader2,
  Server, ShoppingCart,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useCartStore } from '@/store/cartStore';
import { safeSessionStorage } from '@/lib/storage';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import Link from 'next/link';
import { getMinRegistrationPeriod } from '@/lib/tld-min-periods';
import { INDIAN_STATES } from '@/lib/constants';
import { getDeviceFingerprint } from '@/lib/device-fingerprint';

declare global {
  interface Window { Razorpay: any; }
}

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';

const PHONE_RE = /^\d{10}$/;
const ZIP_RE = /^\d{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function GuestCheckoutInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { items: cartItems, getTotalPrice, getItemCount, clearCart, isLoading } = useCartStore();

  // Hydration-safe mounted flag: cartItems come from Zustand-persist which
  // reads localStorage synchronously, so the server-rendered HTML (empty
  // cart) differs from the first client render (populated cart). Gating
  // cart-dependent UI behind `mounted` avoids React hydration error #418.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Registrant details — required by ResellerClub for WHOIS contact
  const [guestEmail, setGuestEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipcode, setZipcode] = useState('');

  const [guestToken, setGuestToken] = useState<string | null>(null);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const [isPaymentInProgress, setIsPaymentInProgress] = useState(false);

  const detailsValid = useMemo(() => {
    return (
      EMAIL_RE.test(guestEmail.trim()) &&
      firstName.trim().length > 0 &&
      lastName.trim().length > 0 &&
      PHONE_RE.test(phone) &&
      addressLine1.trim().length > 0 &&
      city.trim().length > 0 &&
      state.trim().length > 0 &&
      ZIP_RE.test(zipcode)
    );
  }, [guestEmail, firstName, lastName, phone, addressLine1, city, state, zipcode]);

  // Pre-fill email from URL query param (set by cart page)
  useEffect(() => {
    const emailParam = searchParams.get('email');
    const tokenParam = searchParams.get('token');
    if (emailParam) setGuestEmail(decodeURIComponent(emailParam));
    if (tokenParam) setGuestToken(tokenParam);
  }, [searchParams]);

  // Load Razorpay script
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
    return () => { if (document.body.contains(script)) document.body.removeChild(script); };
  }, []);

  // Redirect if cart is empty
  useEffect(() => {
    if (!isLoading && cartItems.length === 0 && !paymentCompleted) {
      router.replace('/cart');
    }
  }, [cartItems.length, isLoading, paymentCompleted, router]);

  // Guard: trials require login (1-per-user lifetime eligibility), but
  // paid hosting + domains are fine for guest checkout.
  useEffect(() => {
    if (!isLoading && cartItems.some((i: any) => i.isTrial === true)) {
      toast.error('Free trials require an account. Please sign in.');
      router.replace('/cart');
    }
  }, [cartItems, isLoading, router]);

  const handleDetectLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not supported by your browser');
      return;
    }
    setIsDetectingLocation(true);
    const t = toast.loading('Detecting your location…');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&addressdetails=1&accept-language=en`,
            { headers: { Accept: 'application/json' } }
          );
          if (!res.ok) throw new Error();
          const data = await res.json();
          const addr = data.address || {};

          // Address line 1 — be permissive. Indian residential pin-points
          // often lack house_number/road in Nominatim but do return suburb,
          // neighbourhood, hamlet, quarter or building. Chain through the
          // common shapes until we have something useful.
          const lineParts = [
            addr.house_number,
            addr.road || addr.street || addr.pedestrian || addr.path,
            addr.building,
            addr.neighbourhood || addr.suburb || addr.quarter ||
              addr.residential || addr.hamlet,
          ].filter(Boolean);
          const detectedLine1 =
            lineParts.length > 0
              ? lineParts.join(', ')
              : (data.display_name?.split(',').slice(0, 2).join(',').trim() || '');

          const detectedCity =
            addr.city || addr.town || addr.municipality || addr.village ||
            addr.county || addr.state_district || '';

          // State — Nominatim returns the full name which sometimes doesn't
          // match the dropdown verbatim ("NCT of Delhi", "Orissa", etc).
          // Normalise + fuzzy-match against the canonical INDIAN_STATES list.
          const detectedRawState: string = addr.state || addr['ISO3166-2-lvl4'] || '';
          const stateAliases: Record<string, string> = {
            'national capital territory of delhi': 'Delhi',
            'nct of delhi': 'Delhi',
            'delhi nct': 'Delhi',
            'orissa': 'Odisha',
            'pondicherry': 'Puducherry',
            'uttaranchal': 'Uttarakhand',
            'jammu & kashmir': 'Jammu and Kashmir',
            'j&k': 'Jammu and Kashmir',
            'andaman & nicobar': 'Andaman and Nicobar Islands',
            'tamilnadu': 'Tamil Nadu',
          };
          const normaliseState = (raw: string): string => {
            if (!raw) return '';
            const k = raw.toLowerCase().trim();
            if (stateAliases[k]) return stateAliases[k];
            // Exact (case-insensitive) match against canonical list
            const exact = INDIAN_STATES.find(
              (s) => s.toLowerCase() === k
            );
            if (exact) return exact;
            // Substring fallback — e.g. "Delhi NCT" contains "delhi"
            const fuzzy = INDIAN_STATES.find(
              (s) => k.includes(s.toLowerCase()) || s.toLowerCase().includes(k)
            );
            return fuzzy || '';
          };
          const detectedState = normaliseState(detectedRawState);

          const detectedZip = addr.postcode || '';

          if (detectedLine1) setAddressLine1(detectedLine1);
          if (detectedCity) setCity(detectedCity);
          if (detectedState) setState(detectedState);
          if (detectedZip) setZipcode(detectedZip);

          // Surface partial-fill cases so the user knows what's missing.
          const missing: string[] = [];
          if (!detectedLine1) missing.push('address');
          if (!detectedState) missing.push('state');
          if (missing.length > 0) {
            toast.success(
              `Location detected — please fill in ${missing.join(' and ')} manually.`,
              { id: t }
            );
          } else {
            toast.success('Location detected!', { id: t });
          }
        } catch {
          toast.error('Could not get address from location', { id: t });
        } finally {
          setIsDetectingLocation(false);
        }
      },
      (err) => {
        const msgs: Record<number, string> = {
          1: 'Location permission denied',
          2: 'Location unavailable',
          3: 'Location request timed out',
        };
        toast.error(msgs[err.code] || 'Failed to detect location', { id: t });
        setIsDetectingLocation(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handlePayment = async () => {
    if (cartItems.length === 0) { toast.error('Cart is empty'); return; }
    if (!detailsValid) { toast.error('Please complete all registrant details'); return; }

    const email = guestEmail.trim().toLowerCase();

    // Validate min registration periods
    const invalid = cartItems.filter((item) => {
      const min = getMinRegistrationPeriod(item.domainName);
      return item.registrationPeriod < min;
    });
    if (invalid.length > 0) {
      toast.error(`Invalid registration period for ${invalid.map((d) => d.domainName).join(', ')}`);
      return;
    }

    if (typeof window === 'undefined' || !window.Razorpay) {
      toast.error('Payment script not loaded. Please refresh and try again.');
      return;
    }

    setIsProcessing(true);
    setIsPaymentInProgress(true);

    try {
      // Best-effort browser fingerprint — used server-side as an anti-abuse
      // signal alongside the IP hash.
      const deviceFingerprint = await getDeviceFingerprint().catch(() => '');

      // Create order — registrant details are sent on first call and signed
      // into the guestToken; subsequent calls reuse the token's signed values.
      const orderRes = await fetch('/api/payments/guest/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          cartItems,
          guestToken: guestToken ?? undefined,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone,
          addressLine1: addressLine1.trim(),
          city: city.trim(),
          state,
          zipcode,
          deviceFingerprint,
        }),
      });

      const orderData = await orderRes.json();
      if (!orderRes.ok) {
        toast.error(orderData.error || 'Failed to create payment order');
        setIsProcessing(false);
        setIsPaymentInProgress(false);
        return;
      }

      const { razorpayOrderId, guestToken: newToken, email: confirmedEmail } = orderData;
      setGuestToken(newToken);

      const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      if (!keyId) throw new Error('Payment configuration missing');

      const verifyPayment = async (orderId: string, paymentId: string, signature: string) => {
        setIsVerifying(true);
        try {
          const verifyRes = await fetch('/api/payments/guest/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              guestToken: newToken,
              razorpay_order_id: orderId,
              razorpay_payment_id: paymentId,
              razorpay_signature: signature,
              cartItems,
            }),
          });

          const verifyData = await verifyRes.json();
          if (verifyRes.ok) {
            safeSessionStorage.setItem('paymentResult', JSON.stringify({
              ...verifyData,
              status: 'success',
              amount: getTotalPrice(),
              timestamp: Date.now(),
              isGuest: true,
              guestEmail: confirmedEmail ?? email,
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
        } catch {
          toast.error('Verification error — please contact support');
          setIsVerifying(false);
          setIsProcessing(false);
        }
      };

      const rzpOptions = {
        key: keyId,
        name: 'AnuTech Digital',
        description: `Domain registration (${getItemCount()} item${getItemCount() !== 1 ? 's' : ''})`,
        order_id: razorpayOrderId,
        handler: async (response: any) => {
          await verifyPayment(
            response.razorpay_order_id,
            response.razorpay_payment_id,
            response.razorpay_signature
          );
        },
        prefill: {
          email: confirmedEmail ?? email,
          name: `${firstName.trim()} ${lastName.trim()}`.trim(),
          contact: `+91${phone}`,
        },
        theme: { color: '#3b82f6' },
        modal: {
          ondismiss: () => {
            setIsProcessing(false);
            setIsPaymentInProgress(false);
          },
        },
      };

      const rzp = new window.Razorpay(rzpOptions);
      rzp.open();
    } catch (error: any) {
      toast.error(error?.message || 'Payment initialization failed');
      setIsProcessing(false);
      setIsPaymentInProgress(false);
    }
  };

  // Render a neutral loader during the SSR + hydration window so the first
  // client render matches the server's empty-cart HTML. After mount the
  // cart store is fully hydrated and we can render the real content.
  if (!mounted || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (isVerifying) {
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
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Finalizing Your Order</h2>
          <p className="text-lg text-gray-600 mb-8">
            Registering your domain(s)…{' '}
            <span className="block mt-2 font-semibold text-blue-600 px-4 py-2 bg-blue-50 rounded-full inline-block">
              Please do not close this page.
            </span>
          </p>
          <div className="space-y-4 text-left bg-white shadow-xl p-6 rounded-2xl border border-blue-50">
            <div className="flex items-center text-sm font-medium text-gray-700">
              <div className="h-2 w-2 rounded-full bg-green-500 mr-3"></div>Payment Authorized
            </div>
            <div className="flex items-center text-sm font-medium text-gray-700">
              <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse mr-3"></div>Registering domain(s)…
            </div>
            <div className="flex items-center text-sm font-medium text-gray-400">
              <div className="h-2 w-2 rounded-full bg-gray-200 mr-3"></div>Generating confirmation
            </div>
          </div>
        </div>
      </div>
    );
  }

  const fieldDisabled = isProcessing || isPaymentInProgress;
  const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500";
  const iconInputCls = "w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navigation user={null} />

      <div className="flex-1 w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 py-8 pt-24">

        {/* ── Header strip ── */}
        <div className="mb-6">
          <Link
            href="/cart"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors mb-3"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Cart
          </Link>
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 sm:px-6 py-4 sm:py-5 flex items-start gap-4">
              <div className="p-2.5 bg-blue-50 rounded-xl shrink-0">
                <ShoppingCart className="h-5 w-5 text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Guest Checkout</h1>
                <p className="text-xs sm:text-sm text-gray-500 mt-1">
                  No account needed — receipts and access details go to the email you provide.
                </p>
              </div>
              <div className="hidden sm:flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full shrink-0">
                <ShieldCheck className="h-3.5 w-3.5" />
                Secure
              </div>
            </div>
          </div>
        </div>

        <div className="grid lg:grid-cols-6 xl:grid-cols-7 gap-6 lg:gap-8 min-h-[50vh]">
          {/* Main column */}
          <div className="lg:col-span-4 xl:col-span-5 space-y-6">

            {/* Order Summary */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4 text-gray-500" />
                  <h2 className="text-sm font-semibold text-gray-900">Order Summary</h2>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1 rounded-full">
                  {cartItems.length} item{cartItems.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="p-4 sm:p-6 space-y-3">
                {cartItems.map((item, index) => {
                  const isHosting = item.itemType === 'hosting';
                  const displayName = isHosting
                    ? (item.hostingPlan?.name || 'Hosting')
                    : item.domainName;
                  const periodLabel = isHosting
                    ? (item.registrationPeriod === 12
                        ? 'Hosting · 1 year subscription'
                        : `Hosting · ${item.registrationPeriod} month${item.registrationPeriod !== 1 ? 's' : ''} subscription`)
                    : `Domain Registration · ${item.registrationPeriod || 1} year${(item.registrationPeriod || 1) !== 1 ? 's' : ''}`;
                  const lineTotal = item.price * (item.registrationPeriod || 1);
                  return (
                    <div key={index} className="p-4 border border-gray-200 rounded-xl hover:border-blue-200 hover:shadow-sm transition-all">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className={`p-2 rounded-lg flex-shrink-0 ${isHosting ? 'bg-purple-50' : 'bg-blue-50'}`}>
                            {isHosting
                              ? <Server className="h-5 w-5 text-purple-600" />
                              : <Globe className="h-5 w-5 text-blue-600" />}
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-base font-semibold text-gray-900 truncate">{displayName}</h3>
                            <p className="text-xs sm:text-sm text-gray-500 mt-0.5">{periodLabel}</p>
                            {isHosting && item.linkedDomain && (
                              <p className="text-xs text-blue-600 mt-1 truncate">
                                Domain: {item.linkedDomain}
                              </p>
                            )}
                          </div>
                        </div>
                        <p className="text-base sm:text-lg font-bold text-gray-900 whitespace-nowrap">
                          ₹{lineTotal.toFixed(2)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* What's included — adaptive to cart contents */}
              <div className="px-5 sm:px-6 pb-5 sm:pb-6">
                <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-4">
                  <h3 className="font-semibold text-blue-900 mb-3 flex items-center text-sm">
                    <Info className="h-4 w-4 mr-2" />
                    What's Included
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 text-sm">
                    {(() => {
                      const has = (t: 'domain' | 'hosting') =>
                        cartItems.some((i) => (i.itemType || 'domain') === t);
                      const features: string[] = [];
                      if (has('domain')) {
                        features.push('Domain Registration', 'DNS Management', 'Domain Lock');
                      }
                      if (has('hosting')) {
                        features.push('DirectAdmin Control Panel', 'Free SSL Certificate', 'Daily Backups');
                      }
                      features.push('24/7 Support');
                      return features.map((feature) => (
                        <div key={feature} className="flex items-center text-blue-800">
                          <Check className="h-4 w-4 mr-2 text-green-600 flex-shrink-0" />
                          {feature}
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              </div>
            </div>

            {/* Registrant Details */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <UserIcon className="h-4 w-4 text-gray-500" />
                  <h2 className="text-sm font-semibold text-gray-900">Registrant Contact Details</h2>
                </div>
                <ShieldCheck className="h-4 w-4 text-blue-500" />
              </div>
              <div className="p-4 sm:p-6">
                <p className="text-sm text-gray-500 mb-5">
                  Required by ICANN for the domain's public WHOIS record. We send these
                  to our registrar as the registrant contact.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">First Name</label>
                    <div className="relative">
                      <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <input
                        value={firstName}
                        onChange={e => setFirstName(e.target.value)}
                        placeholder="First name"
                        maxLength={50}
                        disabled={fieldDisabled}
                        className={iconInputCls}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Last Name</label>
                    <input
                      value={lastName}
                      onChange={e => setLastName(e.target.value)}
                      placeholder="Last name"
                      maxLength={50}
                      disabled={fieldDisabled}
                      className={inputCls}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Email</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <input
                        type="email"
                        value={guestEmail}
                        onChange={e => setGuestEmail(e.target.value)}
                        placeholder="you@example.com"
                        disabled={fieldDisabled}
                        className={iconInputCls}
                      />
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Receipt and domain details will be sent here.</p>
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Phone</label>
                    <div className="flex">
                      <span className="flex items-center px-3 py-2 border border-r-0 border-gray-300 rounded-l-lg bg-gray-50 text-sm text-gray-600 font-medium select-none">
                        🇮🇳 +91
                      </span>
                      <div className="relative flex-1">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                        <input
                          type="tel"
                          inputMode="numeric"
                          value={phone}
                          onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                          placeholder="10-digit mobile number"
                          disabled={fieldDisabled}
                          className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-r-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="sm:col-span-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide">Address</label>
                      <button
                        type="button"
                        onClick={handleDetectLocation}
                        disabled={fieldDisabled || isDetectingLocation}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Use my current location to auto-fill the address"
                      >
                        {isDetectingLocation
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <NavigationIcon className="h-3 w-3" />}
                        {isDetectingLocation ? 'Detecting…' : 'Auto-detect'}
                      </button>
                    </div>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <textarea
                        value={addressLine1}
                        onChange={e => setAddressLine1(e.target.value)}
                        rows={2}
                        placeholder="Street address, building, area"
                        disabled={fieldDisabled}
                        className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">City</label>
                    <div className="relative">
                      <Building className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <input
                        value={city}
                        onChange={e => setCity(e.target.value)}
                        placeholder="City"
                        maxLength={50}
                        disabled={fieldDisabled}
                        className={iconInputCls}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">State</label>
                    <select
                      value={state}
                      onChange={e => setState(e.target.value)}
                      disabled={fieldDisabled}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
                    >
                      <option value="" disabled>Select state</option>
                      {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">PIN Code</label>
                    <div className="relative">
                      <Hash className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <input
                        value={zipcode}
                        onChange={e => setZipcode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="6-digit PIN"
                        inputMode="numeric"
                        disabled={fieldDisabled}
                        className={iconInputCls}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1.5">Country</label>
                    <div className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-500 select-none">
                      🇮🇳 India
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Sign in CTA */}
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
              <strong>Have an account?</strong>{' '}
              <Link href={`/login?returnUrl=${encodeURIComponent('/checkout')}`} className="underline font-medium">
                Sign in
              </Link>{' '}
              for order history, DNS management, and auto-renewal.
            </div>
          </div>

          {/* Payment Panel */}
          <div className="lg:col-span-2 xl:col-span-2">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 sticky top-24 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-gray-500" />
                <h2 className="text-sm font-semibold text-gray-900">Secure Payment</h2>
              </div>
              <div className="p-5 sm:p-6 space-y-5">

                {/* Amount breakdown */}
                <div className="bg-gradient-to-br from-blue-50/50 to-indigo-50/50 rounded-xl p-5 border border-blue-100/50">
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Subtotal ({getItemCount()} item{getItemCount() !== 1 ? 's' : ''})</span>
                      <span className="font-medium font-mono">₹{(getTotalPrice() / 1.18).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">GST (18%)</span>
                      <span className="font-medium font-mono">₹{(getTotalPrice() - getTotalPrice() / 1.18).toFixed(2)}</span>
                    </div>
                    <div className="border-t border-blue-200/50 pt-3 flex justify-between items-baseline">
                      <span className="text-base font-bold text-gray-900">Total</span>
                      <span className="text-3xl font-black text-blue-600 font-mono">
                        ₹{getTotalPrice().toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Payment methods */}
                <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                  <div className="flex items-center"><CreditCard className="h-3 w-3 mr-1" />Credit Cards</div>
                  <div className="flex items-center"><CreditCard className="h-3 w-3 mr-1" />Debit Cards</div>
                  <div className="flex items-center"><Smartphone className="h-3 w-3 mr-1" />UPI</div>
                  <div className="flex items-center"><Smartphone className="h-3 w-3 mr-1" />Net Banking</div>
                </div>

                {!detailsValid && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Complete the registrant details on the left to enable payment.
                  </div>
                )}

                {/* Pay button */}
                <button
                  onClick={handlePayment}
                  disabled={isProcessing || isPaymentInProgress || cartItems.length === 0 || !detailsValid}
                  className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed text-white font-semibold py-3 px-4 rounded-lg transition-all duration-200 shadow-lg flex items-center justify-center space-x-2"
                >
                  {isProcessing || isPaymentInProgress ? (
                    <>
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                      <span>Processing…</span>
                    </>
                  ) : (
                    <>
                      <CreditCard className="h-5 w-5" />
                      <span>Pay ₹{getTotalPrice().toFixed(2)}</span>
                    </>
                  )}
                </button>

                <p className="text-xs text-gray-500 text-center">
                  Need help?{' '}
                  <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
                    {SUPPORT_EMAIL}
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
}

export default function GuestCheckoutPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    }>
      <GuestCheckoutInner />
    </Suspense>
  );
}
