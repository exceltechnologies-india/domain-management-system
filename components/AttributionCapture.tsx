'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { ATTR_COOKIE, ANON_COOKIE } from '@/lib/attribution';

function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}
function genAnonId(): string {
  return 'a_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}
function track(activity: string, anonId: string | null) {
  try {
    fetch('/api/v1/analytics/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity, anonId }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never break the page */
  }
}

/**
 * Captures first-touch attribution (UTM / fbclid / landing / referrer) into a
 * cookie once, ensures an anonymous visitor id, and fires the client-side
 * journey events (landing_page_visit always; view_content on /hosting).
 * Renders nothing. Mounted globally in the root layout.
 */
export default function AttributionCapture() {
  const pathname = usePathname();

  // Once per full load: anon id + first-touch attribution + landing visit.
  useEffect(() => {
    let anon = getCookie(ANON_COOKIE);
    if (!anon) {
      anon = genAnonId();
      setCookie(ANON_COOKIE, anon, 365);
    }

    if (!getCookie(ATTR_COOKIE)) {
      const p = new URLSearchParams(window.location.search);
      const attr = {
        utmSource: p.get('utm_source') || undefined,
        utmMedium: p.get('utm_medium') || undefined,
        utmCampaign: p.get('utm_campaign') || undefined,
        utmContent: p.get('utm_content') || undefined,
        utmTerm: p.get('utm_term') || undefined,
        fbclid: p.get('fbclid') || undefined,
        landingPage: window.location.pathname + window.location.search,
        referrer: document.referrer || undefined,
        firstVisitAt: new Date().toISOString(),
      };
      setCookie(ATTR_COOKIE, encodeURIComponent(JSON.stringify(attr)), 365);
    }

    track('landing_page_visit', anon);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // view_content whenever the visitor lands on /hosting (incl. SPA nav).
  useEffect(() => {
    if (pathname === '/hosting') {
      track('view_content', getCookie(ANON_COOKIE));
    }
  }, [pathname]);

  return null;
}
