'use client';

/**
 * "Your bills" — the customer's bills from ResellerOS, on the Invoices page.
 *
 * DMS issues no bills (owner decision, 24 Sep 2026). Decision 29: the bill
 * for a purchase is ResellerOS's paid-order (quote) PDF at once, and its GST
 * tax invoice once staff issue it. A pending quote is a renewal (or an unpaid
 * order) and carries ResellerOS's Pay link.
 *
 * Every state is said out loud. "No bills yet" appears ONLY when ResellerOS
 * has no customer for this email; a failure to read says so instead of
 * rendering an empty table (AGENTS.md §2). Links are opened as plain
 * navigations to ResellerOS — this component never takes a payment itself.
 */
import useSWR from 'swr';
import { AlertCircle, Download, ExternalLink, FileText, Inbox } from 'lucide-react';
import { fetcher } from '@/lib/fetcher';
import { formatIndianDate } from '@/lib/dateUtils';

interface Quote {
  id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'accepted' | 'expired';
  pdfUrl: string | null;
  paymentUrl: string | null;
}

interface Invoice {
  id: string;
  number: string;
  amount: number;
  currency: string;
  status: string;
  issueDate: string | null;
  dueDate: string | null;
  pdfUrl: string | null;
}

export type BillsResponse =
  | { state: 'ok'; quotes: Quote[]; invoices: Invoice[] }
  | { state: 'no_bills' }
  | { state: 'unavailable'; message: string };

/** Whole rupees, as ResellerOS's API returns them. */
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const QUOTE_LABEL: Record<Quote['status'], string> = {
  accepted: 'Paid order',
  pending: 'Awaiting payment',
  expired: 'Expired',
};

const COULD_NOT_REACH =
  "We couldn't load your bills right now. This does not mean you have none. Your bills are also in your email — please refresh in a few minutes.";

export default function ResellerOsBills() {
  const { data, error, isLoading } = useSWR<BillsResponse>('/api/v1/user/billing', fetcher, {
    revalidateOnFocus: false,
  });

  return (
    <div className="bg-white border border-hairline rounded-2xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex items-center gap-2.5">
        <FileText className="h-4 w-4 text-ink-3" />
        <h3 className="text-sm font-semibold text-ink">Your bills</h3>
      </div>

      {isLoading ? (
        <p className="px-6 py-6 text-sm text-ink-3">Loading your bills…</p>
      ) : error || !data ? (
        <Notice text={COULD_NOT_REACH} />
      ) : data.state === 'unavailable' ? (
        <Notice text={data.message} />
      ) : data.state === 'no_bills' ? (
        <div className="py-10 px-6 text-center">
          <Inbox className="h-7 w-7 text-ink-4 mx-auto mb-3" />
          <h4 className="text-sm font-semibold text-ink mb-1">No bills yet</h4>
          <p className="text-sm text-ink-3">Bills for your purchases and renewals will appear here, and are emailed to you.</p>
        </div>
      ) : (
        <BillsTables quotes={data.quotes} invoices={data.invoices} />
      )}
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div role="alert" className="m-5 flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
      <AlertCircle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
      <p className="text-sm text-amber-800">{text}</p>
    </div>
  );
}

function BillsTables({ quotes, invoices }: { quotes: Quote[]; invoices: Invoice[] }) {
  if (quotes.length === 0 && invoices.length === 0) {
    return (
      <div className="py-10 px-6 text-center">
        <Inbox className="h-7 w-7 text-ink-4 mx-auto mb-3" />
        <h4 className="text-sm font-semibold text-ink mb-1">No bills yet</h4>
        <p className="text-sm text-ink-3">Your account is set up for billing, but there are no orders or invoices on it yet.</p>
      </div>
    );
  }
  const due = quotes.filter((q) => q.status === 'pending');
  return (
    <div className="divide-y divide-hairline">
      {due.length > 0 && (
        <p className="px-6 py-3 text-sm text-amber-800 bg-amber-50">
          {due.length === 1 ? 'One bill is' : `${due.length} bills are`} waiting for payment. Pay below to keep your services running.
        </p>
      )}

      {quotes.length > 0 && (
        <section aria-labelledby="ros-orders" className="overflow-x-auto">
          <h4 id="ros-orders" className="px-6 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
            Orders and renewals
          </h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-ink-3">
                <th className="px-6 py-2 font-medium">Number</th>
                <th className="px-6 py-2 font-medium">Amount</th>
                <th className="px-6 py-2 font-medium">Status</th>
                <th className="px-6 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="px-6 py-3 font-mono text-ink">{q.id}</td>
                  <td className="px-6 py-3 font-mono text-ink">{inr(q.amount)}</td>
                  <td className="px-6 py-3 text-ink-2">{QUOTE_LABEL[q.status]}</td>
                  <td className="px-6 py-3 text-right whitespace-nowrap">
                    {q.status === 'pending' && q.paymentUrl && (
                      <a
                        href={q.paymentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 mr-2 px-3 py-1.5 text-xs font-semibold text-paper bg-amber rounded-lg hover:brightness-90"
                      >
                        Pay {inr(q.amount)} <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {q.pdfUrl ? (
                      <a
                        href={q.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-amber-ink"
                        title={`Download ${q.id} (PDF)`}
                      >
                        <Download className="h-3.5 w-3.5" /> PDF
                      </a>
                    ) : (
                      <span className="text-xs text-ink-4">PDF not available</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {invoices.length > 0 && (
        <section aria-labelledby="ros-invoices" className="overflow-x-auto">
          <h4 id="ros-invoices" className="px-6 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
            GST tax invoices
          </h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-ink-3">
                <th className="px-6 py-2 font-medium">Invoice</th>
                <th className="px-6 py-2 font-medium">Date</th>
                <th className="px-6 py-2 font-medium">Amount</th>
                <th className="px-6 py-2 font-medium">Status</th>
                <th className="px-6 py-2 font-medium text-right">PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td className="px-6 py-3 font-mono text-ink">{i.number}</td>
                  <td className="px-6 py-3 text-ink-2">{i.issueDate ? formatIndianDate(i.issueDate) : '—'}</td>
                  <td className="px-6 py-3 font-mono text-ink">{inr(i.amount)}</td>
                  <td className="px-6 py-3 text-ink-2 capitalize">{i.status}</td>
                  <td className="px-6 py-3 text-right">
                    {i.pdfUrl ? (
                      <a
                        href={i.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-amber-ink"
                        title={`Download ${i.number} (PDF)`}
                      >
                        <Download className="h-3.5 w-3.5" /> PDF
                      </a>
                    ) : (
                      <span className="text-xs text-ink-4">PDF not available</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
