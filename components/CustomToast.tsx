'use client';

import React from 'react';
import { X } from 'lucide-react';
import toast, { Toast } from 'react-hot-toast';

interface CustomToastProps {
  type: 'success' | 'error' | 'loading';
  title?: string;
  message: string | React.ReactNode;
  duration?: number;
  dismissible?: boolean;
}

export const showCustomToast = ({
  type,
  title,
  message,
  duration = 4000,
  dismissible = true
}: CustomToastProps) => {
  const toastId = toast.custom(
    (t: Toast) => (
      <div
        className={`${t.visible ? 'animate-enter' : 'animate-leave'
          } max-w-md w-full bg-paper shadow-lg rounded-lg pointer-events-auto ring-1 ring-ink ring-opacity-5 overflow-hidden ${type === 'error' ? 'border-l-4 border-rose' :
            type === 'success' ? 'border-l-4 border-emerald' :
              'border-l-4 border-indigo'
          }`}
      >
        {/* Toast Content */}
        <div className="flex">
          <div className="flex-1 w-0 p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                {type === 'success' && (
                  <div className="w-6 h-6 bg-emerald-soft rounded-full flex items-center justify-center">
                    <svg className="w-4 h-4 text-emerald-ink" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
                {type === 'error' && (
                  <div className="w-6 h-6 bg-rose-soft rounded-full flex items-center justify-center">
                    <svg className="w-4 h-4 text-rose-ink" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
                {type === 'loading' && (
                  <div className="w-6 h-6 bg-indigo-soft rounded-full flex items-center justify-center">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-indigo"></div>
                  </div>
                )}
              </div>
              <div className="ml-3 flex-1">
                {title && (
                  <p className={`text-sm font-medium ${type === 'error' ? 'text-rose-ink' :
                      type === 'success' ? 'text-emerald-ink' :
                        'text-indigo-ink'
                    }`}>
                    {title}
                  </p>
                )}
                <div className={`text-sm ${type === 'error' ? 'text-rose-ink' :
                    type === 'success' ? 'text-emerald-ink' :
                      'text-indigo-ink'
                  }`}>
                  {message}
                </div>
              </div>
            </div>
          </div>
          {dismissible && (
            <div className="flex border-l border-hairline">
              <button
                onClick={() => toast.dismiss(t.id)}
                className="w-full border border-transparent rounded-none rounded-r-lg p-4 flex items-center justify-center text-sm font-medium text-ink-3 hover:text-ink-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          )}
        </div>

        {/* Progress Bar - Only show for non-infinite duration */}
        {duration !== Infinity && t.visible && (
          <div className="h-1 w-full bg-paper-2">
            <div
              className={`h-full transition-all ease-linear ${type === 'error' ? 'bg-rose' :
                  type === 'success' ? 'bg-emerald' :
                    'bg-primary-600'
                }`}
              style={{
                width: '100%',
                animation: `shrink ${duration}ms linear forwards`
              }}
            />
          </div>
        )}
      </div>
    ),
    {
      duration: duration,
      position: 'top-right',
    }
  );

  return toastId;
};

// Convenience functions
export const showSuccessToast = (message: string | React.ReactNode, title?: string, duration?: number) => {
  return showCustomToast({ type: 'success', message, title, duration });
};

export const showErrorToast = (message: string | React.ReactNode, title?: string, duration?: number) => {
  return showCustomToast({ type: 'error', message, title, duration });
};

export const showLoadingToast = (message: string | React.ReactNode, title?: string) => {
  return showCustomToast({ type: 'loading', message, title, duration: Infinity });
};

// For permanent toasts (like deactivated account)
export const showPermanentToast = (message: string | React.ReactNode, title?: string, type: 'success' | 'error' = 'error') => {
  return showCustomToast({ type, message, title, duration: Infinity, dismissible: true });
};
