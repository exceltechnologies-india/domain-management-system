'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { CheckCircle, XCircle, ArrowRight, Home, CreditCard, AlertCircle, Clock, Loader2, ReceiptText, Mail } from 'lucide-react';
import Navigation from '@/components/Navigation';
import { safeSessionStorage } from '@/lib/storage';
import Footer from '@/components/Footer';
import { PaymentSuccessPageSkeleton } from '@/components/skeletons/PageSkeletons';
import Link from 'next/link';
import { logger } from '@/lib/logger';
import { homeUrl } from '@/lib/reseller-os';

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';

interface PaymentResult {
  status: 'success' | 'failed' | 'error';
  orderId?: string;
  invoiceNumber?: string;
  successfulDomains?: string[];
  pendingDomains?: string[];
  failedDomains?: Array<{
    domainName: string;
    error?: string;
  }>;
  registrationResults?: Array<{
    domainName: string;
    status: string;
    orderId?: string;
    error?: string;
    itemType?: 'hosting' | 'domain';
    message?: string;
  }>;
  errorMessage?: string;
  errorType?: string;
  message?: string;
  restrictedDomains?: Array<{
    domainName: string;
    reason: string;
  }>;
  supportContact?: string;
  amount?: number;
  currency?: string;
  paymentStatus?: string;
  domainRegistrationStatus?: string;
  requiresSupport?: boolean;
  isGuest?: boolean;
  guestEmail?: string;
}

