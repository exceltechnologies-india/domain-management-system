'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

interface SpaPageViewsProps {
  enabled: boolean;
  ga4Id: string;
  googleAdsId: string;
  metaPixelId: string;
}

/**
 * Fires a PageView on Next.js client-side (SPA) route changes so analytics
 * counts in-app navigations, not just full page loads. The initial load is
 * already tracked by the inline tags in TrackingScripts, so we skip the first
 * render and only fire on subsequent pathname changes.
 *
 * Renders nothing. Mounted only on public pages (TrackingScripts returns null
 * on admin/dashboard), and only when opted in via the admin toggle.
 */
export default function SpaPageViews({ enabled, ga4Id, googleAdsId, metaPixelId }: SpaPageViewsProps) {
  const pathname = usePathname();
  const isFirst = useRef(true);

  useEffect(() => {
    if (!enabled) return;
    // Skip the very first pathname (the initial page load already sent a
    // PageView via the server-rendered tags).
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }

    const w = window as unknown as {
      fbq?: (...args: unknown[]) => void;
      gtag?: (...args: unknown[]) => void;
    };

    // Meta / Facebook Pixel
    if (metaPixelId && typeof w.fbq === 'function') {
      w.fbq('track', 'PageView');
    }
    // Google Analytics 4 — send a page_view for the new path.
    if (ga4Id && typeof w.gtag === 'function') {
      w.gtag('event', 'page_view', {
        page_path: pathname,
        page_location: window.location.href,
        page_title: document.title,
      });
    }
    // Google Ads — re-fire the config on navigation so remarketing tags
    // register the new page.
    if (googleAdsId && typeof w.gtag === 'function') {
      w.gtag('config', googleAdsId, { page_path: pathname });
    }
  }, [pathname, enabled, ga4Id, googleAdsId, metaPixelId]);

  return null;
}
