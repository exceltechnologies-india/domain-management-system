'use client';

// Thin wrapper hook for domain pricing formatting utilities.
// Live pricing is fetched server-side via the /api/domains/search endpoint.

export function useDomainPricing() {
  const formatPrice = (price: number, currency: string = 'INR') => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(price);
  };

  return { formatPrice };
}
