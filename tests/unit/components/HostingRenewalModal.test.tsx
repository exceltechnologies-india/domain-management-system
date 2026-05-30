/**
 * Component tests for <HostingRenewalModal> (rescan-4 M14).
 * Hosting variant of DomainRenewalModal (slice 7ct) — but uses the
 * Razorpay iframe checkout flow rather than a mock paymentId. Mocks:
 *  - global.fetch
 *  - next-auth/react.useSession
 *  - next/navigation.useRouter
 *  - safeSessionStorage
 *  - useRazorpayCheckout (open + Frame)
 *  - react-hot-toast
 *
 * Coverage focuses on the load + renew step machine:
 *   load (loading) → render → POST renew → razorpay.open → verify → success
 *                                       ↘ dismissed → reset to render
 *                                       ↘ other rzp error → toast.error
 *   load fail → toast.error + onClose
 */
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const useSessionMock = vi.hoisted(() => vi.fn(() => ({ data: { user: { email: "a@b.com" } } })));
vi.mock("next-auth/react", () => ({ useSession: useSessionMock }));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const sessionStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeSessionStorage: {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => sessionStore.set(k, v),
  },
}));

const razorpayOpenMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/RazorpayCheckoutFrame", () => ({
  useRazorpayCheckout: () => ({
    open: razorpayOpenMock,
    Frame: () => <div data-testid="rzp-frame" />,
  }),
}));

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

import HostingRenewalModal from "@/components/HostingRenewalModal";

const fetchMock = vi.fn();

const renewalInfoBody = (expiry = "2027-12-31T00:00:00Z") => ({
  data: {
    domainName: "anutech.com",
    currentStatus: "active",
    currentExpiry: expiry,
    planName: "Business",
    renewalPricing: {
      price: 12000,
      currency: "INR",
      periodMonths: 12,
      periodYears: 1,
    },
  },
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  razorpayOpenMock.mockReset();
  pushMock.mockReset();
  sessionStore.clear();
  vi.setSystemTime(new Date("2026-05-30T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<HostingRenewalModal>", () => {
  it("isOpen=false renders nothing + does not fetch", () => {
    render(<HostingRenewalModal isOpen={false} onClose={vi.fn()} domainName="anutech.com" />);
    expect(screen.queryByText(/service renewal/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isOpen=true → fetches /renew-info with credentials and shows the header", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<HostingRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />);
    expect(screen.getByText(/service renewal/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/user/hosting/renew-info?domainName=anutech.com"),
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("successful renew-info renders plan name + renewal price", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => renewalInfoBody() });
    render(<HostingRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText("Business")).toBeInTheDocument());
    expect(screen.getByText(/₹\s*12,000/)).toBeInTheDocument();
  });

  it("renew-info HTTP error → toast.error and onClose", async () => {
    const onClose = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Plan not found" }),
    });
    render(<HostingRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Plan not found"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renew-info fetch throws → generic toast.error + onClose", async () => {
    const onClose = vi.fn();
    fetchMock.mockRejectedValueOnce(new Error("network"));
    render(<HostingRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/failed to load renewal info/i))
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("Renew → POST creates the order, razorpay dismissed → no toast (soft cancel)", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => renewalInfoBody() })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { razorpayOrderId: "ord_1", amount: 12000, currency: "INR", orderId: "internal_1" },
        }),
      });
    razorpayOpenMock.mockRejectedValueOnce({ kind: "dismissed" });
    render(<HostingRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText("Business")).toBeInTheDocument());
    const renewBtn = screen.getByRole("button", { name: /^pay & renew now$/i });
    await act(async () => {
      await user.click(renewBtn);
    });
    expect(razorpayOpenMock).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("Renew → POST fail → toast.error with server message", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => renewalInfoBody() })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Renewal already in progress" }),
      });
    render(<HostingRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText("Business")).toBeInTheDocument());
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^pay & renew now$/i }));
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Renewal already in progress"));
    expect(razorpayOpenMock).not.toHaveBeenCalled();
  });

  it("Renew → razorpay generic error (not dismissed) → toast.error with message", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => renewalInfoBody() })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { razorpayOrderId: "ord_1", amount: 12000, currency: "INR", orderId: "internal_1" },
        }),
      });
    razorpayOpenMock.mockRejectedValueOnce({ kind: "error", message: "Card declined" });
    render(<HostingRenewalModal isOpen onClose={vi.fn()} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText("Business")).toBeInTheDocument());
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^pay & renew now$/i }));
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Card declined"));
  });

  it("happy path: order → razorpay success → verify success → success toast + router.push + onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => renewalInfoBody() })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { razorpayOrderId: "ord_1", amount: 12000, currency: "INR", orderId: "internal_1" },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    razorpayOpenMock.mockResolvedValueOnce({
      razorpay_order_id: "ord_1",
      razorpay_payment_id: "pay_1",
      razorpay_signature: "sig_1",
    });
    render(<HostingRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText("Business")).toBeInTheDocument());
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^pay & renew now$/i }));
    });
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/hosting renewed successfully/i))
    );
    expect(sessionStore.get("paymentResult")).toMatch(/status.*success/);
    expect(onClose).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/payment-success");
  });

  it("verify failure → toast.error with verify-error message (modal stays open)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => renewalInfoBody() })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { razorpayOrderId: "ord_1", amount: 12000, currency: "INR", orderId: "internal_1" },
        }),
      })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Signature mismatch" }) });
    razorpayOpenMock.mockResolvedValueOnce({
      razorpay_order_id: "ord_1",
      razorpay_payment_id: "pay_1",
      razorpay_signature: "sig_1",
    });
    render(<HostingRenewalModal isOpen onClose={onClose} domainName="anutech.com" />);
    await waitFor(() => expect(screen.getByText("Business")).toBeInTheDocument());
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^pay & renew now$/i }));
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Signature mismatch"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
