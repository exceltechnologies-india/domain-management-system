import React from 'react';

interface RupeeIconProps {
  className?: string;
}

export default function RupeeIcon({ className = "h-6 w-6" }: RupeeIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Rupee symbol design */}
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="12"
        fontWeight="bold"
        fill="currentColor"
        fontFamily="Arial, sans-serif"
      >
        ₹
      </text>
    </svg>
  );
}
