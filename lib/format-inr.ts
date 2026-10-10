/**
 * Rupees the Indian way: ₹1,770 / ₹2,788.34 (lakh grouping, paise only when there are any).
 * The portal cart printed ₹1770.00 and ₹2788.34 (9 Oct 2026).
 */
export function formatINR(amount: number): string {
  const n = Math.round(amount * 100) / 100;
  const whole = Number.isInteger(n);
  return `\u20b9${n.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}
