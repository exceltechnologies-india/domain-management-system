'use client';

import { useState, useEffect } from 'react';
import FooterClassic from './FooterClassic';
import FooterModern from './FooterModern';
import { apiClient } from '@/lib/api-client';

interface FooterProps {
  className?: string;
}

type FooterVariant = 'classic' | 'modern';

/**
 * Footer switcher. Renders the Modern footer by default (current design) and
 * swaps to the Classic footer if an admin selects it in Admin → Pages.
 * The variant is read at runtime from a public endpoint so the toggle takes
 * effect without a redeploy.
 */
export default function Footer({ className = '' }: FooterProps) {
  const [variant, setVariant] = useState<FooterVariant>('modern');

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await apiClient.get<{ variant?: FooterVariant }>('/api/v1/settings/footer');
      if (active && res.ok && (res.data.variant === 'classic' || res.data.variant === 'modern')) {
        setVariant(res.data.variant);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return variant === 'classic'
    ? <FooterClassic className={className} />
    : <FooterModern className={className} />;
}
