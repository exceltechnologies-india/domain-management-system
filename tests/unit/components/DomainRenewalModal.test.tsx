/**
 * Component tests for <DomainRenewalModal> (rescan-4 M14).
 * Mocks global.fetch + react-hot-toast. Pins:
 *  - isOpen gate (no fetch when closed)
 *  - Loading skeleton during initial fetch
 *  - Successful fetch renders current status + pricing
 *  - HTTP error → toast.error with server message
 *  - <30 days expiring → red 'expiring soon' warning block
 *  - 6 renewal-period buttons (1/2/3/4/5/10 years)
 *  - Selecting a year refetches with the new ?years=N
 *  - Pluralisation: '1 Year' vs '2 Years'
 *  - Cancel button fires onClose
 *  - Renew button POSTs and shows success toast + closes on success
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

import DomainRenewalModal from "@/components/DomainRenewalModal";

const FAR_FUTURE_DATE = "2027-12-31";
const SOON_DATE = (() => {
  // Compute a date 10 days from now (vi.setSystemTime fixes "now").
  const d = new Date("2026-06-09");
  return d.toISOString();
})();

const renewalInfo = (expiryDate: string) => ({
  pricing: { price: 1500, currency: "INR", years: 1, domain: "anutech.com" },
  expiry: { domain: "anutech.com", expirydate: expiryDate, expirydateinseconds: 0 },
});

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  // Fix "now" so daysUntilExpiry math is deterministic.
  vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<DomainRenewalModal>", () => {
  it("isOpen=false renders nothing + does not fetch", () => {
    render(
      <DomainRenewalModal isOpen={false} onClose={vi.fn()} domainName="anutech.com" />
    );
    expect(screen.queryByText(/domain renewal/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isOpen=true → shows loading copy + fetches /api/v1/domains/renew", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(
      <DomainRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />
    );
    expect(screen.getByText(/loading renewal information/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/v1/domains/renew?domainName=anutech.com&years=1"
      ),
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("successful fetch renders current status, pricing, and renewal-period buttons", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => renewalInfo(FAR_FUTURE_DATE),
    });
    render(
      <DomainRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />
    );
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument());
    expect(screen.getByText(/renewal cost/i)).toBeInTheDocument();
    expect(screen.getByText(/₹\s*1,500/)).toBeInTheDocument();
    // 6 renewal-period buttons (1/2/3/4/5/10 years).
    for (const label of ["1 Year", "2 Years", "3 Years", "4 Years", "5 Years", "10 Years"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}$`, "i") })).toBeInTheDocument();
    }
  });

  it("HTTP error → toast.error with server message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Domain not found" }),
    });
    render(
      <DomainRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />
    );
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Domain not found"));
  });

  it("expiry within 30 days surfaces the red 'expiring soon' warning block", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => renewalInfo(SOON_DATE),
    });
    render(
      <DomainRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />
    );
    await waitFor(() =>
      expect(screen.getByText(/expiring soon! renew now/i)).toBeInTheDocument()
    );
  });

  it("selecting a different year refetches with the new ?years= query param", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => renewalInfo(FAR_FUTURE_DATE),
    });
    render(
      <DomainRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />
    );
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument());
    fetchMock.mockClear();
    await user.click(screen.getByRole("button", { name: /^3 Years$/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("years=3"),
        expect.any(Object)
      )
    );
  });

  it("Cancel button (top-right + footer) fires onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => renewalInfo(FAR_FUTURE_DATE),
    });
    render(<DomainRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("successful renew POST → success toast + onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => renewalInfo(FAR_FUTURE_DATE) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    render(<DomainRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument());
    // The Renew button is the only "Renew" button visible — find it by name.
    const renewBtn = screen.getByRole("button", { name: /^renew domain$/i });
    await user.click(renewBtn);
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/renewed successfully/i))
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("failed renew POST → toast.error with server message; modal stays open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => renewalInfo(FAR_FUTURE_DATE) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Payment declined" }) });
    render(<DomainRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument());
    const renewBtn = screen.getByRole("button", { name: /^renew domain$/i });
    await user.click(renewBtn);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Payment declined"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
