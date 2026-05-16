'use client';

import { useEffect, useRef, useState } from 'react';
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
  const [containerId] = useState(() => `recaptcha-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
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

        // Check if captcha has been administratively disabled
        try {
          const res = await fetch('/api/v1/settings/captcha-status');
          if (res.ok) {
            const data = await res.json();
            if (!data.enabled) {
              if (handlersRef.current.onSuccess) {
                handlersRef.current.onSuccess('captcha-disabled');
              }
              return;
            }
          } else {
            // Non-ok response (e.g. 401, 500) — treat as "enabled" to preserve security
            logger.warn('[GoogleRecaptcha] captcha-status returned', res.status, '— showing captcha');
          }
        } catch {
          // Network error — treat as enabled to preserve security
        }

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

              setError('Failed to render verification widget');
              logger.error('reCAPTCHA render error:', renderError);
              if (handlersRef.current.onError) handlersRef.current.onError();
            }
          }
        }
      } catch (err) {
        if (isMounted) {
          setError('An unexpected error occurred with verification');
          logger.error('reCAPTCHA overall error:', err);
        }
      }
    };

    renderRecaptcha();

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
