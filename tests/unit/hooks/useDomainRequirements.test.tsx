/**
 * Hook tests for `useDomainRequirements` (rescan-4 M14 — hooks).
 * Mocks `@/lib/domainRequirements` helpers so the hook tests stay
 * focused on the surfaced state machine, not the underlying TLD data.
 * Pins:
 *  - requiresSpecialVerification=false → empty arrays + requiresVerification=false
 *  - requiresSpecialVerification=true → arrays populated from getDomainRequirements
 *    + generateAlternativeDomains, requiresVerification=true
 *  - openModal/closeModal toggle isModalOpen
 *  - handleSelectAlternative closes the modal
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const requiresSpecialMock = vi.hoisted(() => vi.fn());
const getRequirementsMock = vi.hoisted(() => vi.fn());
const generateAlternativesMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/domainRequirements", () => ({
  requiresSpecialVerification: requiresSpecialMock,
  getDomainRequirements: getRequirementsMock,
  generateAlternativeDomains: generateAlternativesMock,
}));

import { useDomainRequirements } from "@/hooks/useDomainRequirements";

beforeEach(() => {
  requiresSpecialMock.mockReset();
  getRequirementsMock.mockReset();
  generateAlternativesMock.mockReset();
});

describe("useDomainRequirements", () => {
  it("non-restricted TLD → empty arrays + requiresVerification=false", () => {
    requiresSpecialMock.mockReturnValue(false);
    const { result } = renderHook(() => useDomainRequirements("anutech", ".com"));
    expect(result.current.requirements).toEqual([]);
    expect(result.current.restrictions).toEqual([]);
    expect(result.current.alternativeDomains).toEqual([]);
    expect(result.current.requiresVerification).toBe(false);
    // Underlying data fns NOT called for non-restricted TLDs.
    expect(getRequirementsMock).not.toHaveBeenCalled();
    expect(generateAlternativesMock).not.toHaveBeenCalled();
  });

  it("restricted TLD → arrays populated from the data fns + requiresVerification=true", () => {
    requiresSpecialMock.mockReturnValue(true);
    getRequirementsMock.mockReturnValue({
      requirements: [{ text: "ABN required", required: true }],
      restrictions: [{ text: "business only", type: "warning" }],
    });
    generateAlternativesMock.mockReturnValue([
      { domain: "anutech.com", available: true, price: "₹999" },
    ]);
    const { result } = renderHook(() => useDomainRequirements("anutech", ".au"));
    expect(result.current.requiresVerification).toBe(true);
    expect(result.current.requirements).toHaveLength(1);
    expect(result.current.restrictions).toHaveLength(1);
    expect(result.current.alternativeDomains).toHaveLength(1);
    expect(getRequirementsMock).toHaveBeenCalledWith(".au");
    expect(generateAlternativesMock).toHaveBeenCalledWith("anutech", ".au");
  });

  it("openModal sets isModalOpen=true; closeModal sets it back to false", () => {
    requiresSpecialMock.mockReturnValue(false);
    const { result } = renderHook(() => useDomainRequirements("x", ".com"));
    expect(result.current.isModalOpen).toBe(false);
    act(() => {
      result.current.openModal();
    });
    expect(result.current.isModalOpen).toBe(true);
    act(() => {
      result.current.closeModal();
    });
    expect(result.current.isModalOpen).toBe(false);
  });

  it("handleSelectAlternative closes the modal", () => {
    requiresSpecialMock.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { result } = renderHook(() => useDomainRequirements("x", ".com"));
    act(() => result.current.openModal());
    expect(result.current.isModalOpen).toBe(true);
    act(() => result.current.handleSelectAlternative("anutech.com"));
    expect(result.current.isModalOpen).toBe(false);
    consoleSpy.mockRestore();
  });
});
