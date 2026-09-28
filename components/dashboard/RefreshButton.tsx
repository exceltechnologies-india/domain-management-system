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
        "bg-paper border-hairline text-ink-2 hover:bg-indigo/15 hover:border-indigo hover:text-indigo-ink",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-paper disabled:hover:border-hairline disabled:hover:text-ink-2",
        className
      )}
    >
      <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
      {showText && <span>Refresh</span>}
    </button>
  );
};

export default RefreshButton;
