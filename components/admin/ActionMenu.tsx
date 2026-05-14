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
      const menuRect = menuRef.current.getBoundingClientRect();
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;

      let { x, y } = anchorPoint;

      // Adjust X if off screen
      if (x + menuRect.width > screenWidth) {
        x = screenWidth - menuRect.width - 10;
      }

      // Adjust Y if off screen
      if (y + menuRect.height > screenHeight) {
        y = screenHeight - menuRect.height - 10;
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

  const getVariantStyles = (variant?: string) => {
    switch (variant) {
      case 'danger': return 'text-red-600 hover:bg-red-50';
      case 'warning': return 'text-yellow-600 hover:bg-yellow-50 hover:text-yellow-700';
      case 'success': return 'text-green-600 hover:bg-green-50 hover:text-green-700';
      case 'info': return 'text-blue-600 hover:bg-blue-50 hover:text-blue-700';
      default: return 'text-gray-700 hover:bg-gray-50 hover:text-gray-900';
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
          className="fixed z-[9999] min-w-[220px] bg-white/70 backdrop-blur-xl border border-white/40 shadow-[0_20px_50px_rgba(0,0,0,0.15)] rounded-2xl overflow-hidden py-2"
          style={{
            top: adjustedPoint.y,
            left: adjustedPoint.x,
          }}
        >
          {items.map((item, index) => (
            <React.Fragment key={index}>
              {index > 0 && item.variant === 'danger' && <div className="h-px bg-gray-100/50 my-1 mx-3" />}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  item.onClick();
                  onClose();
                }}
                className={`w-full px-4 py-2.5 text-sm flex items-center gap-3 transition-all duration-200 group ${getVariantStyles(item.variant)}`}
              >
                <div className="flex-shrink-0 p-1.5 rounded-lg group-hover:scale-110 transition-transform duration-200">
                  <item.icon className="w-4 h-4" />
                </div>
                <span className="font-semibold tracking-tight">{item.label}</span>
              </button>
            </React.Fragment>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ActionMenu;
