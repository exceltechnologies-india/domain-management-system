'use client';

import { useState, useEffect } from 'react';
/**
 * "Request upgrade" — owner decision, 25 Sep 2026 ("Request, billed by
 * ResellerOS"). DMS takes no payment for an upgrade any more: this sends a
 * request (POST /api/user/hosting/upgrade → ResellerOS), shows the prorated
 * figure as an ESTIMATE, and tells the customer a quote will follow and the
 * plan changes once it is paid. No Razorpay, no verify, no local order.
 */
import { X, ArrowUp, AlertTriangle, RefreshCw, CheckCircle } from 'lucide-react';
import SelectPlanStep from './hosting-upgrade/SelectPlanStep';
import ConfirmStep from './hosting-upgrade/ConfirmStep';
import type {
  EligiblePlan,
  UpgradeInfo,
  ModalStep,
} from './hosting-upgrade/types';

interface HostingUpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  domainName: string;
}

export default function HostingUpgradeModal({
  isOpen,
  onClose,
  domainName,
}: HostingUpgradeModalProps) {
  const [step, setStep] = useState<ModalStep>('loading');
  const [upgradeInfo, setUpgradeInfo] = useState<UpgradeInfo | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<EligiblePlan | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [alreadyRequested, setAlreadyRequested] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep('loading');
      setSelectedPlan(null);
      setErrorMessage('');
      void loadUpgradeInfo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, domainName]);

  const loadUpgradeInfo = async () => {
    try {
      const response = await fetch(
        `/api/v1/user/hosting/upgrade-info?domainName=${encodeURIComponent(domainName)}`,
        { credentials: 'include' }
      );
      const json = await response.json();
      if (!response.ok) {
        setErrorMessage(json.error || 'Failed to load upgrade options');
        setStep('error');
        return;
      }
      const info: UpgradeInfo = json.data;
      setUpgradeInfo(info);
      if (info.eligiblePlans.length === 0) {
        setErrorMessage('You are already on the highest available plan.');
        setStep('error');
      } else {
        setStep('select');
      }
    } catch {
      setErrorMessage('Failed to load upgrade options. Please try again.');
      setStep('error');
    }
  };

  const handleSelectPlan = (plan: EligiblePlan) => {
    setSelectedPlan(plan);
    setStep('confirm');
  };

  const handleRequest = async () => {
    if (!selectedPlan || !upgradeInfo) return;
    setStep('sending');
    try {
      const res = await fetch('/api/v1/user/hosting/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ domainName, targetPlanId: selectedPlan.planId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The route writes every refusal for the customer (what, why, next).
        setErrorMessage(
          typeof json.error === 'string'
            ? json.error
            : "We couldn't send your upgrade request. Nothing was charged and your plan is unchanged. Please try again, or contact support."
        );
        setStep('error');
        return;
      }
      setAlreadyRequested(json.data?.alreadyRequested === true);
      setStep('requested');
    } catch {
      // Never reached DMS, so nothing was sent onward.
      setErrorMessage("We couldn't reach our server, so the request wasn't sent. Nothing was charged. Check your connection and try again.");
      setStep('error');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
        <div className="bg-paper rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in duration-200">
          {/* Header */}
          <div className="p-6 border-b border-hairline flex items-center justify-between bg-paper-2/50">
            <div>
              <h2 className="text-xl font-bold text-ink flex items-center">
                <ArrowUp className="h-5 w-5 mr-2 text-indigo-ink" />
                Request a plan upgrade
              </h2>
              <p className="text-sm text-ink-3 mt-1">{domainName}</p>
            </div>
            {step !== 'sending' && (
              <button
                onClick={onClose}
                className="p-2 text-ink-4 hover:text-ink-2 hover:bg-paper-2 rounded-full transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>

          {/* Content */}
          <div className="p-6">
            {step === 'loading' && (
              <div className="flex flex-col items-center justify-center py-12">
                <RefreshCw className="h-10 w-10 animate-spin text-indigo-ink mb-4" />
                <p className="text-ink-2 font-medium">Loading upgrade options...</p>
              </div>
            )}

            {step === 'requested' && selectedPlan && (
              <div className="text-center py-8">
                <CheckCircle className="h-12 w-12 text-emerald-600 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-ink mb-2">
                  {alreadyRequested ? 'You have already asked for this upgrade' : 'Upgrade requested'}
                </h3>
                <p className="text-sm text-ink-2 max-w-sm mx-auto">
                  Our team will email you a quote for the move to {selectedPlan.name}. Your plan changes once that
                  quote is paid — until then nothing changes and nothing is charged.
                </p>
                <button onClick={onClose} className="mt-6 px-5 py-2 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 text-sm">
                  Close
                </button>
              </div>
            )}

            {step === 'select' && upgradeInfo && (
              <SelectPlanStep
                upgradeInfo={upgradeInfo}
                onSelectPlan={handleSelectPlan}
                onCancel={onClose}
              />
            )}

            {step === 'confirm' && selectedPlan && upgradeInfo && (
              <ConfirmStep
                upgradeInfo={upgradeInfo}
                selectedPlan={selectedPlan}
                onBack={() => setStep('select')}
                onRequest={handleRequest}
              />
            )}

            {step === 'sending' && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <RefreshCw className="h-10 w-10 animate-spin text-indigo-ink mb-4" />
                <h3 className="text-lg font-bold text-ink">Sending your request…</h3>
              </div>
            )}

            {step === 'error' && (
              <div className="text-center py-8">
                <div className="bg-rose-soft rounded-full h-14 w-14 flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="h-7 w-7 text-rose-ink" />
                </div>
                <h3 className="text-lg font-bold text-ink mb-2">Something went wrong</h3>
                <p className="text-ink-3 text-sm mb-6">{errorMessage}</p>
                <div className="flex gap-3 justify-center">
                  <button onClick={onClose} className="px-4 py-2 text-ink-2 font-semibold bg-paper-2 hover:bg-hairline rounded-xl transition-all text-sm">
                    Close
                  </button>
                  <button
                    onClick={() => {
                      setStep('loading');
                      setErrorMessage('');
                      void loadUpgradeInfo();
                    }}
                    className="px-4 py-2 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-all text-sm"
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
