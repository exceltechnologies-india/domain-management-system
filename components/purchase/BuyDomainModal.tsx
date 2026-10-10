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
import { Check } from 'lucide-react';
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
      {/* A quiet checklist, not cards (9 Oct 2026: four bordered boxes read as options to pick and
          drowned the search). Every point is true of every domain bought here. */}
      {!searched && (
        <div className="mx-auto mt-4 max-w-4xl px-4">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-2">
            {['Registered in your name', '1, 2, 3 or 5 years', 'GST invoice on every order'].map((t) => (
              <li key={t} className="inline-flex items-center gap-1.5">
                <Check className="h-4 w-4 flex-none text-emerald-ink" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
          <p className="mt-4 border-t border-hairline pt-4 text-sm text-ink-3">
            Need a website too? The first year of the domain is free with yearly hosting.{' '}
            <Link href={buyHref('hosting')} className="font-semibold text-primary-600 underline-offset-2 hover:underline">
              Buy hosting
            </Link>
          </p>
        </div>
      )}
    </Modal>
  );
}
