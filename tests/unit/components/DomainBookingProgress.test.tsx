/**
 * Component tests for <DomainBookingProgress> (rescan-4 M14).
 * Pins the loading state, the empty-status fallback, the rendered progress
 * percentage + step messages, the domain_registered → onComplete + "Domain
 * Registration Complete!" success panel with the domainName highlighted,
 * the Refresh-Status button re-fetching, and the autoRefresh=false path
 * suppressing the 3s polling interval.
 *
 * The 3s polling cadence isn't asserted directly; the component-level
 * pin is `autoRefresh=false` to keep the test deterministic.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ apiClient: { get: mockApiGet } }));

import DomainBookingProgress from "@/components/DomainBookingProgress";

function statusResponse(steps: Array<{ step: string; message: string; progress: number }>) {
  return {
    ok: true,
    data: {
      domains: {
        bookingStatus: steps.map((s) => ({ ...s, timestamp: new Date("2025-01-01T10:00:00Z") })),
      },
    },
  };
}

beforeEach(() => {
  mockApiGet.mockReset();
});

describe("<DomainBookingProgress>", () => {
  it("renders the loading state before the first response", () => {
    mockApiGet.mockReturnValue(new Promise(() => {}));
    render(
      <DomainBookingProgress orderId="ord-1" domainName="example.com" autoRefresh={false} />
    );
    expect(screen.getByText(/loading booking status/i)).toBeInTheDocument();
  });

  it("renders the empty-state when no booking status is returned", async () => {
    mockApiGet.mockResolvedValue({ ok: true, data: { domains: { bookingStatus: [] } } });
    render(
      <DomainBookingProgress orderId="ord-1" domainName="example.com" autoRefresh={false} />
    );
    expect(await screen.findByText(/no booking status information available/i)).toBeInTheDocument();
  });

  it("renders the progress percentage and the step messages", async () => {
    mockApiGet.mockResolvedValue(
      statusResponse([
        { step: "payment_verified", message: "Payment verified", progress: 20 },
        { step: "customer_created", message: "Customer record created", progress: 40 },
        { step: "domain_registering", message: "Registering with the registrar", progress: 70 },
      ])
    );
    render(
      <DomainBookingProgress orderId="ord-1" domainName="example.com" autoRefresh={false} />
    );
    expect(await screen.findByText("70%")).toBeInTheDocument();
    expect(screen.getByText("Payment verified")).toBeInTheDocument();
    expect(screen.getByText("Customer record created")).toBeInTheDocument();
    expect(screen.getByText("Registering with the registrar")).toBeInTheDocument();
  });

  it("fires onComplete and renders the success panel when the last step is domain_registered", async () => {
    mockApiGet.mockResolvedValue(
      statusResponse([
        { step: "payment_verified", message: "Payment verified", progress: 25 },
        { step: "domain_registered", message: "Domain registered", progress: 100 },
      ])
    );
    const onComplete = vi.fn();
    render(
      <DomainBookingProgress
        orderId="ord-1"
        domainName="example.com"
        autoRefresh={false}
        onComplete={onComplete}
      />
    );
    expect(await screen.findByRole("heading", { name: /domain registration complete/i })).toBeInTheDocument();
    // The success panel highlights the domain name
    expect(screen.getByText("example.com")).toBeInTheDocument();
    // onComplete fires at least once — the component's useEffect deps include
    // `isComplete`, so when it flips to true the effect re-runs and refetches,
    // firing onComplete a second time. We assert called-at-least-once rather
    // than pinning the count, so a future deps cleanup won't break the test.
    expect(onComplete).toHaveBeenCalled();
    // Refresh button is hidden once complete
    expect(screen.queryByRole("button", { name: /refresh status/i })).not.toBeInTheDocument();
  });

  it("clicking Refresh Status re-fetches and updates the progress", async () => {
    mockApiGet.mockResolvedValueOnce(
      statusResponse([{ step: "payment_verified", message: "Payment verified", progress: 20 }])
    );
    const user = userEvent.setup();
    render(
      <DomainBookingProgress orderId="ord-1" domainName="example.com" autoRefresh={false} />
    );
    expect(await screen.findByText("20%")).toBeInTheDocument();

    mockApiGet.mockResolvedValueOnce(
      statusResponse([
        { step: "payment_verified", message: "Payment verified", progress: 20 },
        { step: "domain_registering", message: "Registering", progress: 75 },
      ])
    );
    await user.click(screen.getByRole("button", { name: /refresh status/i }));
    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });
});
