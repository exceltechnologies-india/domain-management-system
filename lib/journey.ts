/**
 * Client-side customer-journey tracking helpers.
 *
 * Each journey action fires (a) the Meta Pixel browser event and (b) the
 * internal analytics beacon, sharing an `event_id` so a future server-side
 * Conversions API event can be deduplicated against the browser one (SRS §5).
 *
 * All functions are browser-safe no-ops during SSR / when the Pixel is absent.
 */

import { ANON_COOKIE } from '@/lib/attribution';

export function getAnonId(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp('(?:^|; )' + ANON_COOKIE + '=([^;]*)'));
  return m ? m[1] : null;
}

/** Stable-ish unique id shared between the browser event and any server twin. */
export function makeEventId(name: string): string {
  return `${name}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

type Fbq = (...args: unknown[]) => void;

/** Fire a Meta Pixel browser event (standard or custom) with an eventID. */
export function fireMetaEvent(
  name: string,
  opts: { custom?: boolean; params?: Record<string, unknown>; eventID?: string } = {},
): string {
  const eventID = opts.eventID || makeEventId(name);
  if (typeof window !== 'undefined') {
    const w = window as unknown as { fbq?: Fbq };
    if (typeof w.fbq === 'function') {
      w.fbq(opts.custom ? 'trackCustom' : 'track', name, opts.params || {}, { eventID });
    }
  }
  return eventID;
}

/** Record an internal journey activity via the public beacon. */
export function trackClientActivity(activity: string): void {
  if (typeof window === 'undefined') return;
  try {
    fetch('/api/v1/analytics/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity, anonId: getAnonId() }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never break the UI */
  }
}

// ── Journey wrappers (Pixel event + internal activity) ─────────────────────

export function trackViewContent(): void {
  fireMetaEvent('ViewContent', { params: { content_category: 'hosting', content_type: 'product' } });
  trackClientActivity('view_content');
}

export function trackStartTrial(): void {
  // NOTE: the Meta `StartTrial` conversion event is fired SERVER-side only when
  // the trial is actually provisioned (DA account assigned + hosting active) —
  // see lib/services/analytics-conversions.ts. The browser click records only
  // the internal funnel activity, so the ad campaign never counts an
  // unfulfilled trial click as a StartTrial conversion.
  trackClientActivity('start_trial');
}

export function trackInitiateCheckout(params?: Record<string, unknown>): void {
  fireMetaEvent('InitiateCheckout', { params: params || {} });
  trackClientActivity('checkout_started');
}
