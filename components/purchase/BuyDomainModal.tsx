'use client';

/**
 * Register a domain from inside the customer panel.
 *
 * Replaces `/domains/search` and `/domains/bulk-search` for signed-in
 * customers (owner decision, 24 Sep 2026). It is the same `DomainSearch`
 * component those pages rendered — availability, live price, the
 * requirements modal for restricted TLDs and add-to-cart all come with it —
 * so domain pricing and the cart line are unchanged.
 */
import Modal from '@/components/Modal';
import DomainSearch from '@/components/DomainSearch';

interface BuyDomainModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-fills and runs the search, so a query typed elsewhere is not lost. */
  initialQuery?: string;
}

export default function BuyDomainModal({ isOpen, onClose, initialQuery = '' }: BuyDomainModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Register a domain" size="xl">
      <DomainSearch
        initialSearchTerm={initialQuery}
        autoSearch={!!initialQuery}
        theme="light"
        showHeroText={false}
        compact
        className="w-full"
      />
    </Modal>
  );
}
