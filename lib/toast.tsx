// Toast utility functions for consistent dismissible notifications
import React from 'react';
import { showSuccessToast, showErrorToast, showLoadingToast, showPermanentToast } from '@/components/CustomToast';

// Re-export the custom toast functions for easy importing
export {
  showSuccessToast,
  showErrorToast,
  showLoadingToast,
  showPermanentToast
};

// Convenience functions with common patterns
export const showApiError = (error: any, defaultMessage: string = 'An error occurred') => {
  const message = error?.message || error?.error || defaultMessage;
  showErrorToast(message);
};

export const showApiSuccess = (message: string) => {
  showSuccessToast(message);
};

export const showFormError = (message: string) => {
  showErrorToast(message, 'Form Error');
};

export const showFormSuccess = (message: string) => {
  showSuccessToast(message, 'Success');
};

export const showNetworkError = () => {
  showErrorToast('Network error. Please check your connection and try again.', 'Connection Error');
};

export const showValidationError = (message: string) => {
  showErrorToast(message, 'Validation Error');
};

export const showPermissionError = () => {
  showErrorToast('You do not have permission to perform this action.', 'Permission Denied');
};

export const showAccountDeactivated = (supportEmail: string) => {
  showPermanentToast(
    <div className="text-left">
      <div className="text-sm">
        Your account has been deactivated. Please contact our support team at{' '}
        <a 
          href={`mailto:${supportEmail}`}
          className="underline hover:text-red-900 font-medium"
        >
          {supportEmail}
        </a>{' '}
        for assistance.
      </div>
    </div>,
    "Account Deactivated",
    "error"
  );
};
