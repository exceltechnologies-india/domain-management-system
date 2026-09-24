'use client';

/**
 * Opens the in-panel purchase dialog named by `?buy=` — see
 * `lib/purchase/buy-dialog.ts` for why it is a URL parameter.
 *
 * Closing removes `buy` and `q` and keeps every other parameter, with
 * `replace` so the browser's Back button does not reopen the dialog.
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import BuyHostingModal from './BuyHostingModal';
import BuyDomainModal from './BuyDomainModal';
import { BUY_PARAM, QUERY_PARAM, parseBuyKind } from '@/lib/purchase/buy-dialog';

export default function PurchaseDialogs() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const kind = parseBuyKind(params.get(BUY_PARAM));
  const query = params.get(QUERY_PARAM) ?? '';

  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete(BUY_PARAM);
    next.delete(QUERY_PARAM);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <>
      <BuyHostingModal isOpen={kind === 'hosting'} onClose={close} />
      <BuyDomainModal isOpen={kind === 'domain'} onClose={close} initialQuery={query} />
    </>
  );
}
