import connectDB from "@/lib/mongodb";
import Counter from "@/models/Counter";

/**
 * Primary tax-invoice numbering — see docs on the GST-compliance decision:
 * this series is DISTINCT from Zoho's own invoice-number series (Zoho
 * invoices, created only on primary-engine failure, keep whatever number
 * Zoho itself assigns). Both series are real, sequential, and need to be
 * reported together in GSTR-1 filings.
 */
const SERIES_PREFIX = "TI";

/**
 * Indian fiscal year label for a date: 1 Apr - 31 Mar.
 * e.g. 2026-08-15 -> "2026-27" | 2027-02-01 -> "2026-27" | 2027-04-01 -> "2027-28"
 */
export function fiscalYearLabel(date: Date = new Date()): string {
  const year = date.getFullYear();
  const isBeforeApril = date.getMonth() < 3; // Jan=0 .. Mar=2
  const startYear = isBeforeApril ? year - 1 : year;
  const endYearShort = (startYear + 1) % 100;
  return `${startYear}-${endYearShort.toString().padStart(2, "0")}`;
}

/**
 * Atomically allocates the next gapless number in the primary tax-invoice
 * series for the fiscal year containing `date`, formatted as
 * TI/YYYY-YY/NNNNN (e.g. TI/2026-27/00001).
 *
 * Atomicity comes from Counter's `findOneAndUpdate` + `$inc` (a single
 * MongoDB document-level operation) — concurrent callers allocating for the
 * same fiscal year never receive the same number or leave a gap.
 */
export async function allocateInvoiceNumber(date: Date = new Date()): Promise<string> {
  await connectDB();
  const fy = fiscalYearLabel(date);
  const key = `tax-invoice:${fy}`;

  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );

  const seq = counter.seq.toString().padStart(5, "0");
  return `${SERIES_PREFIX}/${fy}/${seq}`;
}
