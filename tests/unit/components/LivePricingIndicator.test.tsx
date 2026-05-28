/**
 * Component tests for <LivePricingIndicator> (rescan-4 M14).
 * Pins the mount-fetch + price extraction from the nested
 * `data[tld].customer.addnewdomain["1"]` shape, the onPriceUpdate callback
 * fired with the parsed price + "INR", the "Live" badge visibility once a
 * price is loaded, the two failure modes ("Live pricing not available"
 * when result.ok but data missing; "Failed to fetch live pricing" when
 * !result.ok), and the Refresh button triggering a re-fetch.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }));

vi.mock("@/lib/api-client", () => ({ apiClient: { get: mockApiGet } }));

import LivePricingIndicator from "@/components/LivePricingIndicator";

function pricingResponse(price: string | undefined, tld = "com") {
  return {
    ok: true,
    data: {
      success: true,
      data: {
        [tld]: price !== undefined ? { customer: { addnewdomain: { "1": price } } } : {},
      },
    },
  };
}

beforeEach(() => {
  mockApiGet.mockReset();
});

describe("<LivePricingIndicator>", () => {
  it("fetches on mount, displays the formatted price, and fires onPriceUpdate", async () => {
    mockApiGet.mockResolvedValue(pricingResponse("999"));
    const onPriceUpdate = vi.fn();
    render(
      <LivePricingIndicator domainName="example.com" tld="com" onPriceUpdate={onPriceUpdate} />
    );

    expect(mockApiGet).toHaveBeenCalledWith("/api/v1/domains/pricing?tlds=com");
    // Intl en-IN INR: "₹999"
    expect(await screen.findByText("₹999")).toBeInTheDocument();
    expect(onPriceUpdate).toHaveBeenCalledWith(999, "INR");
    // "Live" badge appears next to the heading
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("shows 'Live pricing not available' when the response succeeds but the tld key is missing", async () => {
    // No key for the queried tld → the first branch's `data[tld]` truthiness check
    // fails, so the else-if "Live pricing not available" branch fires.
    mockApiGet.mockResolvedValue({ ok: true, data: { success: true, data: {} } });
    render(<LivePricingIndicator domainName="example.com" tld="com" />);
    expect(await screen.findByText(/live pricing not available/i)).toBeInTheDocument();
  });

  it("shows 'Failed to fetch live pricing' when the apiClient call fails", async () => {
    mockApiGet.mockResolvedValue({ ok: false, error: { status: 500, message: "Server error" } });
    render(<LivePricingIndicator domainName="example.com" tld="com" />);
    expect(await screen.findByText(/failed to fetch live pricing/i)).toBeInTheDocument();
  });

  it("does NOT render the 'Live' badge while the indicator is in a failed/empty state", async () => {
    mockApiGet.mockResolvedValue({ ok: false, error: { status: 500, message: "Server error" } });
    render(<LivePricingIndicator domainName="example.com" tld="com" />);
    await screen.findByText(/failed to fetch live pricing/i);
    expect(screen.queryByText(/^Live$/)).not.toBeInTheDocument();
  });

  it("re-fetches on Refresh click", async () => {
    mockApiGet.mockResolvedValue(pricingResponse("799"));
    const user = userEvent.setup();
    render(<LivePricingIndicator domainName="example.com" tld="com" />);
    await screen.findByText("₹799");

    // Switch the mock for the second call
    mockApiGet.mockResolvedValue(pricingResponse("499"));
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    expect(await screen.findByText("₹499")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });
});
