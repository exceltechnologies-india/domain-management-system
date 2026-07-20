import type { Metadata } from 'next';
import localFont from 'next/font/local';
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
import TrackingScripts from '@/components/TrackingScripts';
import AttributionCapture from '@/components/AttributionCapture';
import { headers } from 'next/headers';

// Self-hosted Inter variable font — previously `Inter({ subsets: ['latin'] })`
// from `next/font/google`. Switched to local because Google Fonts is
// intermittently unreachable from the Docker build network (ETIMEDOUT on
// fonts.googleapis.com / fonts.gstatic.com during the 2026-06-20 deploy
// chain), and a build-time external dep is the wrong shape for a deploy
// pipeline anyway. Files in public/fonts/ are the official Inter project
// release from rsms.me/inter — same glyph set, no behaviour change for
// customers.
const inter = localFont({
  src: [
    { path: '../public/fonts/InterVariable.woff2', weight: '100 900', style: 'normal' },
    { path: '../public/fonts/InterVariable-Italic.woff2', weight: '100 900', style: 'italic' },
  ],
  display: 'swap',
  variable: '--font-inter',
});

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
        {/* Admin-managed analytics / marketing tags (GA4 / GTM / Meta Pixel /
            Google Ads). Renders first-party nonce'd snippets keyed on
            validated IDs; no-ops when disabled. See components/TrackingScripts. */}
        <ErrorBoundary label="TrackingScripts" fallback={null}>
          <TrackingScripts />
        </ErrorBoundary>
        {/* First-touch attribution capture + client-side journey events. */}
        <ErrorBoundary label="AttributionCapture" fallback={null}>
          <AttributionCapture />
        </ErrorBoundary>
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
