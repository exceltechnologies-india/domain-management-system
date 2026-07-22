import { listActivePlans } from '@/lib/services/hosting-plans';
import { HOSTING_PLANS } from '@/config/hosting-plans';
import { getHomeVariant } from '@/lib/services/appearance';
import HostingLanding, { type LandingPlan } from '@/components/marketing/HostingLanding';
import DomainHome from '@/components/marketing/DomainHome';

// Render the homepage dynamically so admin toggles (homepage variant, plan/
// price edits, appearance) reflect instantly instead of after the ISR window.
// DB reads here are Redis-cached (Settings + plans), so per-hit load is small.
export const dynamic = 'force-dynamic';

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
  // Homepage design is a toggle (Admin → Pages → Homepage design):
  //   'landing' → the hosting-trial landing (default)
  //   'classic' → the domain-focused homepage
  try {
    if ((await getHomeVariant()) === 'classic') {
      return <DomainHome />;
    }
  } catch {
    // fall through to the default landing
  }

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
