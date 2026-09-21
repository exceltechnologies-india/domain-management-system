import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LucideIcon } from 'lucide-react';

interface ActionItem {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  variant?: 'danger' | 'default' | 'warning' | 'success' | 'info';
}

interface ActionMenuProps {
  isOpen: boolean;
  onClose: () => void;
  anchorPoint: { x: number; y: number };
  items: ActionItem[];
}

const ActionMenu: React.FC<ActionMenuProps> = ({
  isOpen,
  onClose,
  anchorPoint,
  items,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPoint, setAdjustedPoint] = useState(anchorPoint);

  useEffect(() => {
    if (isOpen && menuRef.current) {
      /* offsetWidth/Height, NOT getBoundingClientRect().
         This effect runs while framer-motion is still animating the menu in
         from `scale: 0.95`, and getBoundingClientRect() reports the TRANSFORMED
         box — 209px for a 220px menu. The guard then concluded it fitted and
         left it hanging 1px off the right edge at a 1440px viewport, measured.
         offsetWidth is the layout width and ignores the transform, so the
         comparison is against the size the menu will actually settle at. */
      const menuWidth = menuRef.current.offsetWidth;
      const menuHeight = menuRef.current.offsetHeight;
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;

      let { x, y } = anchorPoint;

      // Adjust X if off screen
      if (x + menuWidth > screenWidth) {
        x = screenWidth - menuWidth - 10;
      }

      // Adjust Y if off screen
      if (y + menuHeight > screenHeight) {
        y = screenHeight - menuHeight - 10;
      }

      setAdjustedPoint({ x, y });
    }
  }, [isOpen, anchorPoint]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  /**
   * ResellerOS tokens, not raw Tailwind. The `-ink` shade carries the text and
   * `-soft` the hover fill — the same pairing AdminLayout's active nav row uses
   * (`bg-amber-soft text-amber-ink`), so a menu opened over the sidebar agrees
   * with it.
   *
   * `-ink` rather than the DEFAULT shade on purpose. ResellerOS's own
   * DropdownMenuItem uses `text-rose` for destructive, but `--rose` sits at 50%
   * lightness against `--paper` at 97%, which lands under 4.5:1 for a 14px
   * label. The `-ink` shades are the same hue 13-15 points darker and clear it.
   * A menu whose rows include "Delete Permanently" is the wrong place to spend
   * legibility on exact parity with one component.
   */
  const getVariantStyles = (variant?: string) => {
    switch (variant) {
      case 'danger': return 'text-rose-ink hover:bg-rose-soft';
      case 'warning': return 'text-amber-ink hover:bg-amber-soft';
      case 'success': return 'text-emerald-ink hover:bg-emerald-soft';
      case 'info': return 'text-indigo-ink hover:bg-indigo-soft';
      default: return 'text-ink-2 hover:bg-paper-2 hover:text-ink';
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          /* Flat panel on the opaque `paper` surface with a hairline border —
             the shape ResellerOS's DropdownMenuContent uses. The frosted
             `bg-white/70 backdrop-blur-xl` it replaced put the table rows
             underneath showing through the menu, which on a dense admin grid
             makes a "Delete Permanently" row sit on top of somebody else's
             data. An action menu is a decision surface; it should be opaque. */
          className="fixed z-[9999] min-w-[220px] bg-paper border border-hairline shadow-md rounded-md overflow-hidden p-1"
          style={{
            top: adjustedPoint.y,
            left: adjustedPoint.x,
          }}
        >
          {items.map((item, index) => (
            <React.Fragment key={index}>
              {index > 0 && item.variant === 'danger' && <div className="h-px bg-hairline my-1 mx-2" />}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  item.onClick();
                  onClose();
                }}
                /* py-2 on mobile, py-1.5 from sm. ResellerOS's density is the
                   1.5; this menu is also reachable on a phone, where the flat
                   1.5 gives a ~32px row. Same responsive pair, and same
                   reason, as AdminLayout's nav rows. */
                className={`w-full rounded-sm px-2 py-2 sm:py-1.5 text-sm flex items-center gap-2 text-left transition-colors ${getVariantStyles(item.variant)}`}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                <span>{item.label}</span>
              </button>
            </React.Fragment>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ActionMenu;
