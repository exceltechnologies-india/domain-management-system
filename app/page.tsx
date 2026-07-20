import { listActivePlans } from '@/lib/services/hosting-plans';
import { HOSTING_PLANS } from '@/config/hosting-plans';
import HostingLanding, { type LandingPlan } from '@/components/marketing/HostingLanding';

// Revalidate the homepage every 5 minutes so plan/price edits made in the
// admin reflect without a rebuild, while keeping the homepage cached.
export const revalidate = 300;

function gb(mb: number): string {
  return mb > 0 ? `${Math.round(mb / 1000)} GB` : 'Unmetered';
}

// Display features when a DB plan has none stored — keeps the pricing cards
// looking complete. Prefers the config feature list (matched by name), else
// derives a sensible list from the plan's quota/bandwidth.
function fallbackFeatures(name: string, quotaMB: number, bandwidthMB: number): string[] {
  const cfg = HOSTING_PLANS[(name || '').toLowerCase()];
  if (cfg?.features?.length) return cfg.features;
  return [
    `${gb(quotaMB)} NVMe Storage`,
    bandwidthMB < 0 ? 'Unmetered Bandwidth' : `${gb(bandwidthMB)} Bandwidth`,
    'Unlimited Free SSL',
    'Free Website Migration',
    '99.99% Uptime Guarantee',
    'Daily Backups',
  ];
}

export default async function HomePage() {
  let plans: LandingPlan[] = [];
  try {
    const docs = await listActivePlans({ sort: 'price-asc' });
    plans = docs
      .filter((p) => (p.price ?? 0) > 1) // exclude ₹1 test plans / placeholders
      .map((p) => {
        const cfg = HOSTING_PLANS[(p.name || '').toLowerCase()];
        const features = Array.isArray(p.features) && p.features.length
          ? p.features
          : fallbackFeatures(p.name, p.quota ?? 0, p.bandwidth ?? 0);
        return {
          planId: p.planId,
          name: p.name,
          description: p.description || cfg?.description || '',
          price: p.price,
          currency: p.currency || 'INR',
          features,
          highlightFeatures: cfg?.highlightFeatures ?? [],
          isPopular: Boolean(cfg?.isPopular),
        };
      });
    // Guarantee exactly one "Most Popular" ribbon.
    if (plans.length && !plans.some((p) => p.isPopular)) {
      plans[Math.min(1, plans.length - 1)].isPopular = true;
    }
  } catch {
    plans = [];
  }

  return <HostingLanding plans={plans} />;
}
