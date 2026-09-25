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
import { useState } from 'react';
import Modal from '@/components/Modal';
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
      <DomainSearch
        initialSearchTerm={initialQuery}
        autoSearch={!!initialQuery}
        theme="light"
        showHeroText={false}
        compact
        className="w-full"
        onSelectDomain={(domainName) =>
          setCheckout({ kind: 'domain', domain: domainName, label: `${domainName}, registered for 1 year` })
        }
      />
    </Modal>
  );
}
