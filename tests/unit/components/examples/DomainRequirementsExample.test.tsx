/**
 * Component tests for <DomainRequirementsExample> (rescan-4 M14).
 * The example component for the DomainRequirements modal pattern.
 * Mocks both `useDomainRequirements` and `<DomainRequirementsModal>`
 * via vi.hoisted so the test stays at the integration boundary: pins
 * the trigger button + the requiresVerification gate + the modal-open
 * wiring.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

type Stub = {
  requirements: unknown[];
  restrictions: unknown[];
  alternativeDomains: unknown[];
  isModalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  handleSelectAlternative: () => void;
  requiresVerification: boolean;
};

const useDomainRequirementsMock = vi.hoisted(() => vi.fn<() => Stub>());
vi.mock("@/hooks/useDomainRequirements", () => ({
  useDomainRequirements: useDomainRequirementsMock,
}));

const modalMock = vi.hoisted(() =>
  vi.fn((props: { isOpen: boolean; domain: string; tld: string }) =>
    props.isOpen ? (
      <div data-testid="mock-modal" data-domain={props.domain} data-tld={props.tld}>
        modal contents
      </div>
    ) : null
  )
);
vi.mock("@/components", () => ({
  DomainRequirementsModal: modalMock,
}));

import DomainRequirementsExample from "@/components/examples/DomainRequirementsExample";

beforeEach(() => {
  useDomainRequirementsMock.mockReset();
  modalMock.mockClear();
});

describe("<DomainRequirementsExample>", () => {
  it("renders the trigger button", () => {
    useDomainRequirementsMock.mockReturnValue({
      requirements: [],
      restrictions: [],
      alternativeDomains: [],
      isModalOpen: false,
      openModal: vi.fn(),
      closeModal: vi.fn(),
      handleSelectAlternative: vi.fn(),
      requiresVerification: false,
    });
    render(<DomainRequirementsExample />);
    expect(
      screen.getByRole("button", { name: /show domain requirements modal/i })
    ).toBeInTheDocument();
  });

  it("requiresVerification=false → does NOT render the modal even when open", () => {
    useDomainRequirementsMock.mockReturnValue({
      requirements: [],
      restrictions: [],
      alternativeDomains: [],
      isModalOpen: true,
      openModal: vi.fn(),
      closeModal: vi.fn(),
      handleSelectAlternative: vi.fn(),
      requiresVerification: false,
    });
    render(<DomainRequirementsExample />);
    expect(screen.queryByTestId("mock-modal")).not.toBeInTheDocument();
    expect(modalMock).not.toHaveBeenCalled();
  });

  it("requiresVerification=true + isModalOpen=true → renders the modal with the .au tld", () => {
    useDomainRequirementsMock.mockReturnValue({
      requirements: [],
      restrictions: [],
      alternativeDomains: [],
      isModalOpen: true,
      openModal: vi.fn(),
      closeModal: vi.fn(),
      handleSelectAlternative: vi.fn(),
      requiresVerification: true,
    });
    render(<DomainRequirementsExample />);
    const modal = screen.getByTestId("mock-modal");
    expect(modal).toHaveAttribute("data-domain", "anutech");
    expect(modal).toHaveAttribute("data-tld", ".au");
  });

  it("clicking the trigger button calls openModal", async () => {
    const user = userEvent.setup();
    const openModal = vi.fn();
    useDomainRequirementsMock.mockReturnValue({
      requirements: [],
      restrictions: [],
      alternativeDomains: [],
      isModalOpen: false,
      openModal,
      closeModal: vi.fn(),
      handleSelectAlternative: vi.fn(),
      requiresVerification: true,
    });
    render(<DomainRequirementsExample />);
    await user.click(screen.getByRole("button", { name: /show domain requirements modal/i }));
    expect(openModal).toHaveBeenCalledTimes(1);
  });
});
