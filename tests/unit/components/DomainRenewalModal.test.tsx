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
 *  - Renew button does NOT post — see below
 *
 * The renew button used to POST with a payment id the component invented
 * (`renew_${Date.now()}_…`). Nothing charged the customer and the route
 * took it at face value, so every click renewed a domain at the registrar's
 * expense. The route now demands a verified Razorpay payment; no checkout
 * exists to produce one, so the button routes to support instead. Pinned
 * here because "it posts something" is what the old tests proved, and that
 * is the behaviour that must not come back by accident.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

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

  /**
   * These two replace "successful renew POST → success toast + onClose" and
   * "failed renew POST → toast.error …". Both pinned the fabricated-payment
   * behaviour: the component minted `renew_${Date.now()}_…` and posted it,
   * and the route renewed the domain at the registrar on the strength of it.
   *
   * They are replaced rather than deleted because the dangerous part is
   * precisely that it POSTed — so the replacement asserts the POST is GONE,
   * which is the thing a future refactor could quietly undo.
   */
  it("renew button does NOT post — no request beyond the initial GET", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => renewalInfo(FAR_FUTURE_DATE),
    });
    render(<DomainRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1); // the pricing GET

    await user.click(screen.getByRole("button", { name: /^renew domain$/i }));

    // Still one. Nothing was sent that could spend the reseller's balance.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST")
    ).toBe(false);
    // And it never claims a renewal happened.
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("renew button explains and routes to support, naming domain + term", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => renewalInfo(FAR_FUTURE_DATE),
    });
    render(<DomainRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText(/current status/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^renew domain$/i }));

    // What happened, and what to do next (CLAUDE.md §24) — never a bare "no".
    const msg = toastError.mock.calls[0][0] as string;
    expect(msg).toMatch(/not available yet/i);
    expect(msg).toMatch(/support/i);
    // The support page keeps `subject` in local state and reads no query
    // params, so the details must be in the message to be copyable.
    expect(msg).toContain("anutech.com");
    expect(msg).toMatch(/1 year/i);

    // Plain path — a ?subject= would be silently dropped by that page.
    expect(pushMock).toHaveBeenCalledWith("/dashboard/support");
    expect(onClose).toHaveBeenCalled();
  });

  it("the fabricated-payment-id shape is gone from the source", async () => {
    // A scan, because the behavioural tests above can only prove that TODAY's
    // click sends nothing — they would still pass if someone reinstated the
    // id generator behind a condition. This is the exact string that cost
    // the money: `renew_${Date.now()}_${Math.random()...}`.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("components/DomainRenewalModal.tsx", "utf8")
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/paymentId/);
    expect(code).not.toMatch(/method:\s*['"]POST['"]/);
    // Guard the guard: the strip must not have eaten the whole file.
    expect(code).toContain("handleRenewal");
  });
});
