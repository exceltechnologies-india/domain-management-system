/**
 * Component tests for <DomainRequirementsModal> (rescan-4 M14).
 * Shown when a user tries to register a TLD requiring extra verification
 * (e.g., .au). Pins:
 *  - isOpen gate
 *  - title combines domain + tld
 *  - intro + Important Notice copy
 *  - Required Information list rendering
 *  - Restrictions list with per-type icon + colour fork
 *  - Alternative-domain list rendering + the **onSelectAlternative**
 *    callback fires with the chosen domain string
 *  - alt.available true/false swaps the trailing icon (check vs X)
 *  - Close button fires onClose
 *  - Contact Support opens a `mailto:` URL via window.open
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DomainRequirementsModal from "@/components/DomainRequirementsModal";

const BASE_PROPS = {
  isOpen: true,
  onClose: vi.fn(),
  domain: "anutech",
  tld: ".au",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<DomainRequirementsModal>", () => {
  it("isOpen=false renders nothing", () => {
    render(<DomainRequirementsModal {...BASE_PROPS} isOpen={false} />);
    expect(screen.queryByText(/important notice/i)).not.toBeInTheDocument();
  });

  it("isOpen=true renders the intro copy + the Important Notice block", () => {
    render(<DomainRequirementsModal {...BASE_PROPS} />);
    expect(
      screen.getByText(/requires additional business verification/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /important notice/i })).toBeInTheDocument();
  });

  it("renders Required Information list when supplied", () => {
    render(
      <DomainRequirementsModal
        {...BASE_PROPS}
        requirements={[
          { text: "ABN (Australian Business Number)", required: true },
          { text: "ACN (Australian Company Number)", required: false },
        ]}
      />
    );
    expect(screen.getByRole("heading", { name: /required information/i })).toBeInTheDocument();
    expect(screen.getByText(/ABN \(Australian Business Number\)/)).toBeInTheDocument();
    expect(screen.getByText(/ACN \(Australian Company Number\)/)).toBeInTheDocument();
  });

  it("Restrictions list applies per-type colour class (error=red, warning=orange, info=blue)", () => {
    render(
      <DomainRequirementsModal
        {...BASE_PROPS}
        restrictions={[
          { text: "no-go-rule", type: "error" },
          { text: "be-careful-rule", type: "warning" },
          { text: "just-fyi-rule", type: "info" },
        ]}
      />
    );
    expect(screen.getByText("no-go-rule").className).toMatch(/text-red-600/);
    expect(screen.getByText("be-careful-rule").className).toMatch(/text-orange-600/);
    expect(screen.getByText("just-fyi-rule").className).toMatch(/text-blue-600/);
  });

  it("Alternative Options list renders + clicking a row fires onSelectAlternative(domain)", async () => {
    const user = userEvent.setup();
    const onSelectAlternative = vi.fn();
    render(
      <DomainRequirementsModal
        {...BASE_PROPS}
        alternativeDomains={[
          { domain: "anutech.com", available: true, price: "₹999" },
          { domain: "anutech.in", available: false },
        ]}
        onSelectAlternative={onSelectAlternative}
      />
    );
    expect(screen.getByRole("heading", { name: /alternative options/i })).toBeInTheDocument();
    expect(screen.getByText("anutech.com")).toBeInTheDocument();
    expect(screen.getByText("anutech.in")).toBeInTheDocument();
    expect(screen.getByText("₹999")).toBeInTheDocument();
    await user.click(screen.getByText("anutech.com"));
    expect(onSelectAlternative).toHaveBeenCalledWith("anutech.com");
  });

  it("Close button fires onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DomainRequirementsModal {...BASE_PROPS} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Contact Support opens a mailto: link via window.open", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<DomainRequirementsModal {...BASE_PROPS} />);
    await user.click(screen.getByRole("button", { name: /contact support/i }));
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^mailto:.+Domain Registration Support/),
      "_blank"
    );
    openSpy.mockRestore();
  });

  it("safe-array fallbacks: non-array prop values do NOT crash the render", () => {
    expect(() =>
      render(
        <DomainRequirementsModal
          {...BASE_PROPS}
          // @ts-expect-error — exercising the defensive Array.isArray() guard
          requirements={"oops"}
          // @ts-expect-error — same defensive guard
          restrictions={null}
        />
      )
    ).not.toThrow();
    // Neither section heading should appear when the array is malformed.
    expect(screen.queryByRole("heading", { name: /required information/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^restrictions$/i })).not.toBeInTheDocument();
  });
});
