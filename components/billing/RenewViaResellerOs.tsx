'use client';

/**
 * The Renew dialog for hosting and domains — a pointer to ResellerOS.
 *
 * Replaces HostingRenewalModal and DomainRenewalModal (25 Sep 2026). Those
 * priced a renewal in DMS and took the payment on DMS's Razorpay account;
 * renewals are ResellerOS's now (owner decisions, 24-25 Sep 2026). This
 * dialog takes no payment: it shows the customer's pending ResellerOS renewal
 * bill(s) with ResellerOS's own Pay link, or says there is none yet and what
 * to do. When ResellerOS pays, its engine command (`hosting.renew` /
 * `domain.renew`) moves the expiry here.
 */
import useSWR from 'swr';
import Link from 'next/link';
import { AlertCircle, ExternalLink } from 'lucide-react';
import Modal from '@/components/Modal';
import { fetcher } from '@/lib/fetcher';
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

export default function RenewViaResellerOs({ isOpen, onClose, serviceName, serviceType }: RenewViaResellerOsProps) {
  const { data, error, isLoading } = useSWR<BillsForRenewal>(isOpen ? '/api/v1/user/billing' : null, fetcher, {
    revalidateOnFocus: false,
  });

  const title = serviceType === 'hosting' ? 'Renew hosting' : 'Renew domain';

  let body: React.ReactNode;
  if (isLoading) {
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
              ? `Pay this bill to renew ${serviceName}. It opens our secure billing page.`
              : `You have ${choice.quotes.length} bills waiting. Pay the one your renewal email names for ${serviceName}.`}
          </p>
          <ul className="divide-y divide-hairline border border-hairline rounded-lg">
            {choice.quotes.map((q) => (
              <li key={q.id} className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-sm text-ink">{q.id}</span>
                <a
                  href={q.paymentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-paper bg-amber rounded-lg hover:brightness-90"
                >
                  Pay {inr(q.amount)} <ExternalLink className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-3">
            Once paid, your {serviceType === 'hosting' ? 'hosting' : 'domain'} is renewed automatically and the new expiry date appears here.
          </p>
        </div>
      );
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="md">
      <p className="text-xs text-ink-3 mb-3 font-mono">{serviceName}</p>
      {body}
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
