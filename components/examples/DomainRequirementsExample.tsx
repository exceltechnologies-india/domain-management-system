'use client';

import React from 'react';
import { DomainRequirementsModal } from '@/components';
import { useDomainRequirements } from '@/hooks/useDomainRequirements';

export default function DomainRequirementsExample() {
  const {
    requirements,
    restrictions,
    alternativeDomains,
    isModalOpen,
    openModal,
    closeModal,
    handleSelectAlternative,
    requiresVerification
  } = useDomainRequirements('anutech', '.au');

  return (
    <div className="p-8">
      <button
        onClick={openModal}
        className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 transition-colors"
      >
        Show Domain Requirements Modal
      </button>

      {requiresVerification && (
        <DomainRequirementsModal
          isOpen={isModalOpen}
          onClose={closeModal}
          domain="anutech"
          tld=".au"
          requirements={requirements}
          restrictions={restrictions}
          alternativeDomains={alternativeDomains}
          onSelectAlternative={handleSelectAlternative}
        />
      )}
    </div>
  );
}
