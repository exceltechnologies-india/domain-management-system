'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { RecaptchaClient } from '@/lib/recaptcha';
import { logger } from '@/lib/logger';

interface GoogleRecaptchaProps {
  onSuccess?: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
  resetKey?: number;
  className?: string;
  theme?: 'light' | 'dark';
  size?: 'normal' | 'compact';
}

export default function GoogleRecaptcha({
  onSuccess,
  onError,
  onExpire,
  resetKey = 0,
  className = '',
  theme = 'light',
  size = 'normal',
}: GoogleRecaptchaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<number | null>(null);
  const renderedRef = useRef<boolean>(false);
  // React's useId() returns a deterministic id that matches on both
  // sides of hydration. The previous Date.now()+Math.random() approach
  // produced a different id on the server vs. the client, causing
  // React error #418 (hydration mismatch) on every page that renders
  // this widget (login, register, contact, password-reset). The id is
  // sanitised to be a valid HTML id (useId returns colon-bracketed
  // strings like ":r5:" which would otherwise need to be escaped in
  // CSS selectors).
  const reactId = useId();
  const containerId = `recaptcha-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [error, setError] = useState<string | null>(null);

  // Use refs for callbacks to avoid stable dependency issues
  const handlersRef = useRef({ onSuccess, onError, onExpire });
  handlersRef.current = { onSuccess, onError, onExpire };

  useEffect(() => {
    let isMounted = true;

    const renderRecaptcha = async () => {
      // Prevent duplicate rendering
      if (renderedRef.current) return;

      try {
        setError(null); // Clear previous error

        // Phase 2 re-introduction (2026-06-20) drops the admin
        // captcha_enabled DB toggle and the captcha-status polling that
        // went with it — env-var presence is the only kill switch.
        // The siteKey check below is the disabled-state path: empty /
        // placeholder key → silently skip the widget and self-signal
        // success.
        const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
        if (!siteKey || siteKey === 'your-recaptcha-site-key') {
          logger.warn('reCAPTCHA not configured - allowing form submission without verification');
          if (handlersRef.current.onSuccess) {
            handlersRef.current.onSuccess('manual-pass');
          }
          return;
        }

        if (containerRef.current) {
          try {
            logger.log(`[GoogleRecaptcha] Attempting to render in ${containerId}...`);
            const widgetId = await RecaptchaClient.render(containerRef.current, {
              theme,
              size,
              callback: (token: string) => {
                if (handlersRef.current.onSuccess) handlersRef.current.onSuccess(token);
              },
              'expired-callback': () => {
                if (handlersRef.current.onExpire) handlersRef.current.onExpire();
                RecaptchaClient.reset(widgetId || undefined);
              },
              'error-callback': () => {
                setError('reCAPTCHA verification failed. Please try again.');
                if (handlersRef.current.onError) handlersRef.current.onError();
              },
            });

            if (isMounted && widgetId !== null) {
              widgetIdRef.current = widgetId;
              renderedRef.current = true;
              logger.log(`[GoogleRecaptcha] Rendered successfully with ID: ${widgetId}`);
            }
          } catch (renderError) {
            if (isMounted) {
              // Ignore "already rendered" error as it's harmless if we already have a widget
              const errorMsg = renderError instanceof Error ? renderError.message : String(renderError);
              if (errorMsg.includes('already been rendered')) {
                logger.warn('[GoogleRecaptcha] Container already rendered, ignoring error.');
                renderedRef.current = true;
                return;
              }

              // Surface the actual underlying error in the user-visible message
              // so production diagnostics don't need to scrape suppressed logs.
              // Temporary aid during the Phase 2 captcha re-introduction —
              // remove once render is confirmed-stable in real customer sessions.
              setError(`Failed to render verification widget — ${errorMsg.slice(0, 200)}`);
              // eslint-disable-next-line no-console
              console.error('[GoogleRecaptcha] render error:', renderError);
              logger.error('reCAPTCHA render error:', renderError);
              if (handlersRef.current.onError) handlersRef.current.onError();
            }
          }
        }
      } catch (err) {
        if (isMounted) {
          const outerMsg = err instanceof Error ? err.message : String(err);
          setError(`An unexpected error occurred with verification — ${outerMsg.slice(0, 200)}`);
          // eslint-disable-next-line no-console
          console.error('[GoogleRecaptcha] outer error:', err);
          logger.error('reCAPTCHA overall error:', err);
        }
      }
    };

    void renderRecaptcha();

    return () => {
      isMounted = false;
      // Reset the widget on unmount so Google's internal heartbeat timer
      // is torn down. Without this, navigating away leaves an orphaned
      // script that fires "reCAPTCHA Timeout" errors on unrelated pages.
      if (widgetIdRef.current !== null) {
        try {
          RecaptchaClient.reset(widgetIdRef.current);
        } catch {
          // ignore – widget may already be gone
        }
        widgetIdRef.current = null;
        renderedRef.current = false;
      }
    };
  }, [containerId, theme, size]);

  useEffect(() => {
    if (widgetIdRef.current !== null && resetKey > 0) {
      RecaptchaClient.reset(widgetIdRef.current);
    }
  }, [resetKey]);

  return (
    <div className={className}>
      <div ref={containerRef} id={containerId} className="flex justify-center" />
      {error && (
        <p className="mt-2 text-xs text-red-600 text-center">{error}</p>
      )}
    </div>
  );
}