export default function PaymentResultPage() {
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { data: session } = useSession();
  const userEmail = session?.user?.email;
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Get payment result from session storage (cleaner than URL parameters)
    const paymentResultData = safeSessionStorage.getItem('paymentResult');

    if (paymentResultData) {
      try {
        const parsedResult = JSON.parse(paymentResultData);
        setResult(parsedResult);

        // Clear the session storage after reading
        safeSessionStorage.removeItem('paymentResult');
      } catch (error) {
        logger.error('Error parsing payment result:', error);
        setResult(null);
      }
    } else {
      // Fallback to URL parameters for backward compatibility
      const status = searchParams.get('status');
      const orderId = searchParams.get('orderId');
      const invoiceNumber = searchParams.get('invoiceNumber');
      const successfulDomains = searchParams.get('successfulDomains')?.split(',') || [];
      const errorMessage = searchParams.get('errorMessage');
      const amount = searchParams.get('amount');
      const currency = searchParams.get('currency');

      if (status) {
        setResult({
          status: status as 'success' | 'failed',
          orderId: orderId || undefined,
          invoiceNumber: invoiceNumber || undefined,
          successfulDomains: successfulDomains.length > 0 ? successfulDomains : undefined,
          errorMessage: errorMessage || undefined,
          amount: amount ? parseFloat(amount) : undefined,
          currency: currency || 'INR',
        });
      }
    }

    setIsLoading(false);
  }, [searchParams]);

  // Debug log to see what result is being displayed
  const handleRetryPayment = () => {
    router.push('/checkout');
  };

  const handleGoToDashboard = () => {
    if (!result) {
      router.push('/dashboard');
      return;
    }

    // Check for hosting first (priority as per requirements)
    const hasHosting = result.registrationResults?.some(
      r => r.status === 'success' && r.itemType === 'hosting'
    );

    if (hasHosting) {
      router.push('/dashboard/hosting');
      return;
    }

    // Check for domains
    const hasDomains = (
      result.registrationResults?.some(r => r.status === 'success' && r.itemType === 'domain') ||
      (result.successfulDomains && result.successfulDomains.length > 0)
    );

    if (hasDomains) {
      router.push('/dashboard/domains');
      return;
    }

    router.push('/dashboard');
  };

  const handleGoToHomepage = () => {
    router.push('/');
  };

  if (isLoading) {
    return <PaymentSuccessPageSkeleton />;
  }

  if (!result) {
    return (
      <div className="min-h-screen bg-paper-2 flex flex-col">
        <Navigation />
        <div className="flex-1 max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-16 flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="h-16 w-16 text-ink-4 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-ink mb-2">Payment Result Not Found</h1>
            <p className="text-ink-2 mb-8">We couldn't find the payment result. Please check your order history.</p>
            <div className="space-x-4">
              <Link
                href="/dashboard"
                className="inline-flex items-center px-6 py-3 bg-primary-600 hover:bg-primary-700 text-paper font-semibold rounded-lg transition-colors duration-200"
              >
                <CreditCard className="h-5 w-5 mr-2" />
                Go to Dashboard
              </Link>
              <Link
                href={homeUrl()}
                className="inline-flex items-center px-6 py-3 bg-ink-2 hover:bg-ink text-paper font-semibold rounded-lg transition-colors duration-200"
              >
                <Home className="h-5 w-5 mr-2" />
                Go to Homepage
              </Link>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  if (result.status === 'success') {
    const hasHostingSuccess = result.registrationResults?.some(r => r.itemType === 'hosting' && r.status === 'success');
    const hasDomainSuccess = result.registrationResults?.some(r => r.itemType === 'domain' && r.status === 'success') || (result.successfulDomains && result.successfulDomains.length > 0);
    const hasPending = result.registrationResults?.some(r => r.status === 'pending') || (result.pendingDomains && result.pendingDomains.length > 0);
    const hasFailed = result.failedDomains && result.failedDomains.length > 0;

    return (
      <div className="min-h-screen bg-paper-2 flex flex-col">
        <Navigation />
        <div className="flex-1 max-w-2xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-10 sm:py-14 space-y-4">

          {/* ── Hero: Payment confirmed ── */}
          <div className="bg-paper rounded-xl shadow-sm border border-hairline p-6 sm:p-8 text-center">
            <div className="mx-auto w-16 h-16 bg-emerald-soft rounded-full flex items-center justify-center mb-5">
              <CheckCircle className="h-9 w-9 text-emerald-ink" />
            </div>
            <p className="text-xs font-semibold text-emerald-ink uppercase tracking-widest mb-2">Payment Confirmed</p>
            {result.amount ? (
              <>
                <h1 className="text-5xl font-bold text-ink mb-1">₹{result.amount.toFixed(2)}</h1>
                <p className="text-sm text-ink-4 mb-4">{result.currency || 'INR'} · includes 18% GST</p>
              </>
            ) : (
              <h1 className="text-3xl font-bold text-ink mb-4">Payment Successful</h1>
            )}
            {(userEmail || result.guestEmail) && (
              <p className="text-sm text-ink-2">
                Confirmation email sent to{' '}
                <span className="font-semibold text-ink">{result.guestEmail ?? userEmail}</span>
              </p>
            )}
            {(result.orderId || result.invoiceNumber) && (
              <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-ink-4">
                {result.orderId && (
                  <span>Order: <span className="font-mono">{result.orderId}</span></span>
                )}
                {result.invoiceNumber && (
                  <span>Invoice: <span className="font-mono">{result.invoiceNumber}</span></span>
                )}
              </div>
            )}
          </div>

          {/* ── Hosting: active ── */}
          {hasHostingSuccess && (
            <div className="bg-paper rounded-xl shadow-sm border border-hairline border-l-4 border-l-indigo p-5">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="h-4 w-4 text-indigo-ink flex-shrink-0" />
                <h2 className="text-sm font-semibold text-indigo-ink">Hosting Active</h2>
              </div>
              <div className="space-y-2">
                {result.registrationResults!
                  .filter(r => r.itemType === 'hosting' && r.status === 'success')
                  .map((item, i) => (
                    <div key={i} className="text-sm">
                      <span className="font-mono font-medium text-ink">{item.domainName}</span>
                      {item.message && (
                        <span className="block text-xs text-ink-3 mt-0.5">{item.message}</span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* ── Domains: registered ── */}
          {hasDomainSuccess && (
            <div className="bg-paper rounded-xl shadow-sm border border-hairline border-l-4 border-l-emerald p-5">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="h-4 w-4 text-emerald-ink flex-shrink-0" />
                <h2 className="text-sm font-semibold text-emerald-ink">Domains Registered</h2>
              </div>
              <div className="space-y-1">
                {result.registrationResults
                  ? result.registrationResults
                      .filter(r => r.itemType === 'domain' && r.status === 'success')
                      .map((item, i) => (
                        <p key={i} className="font-mono text-sm text-ink">{item.domainName}</p>
                      ))
                  : result.successfulDomains?.map((d, i) => (
                      <p key={i} className="font-mono text-sm text-ink">{d}</p>
                    ))
                }
              </div>
            </div>
          )}

          {/* ── Pending: in progress ── */}
          {hasPending && (
            <div className="bg-paper rounded-xl shadow-sm border border-hairline border-l-4 border-l-amber p-5">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-4 w-4 text-amber-ink flex-shrink-0" />
                <h2 className="text-sm font-semibold text-amber-ink">Registration in Progress</h2>
              </div>
              <p className="text-xs text-ink-3 mb-3">
                Usually completes in 15 minutes — up to 24 hours for some registries.
              </p>
              <div className="space-y-2">
                {result.registrationResults
                  ? result.registrationResults
                      .filter(r => r.status === 'pending')
                      .map((item, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm text-ink-2">
                          <Loader2 className="h-3 w-3 text-amber animate-spin flex-shrink-0" />
                          <span className="font-mono">{item.domainName}</span>
                          {item.itemType === 'hosting' && (
                            <span className="text-xs bg-indigo-soft text-indigo-ink px-1.5 py-0.5 rounded">Hosting</span>
                          )}
                        </div>
                      ))
                  : result.pendingDomains?.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm text-ink-2">
                        <Loader2 className="h-3 w-3 text-amber animate-spin flex-shrink-0" />
                        <span className="font-mono">{d}</span>
                      </div>
                    ))
                }
              </div>
            </div>
          )}

          {/* ── Failed: needs attention ── */}
          {hasFailed && (
            <div className="bg-paper rounded-xl shadow-sm border border-hairline border-l-4 border-l-rose p-5">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="h-4 w-4 text-rose-ink flex-shrink-0" />
                <h2 className="text-sm font-semibold text-rose-ink">
                  {result.failedDomains!.length === 1
                    ? 'This item failed to register'
                    : `${result.failedDomains!.length} items failed to register`}
                </h2>
              </div>
              <p className="text-xs text-ink-3 mb-3">
                Our support team has been notified. Contact us to resolve this at no extra charge.
                {hasPending && ' Other items on this order are still registering normally.'}
              </p>
              <div className="space-y-2 mb-4">
                {result.failedDomains!.map((d, i) => (
                  <div key={i}>
                    <p className="font-mono text-sm font-medium text-ink">{d.domainName}</p>
                    {d.error && (
                      <p className="text-xs text-ink-3 mt-0.5">{d.error}</p>
                    )}
                  </div>
                ))}
              </div>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="inline-flex items-center gap-2 px-4 py-2 bg-rose hover:bg-rose/90 text-paper text-sm font-semibold rounded-lg transition-colors"
              >
                Contact Support
              </a>
            </div>
          )}

          {/* ── Track order ── */}
          {result.orderId && !result.isGuest && (
            <Link
              href={`/dashboard/orders/${result.orderId}`}
              className="flex items-center justify-between w-full px-5 py-3.5 bg-paper border border-hairline rounded-xl hover:border-primary-300 hover:shadow-sm transition-all group"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary-50 rounded-lg group-hover:bg-primary-100 transition-colors">
                  <ReceiptText className="h-4 w-4 text-primary-600" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-ink">Track your order</p>
                  <p className="text-xs text-ink-3">Live status updates — bookmark this page</p>
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-ink-4 group-hover:text-primary-600 transition-colors" />
            </Link>
          )}

          {/* ── Guest: save your account ── */}
          {result.isGuest && result.guestEmail && (
            <div className="bg-indigo-soft border border-indigo/30 rounded-xl p-5">
              <div className="flex items-start gap-3 mb-3">
                <div className="p-2 bg-indigo-soft rounded-lg flex-shrink-0">
                  <Mail className="h-4 w-4 text-indigo-ink" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-indigo-ink mb-1">Check your email to finish setup</h3>
                  <p className="text-xs text-indigo-ink">
                    We&apos;ve emailed a password setup link to <strong>{result.guestEmail}</strong>.
                    Click the link in that email to choose a password and activate your account.
                    The link expires in 1 hour.
                  </p>
                </div>
              </div>
              <a
                href={`/reset-password?email=${encodeURIComponent(result.guestEmail)}&setup=1`}
                className="inline-flex items-center gap-2 text-xs font-medium text-indigo-ink hover:text-indigo-ink underline underline-offset-2"
              >
                Didn&apos;t get it? Resend setup email
                <ArrowRight className="h-3 w-3" />
              </a>
            </div>
          )}

          {/* ── Primary CTA ── */}
          {!result.isGuest && (
            <button
              onClick={handleGoToDashboard}
              className="w-full bg-primary-600 hover:bg-primary-700 text-paper font-semibold py-3.5 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {hasHostingSuccess && !hasDomainSuccess ? 'View Hosting' : hasDomainSuccess ? 'View Domains' : 'Go to Dashboard'}
              <ArrowRight className="h-4 w-4" />
            </button>
          )}

          <p className="text-center text-xs text-ink-4">
            Need help?{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary-500 hover:text-primary-600">
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>
        <Footer />
      </div>
    );
  }

  // ── Failed / Error state ──────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-paper-2 flex flex-col">
      <Navigation />
      <div className="flex-1 max-w-2xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <div className="bg-paper rounded-xl shadow-sm border border-hairline p-6 sm:p-8">
          {/* Hero */}
          <div className="text-center mb-6">
            <div className="mx-auto w-16 h-16 bg-rose-soft rounded-full flex items-center justify-center mb-4">
              <XCircle className="h-9 w-9 text-rose-ink" />
            </div>
            <h1 className="text-2xl font-bold text-ink mb-2">
              {result.status === 'error' ? 'Order Could Not Be Completed' : 'Payment Not Completed'}
            </h1>
            <p className="text-sm text-ink-3">
              {result.errorMessage || result.message || 'Something went wrong. No charge was made.'}
            </p>
          </div>

          {/* Error-type guidance */}
          {result.errorType === 'network_error' && (
            <div className="bg-amber-soft border border-amber/30 rounded-lg p-4 mb-4 text-sm text-amber-ink">
              <p className="font-medium mb-1">What to do:</p>
              <ul className="space-y-1 text-amber-ink">
                <li>• Check your internet connection</li>
                <li>• Wait a few minutes and check your payment status</li>
                <li>• If you were charged, contact support with your payment details</li>
              </ul>
            </div>
          )}
          {result.errorType === 'card_declined' && (
            <div className="bg-amber-soft border border-amber/30 rounded-lg p-4 mb-4 text-sm text-amber-ink">
              <p className="font-medium mb-1">What to do:</p>
              <ul className="space-y-1 text-amber-ink">
                <li>• Try a different payment method</li>
                <li>• Contact your bank to ensure the card is active</li>
                <li>• Check if you have sufficient funds</li>
              </ul>
            </div>
          )}
          {result.errorType === 'auth_error' && (
            <div className="bg-amber-soft border border-amber/30 rounded-lg p-4 mb-4 text-sm text-amber-ink">
              <p>Please log in again and retry — your cart items have been saved.</p>
            </div>
          )}
          {result.errorType === 'duplicate_payment' && (
            <div className="bg-indigo-soft border border-indigo/30 rounded-lg p-4 mb-4 text-sm text-indigo-ink">
              <p>This payment has already been processed. Check your dashboard for order details.</p>
            </div>
          )}
          {result.errorType === 'user_cancelled' && (
            <div className="bg-paper-2 border border-hairline rounded-lg p-4 mb-4 text-sm text-ink-2">
              <p>No worries — you can retry anytime. Your cart items have been saved.</p>
            </div>
          )}

          {/* Restricted domains */}
          {result.status === 'error' && result.restrictedDomains && (
            <div className="border border-amber/30 rounded-lg p-4 mb-4 text-left">
              <p className="text-sm font-medium text-amber-ink mb-2">Restricted Domains</p>
              <p className="text-xs text-ink-3 mb-3">{result.message}</p>
              <div className="space-y-2">
                {result.restrictedDomains.map((d, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-ink">{d.domainName}</span>
                    <span className="text-xs text-amber-ink">{d.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="space-y-3 mt-6">
            {result.errorType === 'auth_error' ? (
              <button
                onClick={() => router.push('/login')}
                className="w-full bg-primary-600 hover:bg-primary-700 text-paper font-semibold py-3 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                Log In and Retry
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : result.errorType === 'duplicate_payment' ? (
              <button
                onClick={handleGoToDashboard}
                className="w-full bg-primary-600 hover:bg-primary-700 text-paper font-semibold py-3 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                View Dashboard
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleRetryPayment}
                className="w-full bg-primary-600 hover:bg-primary-700 text-paper font-semibold py-3 px-6 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                {result.errorType === 'network_error' ? 'Try Again' : 'Retry Payment'}
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={handleGoToHomepage}
              className="w-full bg-paper hover:bg-paper-2 text-ink-2 font-medium py-3 px-6 rounded-xl border border-hairline transition-colors flex items-center justify-center gap-2"
            >
              <Home className="h-4 w-4" />
              Go to Homepage
            </button>
          </div>

          <p className="text-center text-xs text-ink-4 mt-6">
            Need help?{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary-500 hover:text-primary-600">
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>
      </div>
      <Footer />
    </div>
  );
}
