'use client';

import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';

export interface SiteVisibility {
  showGstin: boolean;
  showPhone: boolean;
}

/**
 * Reads the admin-controlled public contact-detail visibility toggles
 * (GSTIN + phone number) from the public settings endpoint at runtime, so
 * they flip without a redeploy. Defaults to shown so content never flashes
 * hidden while loading.
 */
export function useSiteVisibility(): SiteVisibility {
  const [vis, setVis] = useState<SiteVisibility>({ showGstin: true, showPhone: true });

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await apiClient.get<{ showGstin?: boolean; showPhone?: boolean }>(
        '/api/v1/settings/visibility',
      );
      if (active && res.ok) {
        setVis({
          showGstin: res.data.showGstin !== false,
          showPhone: res.data.showPhone !== false,
        });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return vis;
}
