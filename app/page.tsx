import { listActivePlans } from '@/lib/services/hosting-plans';
import HostingLanding, { type LandingPlan } from '@/components/marketing/HostingLanding';

// Revalidate the homepage every 5 minutes so plan/price edits made in
// Admin → TLD Pricing / hosting packages reflect without a rebuild, while
// keeping the homepage cached (no per-request DB hit under load).
export const revalidate = 300;

export default async function HomePage() {
  let plans: LandingPlan[] = [];
  try {
    const docs = await listActivePlans({ sort: 'price-asc' });
    plans = docs
      // Exclude ₹1 admin test plans / placeholders from the public homepage.
      .filter((p) => (p.price ?? 0) > 1)
      .map((p) => ({
        planId: p.planId,
        name: p.name,
        description: p.description || '',
        price: p.price,
        renewalPrice: p.renewalPrice ?? 0,
        currency: p.currency || 'INR',
        features: Array.isArray(p.features) ? p.features : [],
      }));
  } catch {
    // If the DB is briefly unreachable, render the landing without a pricing
    // grid rather than 500-ing the homepage.
    plans = [];
  }

  return <HostingLanding plans={plans} />;
}
