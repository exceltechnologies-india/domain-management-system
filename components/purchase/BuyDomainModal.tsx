'use client';

/**
 * Register a domain from inside the customer panel.
 *
 * Replaces `/domains/search` and `/domains/bulk-search` for signed-in
 * customers (owner decision, 24 Sep 2026). The search is the same
 * `DomainSearch` component those pages rendered — availability and the
 * requirements modal for restricted TLDs come with it.
 *
 * Choosing a name no longer adds it to DMS's cart (owner decision 30,
 * 25 Sep 2026: ResellerOS creates every Razorpay order). It opens
 * PanelCheckout, which asks ResellerOS for the order. ResellerOS charges the
 * LIVE ResellerClub price, re-checked at that moment — so the figure the
 * search shows is a guide, and the payment window shows the real one.
 */
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { BadgeCheck, CalendarRange, ReceiptText, Server } from 'lucide-react';
import Modal from '@/components/Modal';
import { buyHref } from '@/lib/purchase/buy-dialog';
import DomainSearch from '@/components/DomainSearch';
import PanelCheckout, { type PanelPurchaseChoice } from '@/components/purchase/PanelCheckout';

interface BuyDomainModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-fills and runs the search, so a query typed elsewhere is not lost. */
  initialQuery?: string;
}

export default function BuyDomainModal({ isOpen, onClose, initialQuery = '' }: BuyDomainModalProps) {
  const [checkout, setCheckout] = useState<PanelPurchaseChoice | null>(null);
  const [searched, setSearched] = useState(!!initialQuery);
  const onSearchedChange = useCallback((s: boolean) => setSearched(s), []);

  const close = () => {
    setCheckout(null);
    onClose();
  };

  if (checkout) {
    return (
      <Modal isOpen={isOpen} onClose={close} title="Register a domain" size="lg">
        <PanelCheckout choice={checkout} onBack={() => setCheckout(null)} onClose={close} />
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={close} title="Register a domain" size="xl">
      {/* The empty state (9 Oct 2026): it was a lone search box with a faded button. Now a line on
          what to type, and four facts that are true of every domain bought here. */}
      {!searched && (
        <p className="mx-auto mb-4 mt-4 max-w-4xl px-4 text-sm text-ink-2 sm:mt-0">
          Type the name you want — with or without an extension. We check .in, .com and more, and show
          the price of each before you pay.
        </p>
      )}
      <DomainSearch
        onSearchedChange={onSearchedChange}
        initialSearchTerm={initialQuery}
        autoSearch={!!initialQuery}
        theme="light"
        showHeroText={false}
        compact
        className="w-full"
        onSelectDomain={(domainName) =>
          // The checkout adds the term the customer picks ("for 3 years"); the label is the name alone.
          setCheckout({ kind: 'domain', domain: domainName, label: domainName })
        }
      />
      {!searched && (
        <ul className="mx-auto mt-5 grid max-w-4xl grid-cols-1 gap-3 px-4 sm:grid-cols-2">
          <li className="flex items-start gap-3 rounded-xl border border-hairline bg-paper-2 p-3">
            <BadgeCheck className="mt-0.5 h-5 w-5 flex-none text-emerald-ink" aria-hidden />
            <span className="text-sm text-ink-2">
              <span className="block font-semibold text-ink">Registered in your name</span>
              You own it — your details go on the registration.
            </span>
          </li>
          <li className="flex items-start gap-3 rounded-xl border border-hairline bg-paper-2 p-3">
            <CalendarRange className="mt-0.5 h-5 w-5 flex-none text-primary-600" aria-hidden />
            <span className="text-sm text-ink-2">
              <span className="block font-semibold text-ink">1, 2, 3 or 5 years</span>
              Choose the term at checkout, with the price for each.
            </span>
          </li>
          <li className="flex items-start gap-3 rounded-xl border border-hairline bg-paper-2 p-3">
            <ReceiptText className="mt-0.5 h-5 w-5 flex-none text-indigo-ink" aria-hidden />
            <span className="text-sm text-ink-2">
              <span className="block font-semibold text-ink">GST invoice on every order</span>
              Emailed to you and kept on the Invoices page.
            </span>
          </li>
          <li className="flex items-start gap-3 rounded-xl border border-hairline bg-paper-2 p-3">
            <Server className="mt-0.5 h-5 w-5 flex-none text-amber-ink" aria-hidden />
            <span className="text-sm text-ink-2">
              <span className="block font-semibold text-ink">Need a website too?</span>
              The first year is free with yearly hosting.{' '}
              <Link href={buyHref('hosting')} className="font-semibold text-primary-600 underline-offset-2 hover:underline">
                Buy hosting
              </Link>
            </span>
          </li>
        </ul>
      )}
    </Modal>
  );
}
