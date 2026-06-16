import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Toaster } from 'react-hot-toast';
import ClientOnly from '@/components/ClientOnly';
import SessionProvider from '@/components/SessionProvider';
import MotionProvider from '@/components/MotionProvider';
import FloatingCart from '@/components/FloatingCart';
import ScrollToTop from '@/components/ScrollToTop';
import CookieConsentBanner from '@/components/CookieConsentBanner';
import { ConfirmDialogHost } from '@/lib/confirm-dialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { headers } from 'next/headers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Anutech Digital Private Limited - Domain Management System',
  description: 'Anutech Digital Private Limited - Professional domain management and digital solutions',
  icons: {
    icon: '/favicon.ico',
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reading x-nonce forces dynamic rendering and causes Next.js to apply the
  // nonce to all its generated inline RSC scripts, satisfying the nonce-based CSP.
  await headers();

  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <MotionProvider>
          <SessionProvider>
            {children}
            <ErrorBoundary label="FloatingCart" fallback={null}>
              <FloatingCart />
            </ErrorBoundary>
            <ScrollToTop />
            <CookieConsentBanner />
            <ConfirmDialogHost />
          </SessionProvider>
        </MotionProvider>
        <Toaster
          position="bottom-right"
          containerStyle={{
            bottom: '100px',
            right: '24px',
          }}
          containerClassName="toast-container"
          toastOptions={{
            duration: 4000,
            className: 'toast-notification',
            style: {
              background: '#fff',
              color: '#363636',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
            },
            success: {
              duration: 3000,
              iconTheme: {
                primary: '#10B981',
                secondary: '#fff',
              },
            },
            error: {
              duration: 4000,
              iconTheme: {
                primary: '#EF4444',
                secondary: '#fff',
              },
            },
          }}
        />
      </body>
    </html>
  );
}
