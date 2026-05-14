"use client";

import { useState, useMemo } from "react";
import {
  getDomainRequirements,
  generateAlternativeDomains,
  requiresSpecialVerification,
  type DomainRequirement,
  type DomainRestriction,
  type AlternativeDomain,
} from "@/lib/domainRequirements";

export function useDomainRequirements(domainName: string, tld: string) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const domainRequirements = useMemo(() => {
    if (!requiresSpecialVerification(tld)) {
      return {
        requirements: [],
        restrictions: [],
        alternativeDomains: [],
      };
    }

    const { requirements, restrictions } = getDomainRequirements(tld);
    const alternativeDomains = generateAlternativeDomains(domainName, tld);

    return {
      requirements,
      restrictions,
      alternativeDomains,
    };
  }, [domainName, tld]);

  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

  const handleSelectAlternative = (domain: string) => {
    // Handle alternative domain selection
    console.log("Selected alternative domain:", domain);
    closeModal();
  };

  return {
    ...domainRequirements,
    isModalOpen,
    openModal,
    closeModal,
    handleSelectAlternative,
    requiresVerification: requiresSpecialVerification(tld),
  };
}
