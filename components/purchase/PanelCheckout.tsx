'use client';

/**
 * The paid step of an in-panel purchase: billing details, then Razorpay.
 *
 * Owner decision 30 (25 Sep 2026): the Razorpay order is created by ResellerOS
 * (through /api/user/panel-order), on ResellerOS's account, with ResellerOS's
 * key. So when Razorpay reports success this component does NOTHING on the
 * server — no verify call, no DMS order, no invoice, no provisioning.
 * ResellerOS's own webhook records the payment and sets the service up through
 * the engine. Calling DMS's /api/payments/verify here would be wrong twice: its
 * signature check uses DMS's secret, and it would record a second copy of a
 * sale DMS no longer owns.
 *
 * The price shown before paying is the one Razorpay shows — ResellerOS's own.
 * This component never displays a DMS price as the charge.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useRazorpayCheckout } from '@/components/RazorpayCheckoutFrame';
import { razorpayThemeColor } from '@/lib/theme-color';
import { mapCartToPanelOrder, type CartLineLike } from '@/lib/reselleros/cart-lines';

export type PanelPurchaseChoice =
  | { kind: 'hosting'; planId: 'starter' | 'standard' | 'plus'; cycle: 'monthly' | 'yearly'; label: string }
  | { kind: 'domain'; domain: string; label: string }
  /** The DMS /cart (owner, 25 Sep 2026: "Route through ResellerOS"). The
   * server maps each line to a ResellerOS sku and refuses one it can't. */
  | { kind: 'cart'; items: CartLineLike[]; label: string };

interface Prefill {
  name: string;
  email: string;
  phoneOnFile: boolean;
  companyName: string;
  gstin: string;
  address: { line1: string; city: string; state: string; zipcode: string } | null;
}

interface OrderResponse {
  success: true;
  orderId: string;
  amount: number;
  currency: string;
  razorpayKeyId: string;
  quoteId: string | null;
  totalRupees: number | null;
  prefill: { name: string; email: string; contact: string };
}

type Phase =
  | { step: 'form' }
  | { step: 'working' }
  | { step: 'paid'; quoteId: string | null }
  | { step: 'dismissed'; quoteId: string | null };

interface PanelCheckoutProps {
  choice: PanelPurchaseChoice;
  onBack: () => void;
  onClose: () => void;
  /** Called once Razorpay reports the payment (e.g. to empty the cart). */
  onPaid?: () => void;
}

const inputCls = 'w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber';

