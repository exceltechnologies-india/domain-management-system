/**
 * Shared types for the HostingUpgradeModal step components.
 */

export interface EligiblePlan {
  planId: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  features: string[];
  quota: number;
  bandwidth: number;
  chargeAmount: number;
  remainingDays: number;
}

export interface UpgradeInfo {
  currentPlan: { planId: string; name: string; price: number };
  eligiblePlans: EligiblePlan[];
  remainingDays: number;
  hasSubscription: boolean;
  expiryDate: string;
}

export type ModalStep =
  | 'loading'
  | 'select'
  | 'confirm'
  | 'paying'
  | 'verifying'
  | 'success'
  | 'error';
