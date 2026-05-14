"use client";

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RefreshButtonProps {
  onClick: () => void;
  isLoading: boolean;
  className?: string;
  title?: string;
  showText?: boolean;
}

const RefreshButton: React.FC<RefreshButtonProps> = ({
  onClick,
  isLoading,
  className,
  title = "Refresh Data",
  showText = true,
}) => {
  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      title={title}
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-all duration-200 border rounded-lg whitespace-nowrap",
        "bg-white border-gray-300 text-gray-700 hover:bg-blue-50 hover:border-blue-500 hover:text-blue-700",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-gray-300 disabled:hover:text-gray-700",
        className
      )}
    >
      <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
      {showText && <span>Refresh</span>}
    </button>
  );
};

export default RefreshButton;
