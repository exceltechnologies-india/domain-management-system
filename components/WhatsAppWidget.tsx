'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface WhatsAppWidgetProps {
  /** Company WhatsApp number, international digits only (e.g. "919876543210"). */
  number: string;
  /** Pre-filled message the customer's WhatsApp opens with. */
  message?: string;
}

/**
 * Floating WhatsApp support button. Opens a WhatsApp chat with the company
 * number directly (wa.me deep link — works on both mobile app and WhatsApp
 * Web). Rendered in place of the AI chatbot when an admin selects the
 * "WhatsApp" support widget in Admin → Pages → Appearance.
 */
export default function WhatsAppWidget({ number, message }: WhatsAppWidgetProps) {
  const [showTip, setShowTip] = useState(true);

  const digits = (number || '').replace(/[^0-9]/g, '');
  if (!digits) return null;

  const href = `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex items-end gap-2">
      <AnimatePresence>
        {showTip && (
          <motion.div
            initial={{ opacity: 0, x: 12, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 12, scale: 0.9 }}
            transition={{ duration: 0.25 }}
            className="relative mb-1 max-w-[220px] rounded-2xl bg-white px-4 py-3 shadow-xl ring-1 ring-black/5"
          >
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setShowTip(false)}
              className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-gray-500 shadow hover:bg-gray-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <p className="text-sm font-semibold text-gray-900">Need help?</p>
            <p className="text-xs text-gray-500">Chat with us on WhatsApp</p>
            <span className="absolute -bottom-1.5 right-6 h-3 w-3 rotate-45 bg-white" />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Chat with us on WhatsApp"
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-[#25D366] to-[#128C7E] text-white shadow-[0_8px_24px_rgba(18,140,126,0.5)] ring-1 ring-white/30"
      >
        {/* WhatsApp glyph */}
        <svg viewBox="0 0 24 24" className="h-7 w-7 fill-current" aria-hidden="true">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
        </svg>
      </motion.a>
    </div>
  );
}
