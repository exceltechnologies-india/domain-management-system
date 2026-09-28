import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { useModalScroll } from '@/hooks/useModalScroll';

/**
 * Shared admin/app modal. Chrome matches ResellerOS's Dialog so a modal opened
 * over the converted panels belongs to the same app: `bg-ink/40 backdrop-blur-sm`
 * overlay, `bg-paper` panel on a hairline border, and a SERIF title — that last
 * one is the design language's signature and the thing that most makes a dialog
 * read as ours.
 *
 * Five callers (admin users / orders / hosting-pending, DomainRequirementsModal,
 * DomainSelectionModal), so this file is the one place to change them.
 */

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnOverlayClick?: boolean;
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  closeOnOverlayClick = true
}: ModalProps) {
  // Handle modal scroll behavior
  useModalScroll(isOpen);

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl'
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-center justify-center p-4">
            {/* Background overlay */}
            <motion.div
              /* Stable hook for the overlay-click tests. They used to select it
                 by `.bg-gray-500.bg-opacity-75` — styling classes — so the
                 restyle made querySelector return null. One test then failed
                 honestly and the OTHER ("closeOnOverlayClick=false suppresses
                 the callback") started passing for the wrong reason: clicking
                 null calls nothing, which is what it asserts. A test pinned to
                 a colour is a test that goes vacuous the day someone repaints. */
              data-testid="modal-overlay"
              className="fixed inset-0 bg-ink/40 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={closeOnOverlayClick ? onClose : undefined}
            />

            {/* Modal panel */}
            <motion.div
              className={`relative transform overflow-hidden rounded-lg border border-hairline bg-paper text-left shadow-2xl w-full max-h-[calc(100vh-4rem)] flex flex-col ${sizeClasses[size]}`}
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{
                duration: 0.3,
                ease: [0.25, 0.46, 0.45, 0.94]
              }}
            >
              {/* Header - Fixed */}
              <div className="px-4 pt-5 pb-4 sm:p-6 sm:pb-4 border-b border-hairline flex-shrink-0">
                <div className="flex items-center justify-between">
                  <motion.h3
                    className="font-serif text-xl leading-tight text-ink"
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1, duration: 0.2 }}
                  >
                    {title}
                  </motion.h3>
                  <motion.button
                    type="button"
                    className="text-ink-3 hover:text-ink hover:bg-paper-2 transition-colors p-1.5 rounded-md"
                    onClick={onClose}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.95 }}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1, duration: 0.2 }}
                  >
                    <X className="h-5 w-5" />
                  </motion.button>
                </div>
              </div>

              {/* Content - Scrollable */}
              <motion.div
                className="px-4 pb-4 sm:p-6 overflow-y-auto flex-1 modal-scrollbar text-ink"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.3 }}
              >
                {children}
              </motion.div>
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>
  );
}
