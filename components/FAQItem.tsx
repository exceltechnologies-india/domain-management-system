'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface FAQItemProps {
  question: string;
  answer: string;
  isOpen?: boolean;
  onToggle?: () => void;
  className?: string;
}

export default function FAQItem({
  question,
  answer,
  isOpen = false,
  onToggle,
  className = ''
}: FAQItemProps) {
  const [open, setOpen] = useState(isOpen);

  const handleToggle = () => {
    if (onToggle) {
      onToggle();
    } else {
      setOpen(!open);
    }
  };

  const isCurrentlyOpen = onToggle ? isOpen : open;

  return (
    <div className={`bg-white border border-gray-200 rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 ${className}`}>
      <button
        onClick={handleToggle}
        className="w-full px-6 py-4 text-left flex justify-between items-center focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-opacity-50 rounded-lg"
      >
        <span className="text-lg font-semibold text-gray-900 pr-4">
          {question}
        </span>
        <ChevronDown
          className={`h-5 w-5 text-gray-500 transition-transform duration-200 flex-shrink-0 ${isCurrentlyOpen ? 'transform rotate-180' : ''
            }`}
        />
      </button>

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${isCurrentlyOpen
            ? 'max-h-96 opacity-100'
            : 'max-h-0 opacity-0'
          }`}
      >
        <div className="px-6 pb-4">
          <div className="border-t border-gray-100 pt-4">
            <p className="text-gray-600 leading-relaxed">
              {answer}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
