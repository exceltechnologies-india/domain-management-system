'use client';

/**
 * The Renew dialog for hosting and domains — pays ResellerOS's renewal bill here.
 *
 * Replaces HostingRenewalModal and DomainRenewalModal (25 Sep 2026). Those
 * priced a renewal in DMS and took the payment on DMS's Razorpay account;
 * renewals are ResellerOS's now (owner decisions, 24-25 Sep 2026). This dialog
 * shows the customer's pending ResellerOS renewal bill(s), or says there is none
 * yet and what to do. Since 28 Sep 2026 (owner: an existing customer renews inside
 * the panel) Pay opens Razorpay in this panel: /api/user/renewal-order asks
 * ResellerOS for the order, and the price is ResellerOS's. When ResellerOS is
 * paid, its engine command (`hosting.renew` / `domain.renew`) moves the expiry here.
 */
import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { AlertCircle, CheckCircle } from 'lucide-react';
import Modal from '@/components/Modal';
import { fetcher } from '@/lib/fetcher';
import { apiClient } from '@/lib/api-client';
import { useRazorpayCheckout } from '@/components/RazorpayCheckoutFrame';
import { razorpayThemeColor } from '@/lib/theme-color';
import {
  noRenewalQuoteMessage,
  renewalChoice,
  type BillsForRenewal,
} from '@/lib/reselleros/renewal-choice';

interface RenewViaResellerOsProps {
  isOpen: boolean;
  onClose: () => void;
  serviceName: string;
  serviceType: 'hosting' | 'domain';
}

const SUPPORT = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

interface RenewalOrderResponse {
  orderId: string;
  amount: number;
  currency: string;
  razorpayKeyId: string;
  quoteId: string;
  prefill: { name: string; email: string; contact: string };
}

type PayState =
  | { step: 'idle' }
  | { step: 'working'; quoteId: string }
  | { step: 'paid'; quoteId: string }
  | { step: 'dismissed'; quoteId: string };

export default function RenewViaResellerOs({ isOpen, onClose, serviceName, serviceType }: RenewViaResellerOsProps) {
  const { data, error, isLoading } = useSWR<BillsForRenewal>(isOpen ? '/api/v1/user/billing' : null, fetcher, {
    revalidateOnFocus: false,
  });
  const razorpay = useRazorpayCheckout();
  const [pay, setPay] = useState<PayState>({ step: 'idle' });
  const [payError, setPayError] = useState<string | null>(null);

  const title = serviceType === 'hosting' ? 'Renew hosting' : 'Renew domain';
  const what = serviceType === 'hosting' ? 'hosting' : 'domain';

  const payNow = async (quoteId: string) => {
    setPayError(null);
    setPay({ step: 'working', quoteId });
    const res = await apiClient.post<RenewalOrderResponse>('/api/v1/user/renewal-order', { quoteId });
    if (!res.ok) {
      // The route writes every refusal for the customer; status 0 never reached us.
      setPayError(
        res.error.status === 0
          ? "We couldn't reach our server, so the payment wasn't started. Nothing was charged. Check your connection and try again."
          : res.error.message,
      );
      setPay({ step: 'idle' });
      return;
    }
    const order = res.data;
    try {
      await razorpay.open({
        key: order.razorpayKeyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: 'Anutech',
        description: `Renewal ${order.quoteId} — ${serviceName}`,
        prefill: order.prefill,
        theme: { color: razorpayThemeColor() },
      });
      setPay({ step: 'paid', quoteId: order.quoteId });
    } catch {
      setPay({ step: 'dismissed', quoteId: order.quoteId });
    }
  };

  let body: React.ReactNode;
  if (pay.step === 'paid') {
    body = (
      <div className="text-center py-4">
        <CheckCircle className="h-10 w-10 text-emerald-600 mx-auto mb-3" />
        <h3 className="font-serif text-xl text-ink mb-2">Payment received</h3>
        <p className="text-sm text-ink-2">
          Your {what} is being renewed — this usually takes a few minutes, and the new expiry date appears here when it is done.
          Your bill ({pay.quoteId}) is emailed to you and is on the Invoices page.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link href="/dashboard/invoices" className="px-4 py-2 text-sm font-semibold text-paper bg-amber rounded-lg hover:brightness-90">
            Go to Invoices
          </Link>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ink-2 border border-hairline rounded-lg hover:bg-paper-2">
            Close
          </button>
        </div>
      </div>
    );
  } else if (isLoading) {
    body = <p className="text-sm text-ink-3">Checking for your renewal bill…</p>;
  } else if (error || !data) {
    body = (
      <Notice
        text={`We couldn't check for your renewal bill right now, so we can't tell whether one is waiting. Your renewal bill is also in your email — please try again in a few minutes, or email ${SUPPORT}.`}
      />
    );
  } else {
    const choice = renewalChoice(data);
    if (choice.kind === 'unavailable') {
      body = <Notice text={choice.message} />;
    } else if (choice.kind === 'none') {
      body = (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">{noRenewalQuoteMessage(serviceName, SUPPORT)}</p>
          <Link href="/dashboard/support" className="inline-block text-sm font-medium text-amber-ink underline">
            Contact support
          </Link>
        </div>
      );
    } else {
      body = (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">
            {choice.quotes.length === 1
              ? `Pay this bill to renew ${serviceName}.`
              : `You have ${choice.quotes.length} bills waiting. Pay the one your renewal email names for ${serviceName}.`}
          </p>
          {pay.step === 'dismissed' && (
            <Notice
              text={`Payment not completed. Nothing was charged — the payment window was closed before paying, so ${pay.quoteId} is still unpaid. Press Pay to try again.`}
            />
          )}
          {payError && <Notice text={payError} />}
          <ul className="divide-y divide-hairline border border-hairline rounded-lg">
            {choice.quotes.map((q) => (
              <li key={q.id} className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-sm text-ink">{q.id}</span>
                <button
                  type="button"
                  onClick={() => void payNow(q.id)}
                  disabled={pay.step === 'working'}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-paper bg-amber rounded-lg hover:brightness-90 disabled:opacity-60"
                >
                  {pay.step === 'working' && pay.quoteId === q.id ? 'Starting payment…' : `Pay ${inr(q.amount)}`}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-3">
            Once paid, your {what} is renewed automatically and the new expiry date appears here.
          </p>
        </div>
      );
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      <p className="text-xs text-ink-3 mb-3 font-mono">{serviceName}</p>
      {body}
      <razorpay.Frame />
    </Modal>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div role="alert" className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
      <AlertCircle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
      <p className="text-sm text-amber-800">{text}</p>
    </div>
  );
}
