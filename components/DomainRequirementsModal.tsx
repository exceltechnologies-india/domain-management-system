'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertTriangle, CheckCircle, ExternalLink } from 'lucide-react';
import Modal from './Modal';

interface DomainRequirement {
  text: string;
  required: boolean;
}

interface DomainRestriction {
  text: string;
  type: 'warning' | 'error' | 'info';
}

interface AlternativeDomain {
  domain: string;
  available: boolean;
  price?: string;
}

interface DomainRequirementsModalProps {
  isOpen: boolean;
  onClose: () => void;
  domain: string;
  tld: string;
  requirements?: DomainRequirement[];
  restrictions?: DomainRestriction[];
  alternativeDomains?: AlternativeDomain[];
  onSelectAlternative?: (domain: string) => void;
}

export default function DomainRequirementsModal({
  isOpen,
  onClose,
  domain,
  tld,
  requirements = [],
  restrictions = [],
  alternativeDomains = [],
  onSelectAlternative
}: DomainRequirementsModalProps) {
  // Ensure arrays are properly defined
  const safeRequirements = Array.isArray(requirements) ? requirements : [];
  const safeRestrictions = Array.isArray(restrictions) ? restrictions : [];
  const safeAlternativeDomains = Array.isArray(alternativeDomains) ? alternativeDomains : [];

  const getRestrictionIcon = (type: string) => {
    switch (type) {
      case 'error':
        return <X className="h-4 w-4 text-red-500" />;
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-orange-500" />;
      default:
        return <AlertTriangle className="h-4 w-4 text-blue-500" />;
    }
  };

  const getRestrictionColor = (type: string) => {
    switch (type) {
      case 'error':
        return 'text-red-600';
      case 'warning':
        return 'text-orange-600';
      default:
        return 'text-blue-600';
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`${domain}${tld}`}
      size="lg"
    >
      <div className="space-y-6">
        {/* Domain Badge */}
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold text-gray-900">{domain}{tld}</span>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
            {tld}
          </span>
        </div>

        {/* Introduction */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-blue-800 text-sm">
            This domain requires additional business verification and cannot be registered through our standard process.
          </p>
        </div>

        {/* Important Notice */}
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-orange-500 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-medium text-orange-900 mb-1">Important Notice</h4>
              <p className="text-orange-800 text-sm">
                {tld} domains require business registration and additional verification. Please contact support for assistance.
              </p>
            </div>
          </div>
        </div>

        {/* Required Information */}
        {safeRequirements.length > 0 && (
          <div>
            <h4 className="font-medium text-gray-900 mb-3">Required Information</h4>
            <div className="space-y-2">
              {safeRequirements.map((req, index) => (
                <motion.div
                  key={index}
                  className="flex items-start gap-3"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.1 }}
                >
                  <X className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-gray-700">{req.text}</span>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Restrictions */}
        {safeRestrictions.length > 0 && (
          <div>
            <h4 className="font-medium text-gray-900 mb-3">Restrictions</h4>
            <div className="space-y-2">
              {safeRestrictions.map((restriction, index) => (
                <motion.div
                  key={index}
                  className="flex items-start gap-3"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: (safeRequirements.length + index) * 0.1 }}
                >
                  {getRestrictionIcon(restriction.type)}
                  <span className={`text-sm ${getRestrictionColor(restriction.type)}`}>
                    {restriction.text}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Alternative Options */}
        {safeAlternativeDomains.length > 0 && (
          <div>
            <h4 className="font-medium text-gray-900 mb-3">Alternative Options</h4>
            <p className="text-sm text-gray-600 mb-4">
              Consider these similar domains that don't require additional verification:
            </p>
            <div className="grid gap-3">
              {safeAlternativeDomains.map((alt, index) => (
                <motion.div
                  key={index}
                  className="flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:border-primary-300 hover:bg-primary-50 transition-colors cursor-pointer"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: (safeRequirements.length + safeRestrictions.length + index) * 0.1 }}
                  onClick={() => onSelectAlternative?.(alt.domain)}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-900">{alt.domain}</span>
                    {alt.available ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : (
                      <X className="h-4 w-4 text-red-500" />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {alt.price && (
                      <span className="text-sm font-medium text-primary-600">{alt.price}</span>
                    )}
                    <ExternalLink className="h-4 w-4 text-gray-400" />
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4 border-t border-gray-200">
          <motion.button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            Close
          </motion.button>
          <motion.button
            onClick={() => {
              // Handle contact support
              const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@anutech.in';
              window.open(`mailto:${supportEmail}?subject=Domain Registration Support`, '_blank');
            }}
            className="flex-1 px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 transition-colors"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            Contact Support
          </motion.button>
        </div>
      </div>
    </Modal>
  );
}