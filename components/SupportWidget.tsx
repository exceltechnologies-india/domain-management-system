'use client';

import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import ChatWidget from './ChatWidget';
import WhatsAppWidget from './WhatsAppWidget';

type SupportVariant = 'chatbot' | 'whatsapp';

/**
 * Support-widget switcher. Renders the AI chatbot by default and swaps to the
 * WhatsApp button if an admin selects it in Admin → Pages → Appearance. The
 * variant + company number are read at runtime from a public endpoint so the
 * toggle takes effect without a redeploy. Falls back to the chatbot if
 * WhatsApp is selected but no number is configured yet.
 */
export default function SupportWidget() {
  const [variant, setVariant] = useState<SupportVariant>('chatbot');
  const [whatsappNumber, setWhatsappNumber] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await apiClient.get<{ variant?: SupportVariant; whatsappNumber?: string }>(
        '/api/v1/settings/support-widget',
      );
      if (active && res.ok) {
        if (res.data.variant === 'whatsapp' || res.data.variant === 'chatbot') setVariant(res.data.variant);
        if (typeof res.data.whatsappNumber === 'string') setWhatsappNumber(res.data.whatsappNumber);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (variant === 'whatsapp' && whatsappNumber) {
    return <WhatsAppWidget number={whatsappNumber} message="Hi Anutech, I'd like some help." />;
  }
  return <ChatWidget />;
}
