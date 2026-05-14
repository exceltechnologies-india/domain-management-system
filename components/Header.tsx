'use client';

import { ReactNode } from 'react';

interface HeaderProps {
  children: ReactNode;
  className?: string;
}

export default function Header({ children, className = '' }: HeaderProps) {
  return (
    <header className={`fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md shadow-lg border-b border-gray-200 ${className}`}>
      {children}
    </header>
  );
}
