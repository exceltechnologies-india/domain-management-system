'use client';

import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';

export interface SocialLink { url: string; enabled: boolean; }
export type SocialLinks = Record<'linkedin' | 'facebook' | 'instagram', SocialLink>;

const DEFAULT_SOCIAL: SocialLinks = {
  linkedin: { url: 'https://www.linkedin.com/company/anutech-digital-pvt-ltd/', enabled: true },
  facebook: { url: 'https://www.facebook.com/profile.php?id=61568334534264', enabled: true },
  instagram: { url: 'https://www.instagram.com/anutech_digital/', enabled: true },
};

export interface SiteVisibility {
  showGstin: boolean;
  showPhone: boolean;
  social: SocialLinks;
}

/**
 * Reads the admin-controlled public contact-detail visibility toggles
 * (GSTIN + phone number) from the public settings endpoint at runtime, so
 * they flip without a redeploy. Defaults to shown so content never flashes
 * hidden while loading.
 */
export function useSiteVisibility(): SiteVisibility {
  const [vis, setVis] = useState<SiteVisibility>({ showGstin: true, showPhone: true, social: DEFAULT_SOCIAL });

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await apiClient.get<{ showGstin?: boolean; showPhone?: boolean; social?: SocialLinks }>(
        '/api/v1/settings/visibility',
      );
      if (active && res.ok) {
        setVis({
          showGstin: res.data.showGstin !== false,
          showPhone: res.data.showPhone !== false,
          social: res.data.social ?? DEFAULT_SOCIAL,
        });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return vis;
}