export default function PanelCheckout({ choice, onBack, onClose, onPaid }: PanelCheckoutProps) {
  const razorpay = useRazorpayCheckout();
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: 'form' });
  const [error, setError] = useState<string | null>(null);

  const [hostingDomain, setHostingDomain] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [gstin, setGstin] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipcode, setZipcode] = useState('');

  // For a cart, the same mapper the server uses decides; if it refuses, the
  // server will too, and its message is shown before anything is sent.
  const cartMapping = choice.kind === 'cart' ? mapCartToPanelOrder(choice.items) : null;
  const needsAddress = choice.kind === 'domain' || (cartMapping?.ok === true && cartMapping.needsAddress);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await apiClient.get<Prefill>('/api/v1/user/panel-order', undefined, { cache: 'no-store' });
      if (cancelled) return;
      if (!res.ok) {
        // Not fatal: the customer can still type the details. Said, not hidden.
        setPrefillError("We couldn't load the details saved on your account, so please fill them in.");
        return;
      }
      setPrefill(res.data);
      setCompanyName(res.data.companyName);
      setGstin(res.data.gstin);
      if (res.data.address) {
        setLine1(res.data.address.line1);
        setCity(res.data.address.city);
        setState(res.data.address.state);
        setZipcode(res.data.address.zipcode);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pay = async () => {
    setError(null);
    setPhase({ step: 'working' });
    const purchase =
      choice.kind === 'hosting'
        ? { kind: 'hosting' as const, planId: choice.planId, cycle: choice.cycle, domain: hostingDomain.trim() }
        : choice.kind === 'cart'
          ? { kind: 'cart' as const, items: choice.items }
          : { kind: 'domain' as const, domain: choice.domain };
    const res = await apiClient.post<OrderResponse>('/api/v1/user/panel-order', {
      purchase,
      companyName: companyName.trim(),
      ...(gstin.trim() ? { gstin: gstin.trim() } : {}),
      ...(needsAddress ? { address: { line1, city, state, zipcode, country: 'IN' } } : {}),
    });
    if (!res.ok) {
      // The route writes every refusal for the customer: what happened, why,
      // and what to do. Network failure (status 0) never reached DMS at all.
      setError(
        res.error.status === 0
          ? "We couldn't reach our server, so the order wasn't started. Nothing was charged. Check your connection and try again."
          : res.error.message,
      );
      setPhase({ step: 'form' });
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
        description: choice.label,
        prefill: order.prefill,
        theme: { color: razorpayThemeColor() },
      });
      setPhase({ step: 'paid', quoteId: order.quoteId });
      onPaid?.();
    } catch {
      setPhase({ step: 'dismissed', quoteId: order.quoteId });
    }
  };

  if (phase.step === 'paid') {
    return (
      <div className="text-center py-6">
        <CheckCircle className="h-10 w-10 text-emerald-600 mx-auto mb-3" />
        <h3 className="font-serif text-xl text-ink mb-2">Payment received</h3>
        <p className="text-sm text-ink-2 max-w-md mx-auto">
          Your {choice.kind === 'hosting' ? 'hosting' : choice.kind === 'domain' ? 'domain' : 'order'} is being set up — this usually takes a few minutes, and
          it will appear in your panel when it's ready. Your bill{phase.quoteId ? ` (${phase.quoteId})` : ''} is emailed to
          you and will be on the Invoices page.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <Link href="/dashboard/invoices" className="px-4 py-2 text-sm font-semibold text-paper bg-amber rounded-lg hover:brightness-90">
            Go to Invoices
          </Link>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ink-2 border border-hairline rounded-lg hover:bg-paper-2">
            Close
          </button>
        </div>
      </div>
    );
  }

  if (phase.step === 'dismissed') {
    return (
      <div className="text-center py-6">
        <AlertTriangle className="h-10 w-10 text-amber mx-auto mb-3" />
        <h3 className="font-serif text-xl text-ink mb-2">Payment not completed</h3>
        <p className="text-sm text-ink-2 max-w-md mx-auto">
          Nothing was charged. The payment window was closed before paying, so your order
          {phase.quoteId ? ` (${phase.quoteId})` : ''} is still unpaid. You can pay it from the Invoices page, or start again.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <button type="button" onClick={() => setPhase({ step: 'form' })} className="px-4 py-2 text-sm font-semibold text-paper bg-amber rounded-lg hover:brightness-90">
            Try again
          </button>
          <Link href="/dashboard/invoices" className="px-4 py-2 text-sm text-ink-2 border border-hairline rounded-lg hover:bg-paper-2">
            Go to Invoices
          </Link>
        </div>
      </div>
    );
  }

  const working = phase.step === 'working';
  const cartRefusal = cartMapping && !cartMapping.ok ? cartMapping.message : null;
  const missingRequired =
    !!cartRefusal ||
    companyName.trim().length < 2 ||
    (choice.kind === 'hosting' && hostingDomain.trim().length < 3) ||
    (needsAddress && (!line1.trim() || !city.trim() || !state.trim() || zipcode.trim().length < 3));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void pay();
      }}
    >
      <p className="text-sm text-ink-2">
        You're buying <span className="font-semibold text-ink">{choice.label}</span>. The exact price, including GST, is shown
        in the payment window before you pay.
      </p>

      {cartMapping?.ok === true && (
        <ul className="text-sm text-ink-2 list-disc pl-5">
          {cartMapping.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {cartRefusal && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {cartRefusal}
        </div>
      )}

      {prefillError && <p className="text-xs text-ink-3">{prefillError}</p>}
      {prefill && !prefill.phoneOnFile && (
        <p className="text-xs text-red-700">
          Your account has no mobile number, and the order needs one.{' '}
          <Link href="/dashboard/settings" className="underline">Add it in Settings</Link>, then come back.
        </p>
      )}

      {choice.kind === 'hosting' && (
        <div>
          <label htmlFor="panel-hosting-domain" className="block text-xs font-medium text-ink-2 mb-1">
            Domain the hosting is for
          </label>
          <input
            id="panel-hosting-domain"
            className={inputCls}
            value={hostingDomain}
            onChange={(e) => setHostingDomain(e.target.value)}
            placeholder="yourbusiness.in"
            autoComplete="off"
            required
          />
          <p className="mt-1 text-xs text-ink-3">A domain you already own. Need a new one? Register it first from Buy a domain.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="panel-company" className="block text-xs font-medium text-ink-2 mb-1">
            Company name (or your name)
          </label>
          <input id="panel-company" className={inputCls} value={companyName} onChange={(e) => setCompanyName(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="panel-gstin" className="block text-xs font-medium text-ink-2 mb-1">
            GSTIN (optional)
          </label>
          <input id="panel-gstin" className={inputCls} value={gstin} onChange={(e) => setGstin(e.target.value)} maxLength={20} />
        </div>
      </div>

      {needsAddress && (
        <fieldset className="space-y-3">
          <legend className="text-xs font-medium text-ink-2">
            Registrant address — the domain is registered in your name, and the registry needs it
          </legend>
          <div>
            <label htmlFor="panel-line1" className="sr-only">Address</label>
            <input id="panel-line1" className={inputCls} value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Street address" required />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="panel-city" className="sr-only">City</label>
              <input id="panel-city" className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" required />
            </div>
            <div>
              <label htmlFor="panel-state" className="sr-only">State</label>
              <input id="panel-state" className={inputCls} value={state} onChange={(e) => setState(e.target.value)} placeholder="State" required />
            </div>
            <div>
              <label htmlFor="panel-zip" className="sr-only">PIN code</label>
              <input id="panel-zip" className={inputCls} value={zipcode} onChange={(e) => setZipcode(e.target.value)} placeholder="PIN code" required />
            </div>
          </div>
        </fieldset>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex justify-between gap-3 pt-2">
        <button type="button" onClick={onBack} disabled={working} className="px-4 py-2 text-sm text-ink-2 border border-hairline rounded-lg hover:bg-paper-2 disabled:opacity-50">
          Back
        </button>
        <button
          type="submit"
          disabled={working || missingRequired}
          className="px-5 py-2 text-sm font-semibold text-paper bg-amber rounded-lg hover:brightness-90 disabled:opacity-50"
        >
          {working ? 'Starting payment…' : 'Continue to payment'}
        </button>
      </div>
      <razorpay.Frame />
    </form>
  );
}
