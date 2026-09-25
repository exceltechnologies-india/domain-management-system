/**
 * <RenewViaResellerOs> — the Renew dialog on the hosting and domains pages.
 * Pinned: it takes no payment (a plain link to ResellerOS's Pay URL); a read
 * failure is said, never shown as "no bill"; nothing is fetched while closed.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const swr = vi.hoisted(() => ({
  key: undefined as unknown,
  current: { data: undefined as unknown, error: undefined as unknown, isLoading: false },
}));
vi.mock("swr", () => ({
  default: (key: unknown) => {
    swr.key = key;
    return swr.current;
  },
}));
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));
vi.mock("@/hooks/useModalScroll", () => ({ useModalScroll: () => {} }));

import RenewViaResellerOs from "@/components/billing/RenewViaResellerOs";

const open = () =>
  render(<RenewViaResellerOs isOpen onClose={() => {}} serviceName="example.in" serviceType="hosting" />);

beforeEach(() => {
  swr.key = undefined;
  swr.current = { data: undefined, error: undefined, isLoading: false };
});

describe("<RenewViaResellerOs>", () => {
  it("fetches nothing while closed", () => {
    render(<RenewViaResellerOs isOpen={false} onClose={() => {}} serviceName="x.in" serviceType="domain" />);
    expect(swr.key).toBeNull();
  });

  it("a pending ResellerOS bill → a Pay link to ResellerOS", () => {
    swr.current = {
      data: { state: "ok", quotes: [{ id: "Q-9", amount: 708, status: "pending", paymentUrl: "https://ros.test/quote/Q-9/accept" }] },
      error: undefined,
      isLoading: false,
    };
    open();
    const pay = screen.getByRole("link", { name: /Pay ₹708/ });
    expect(pay).toHaveAttribute("href", "https://ros.test/quote/Q-9/accept");
  });

  it("no pending bill → explains ResellerOS emails one, and offers support", () => {
    swr.current = { data: { state: "no_bills" }, error: undefined, isLoading: false };
    open();
    expect(screen.getByText(/no renewal bill for example\.in to pay yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Contact support" })).toHaveAttribute("href", "/dashboard/support");
  });

  it("a failed read says so — it never claims there is no bill", () => {
    swr.current = { data: undefined, error: new Error("500"), isLoading: false };
    open();
    expect(screen.getByRole("alert")).toHaveTextContent(/can't tell whether one is waiting/);
    expect(screen.queryByText(/no renewal bill/)).not.toBeInTheDocument();
  });

  it("takes no payment itself (source scan, comments stripped)", () => {
    const code = readFileSync(path.join(process.cwd(), "components/billing/RenewViaResellerOs.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/RazorpayCheckout|hosting\/renew|payments\/verify|domains\/renew/);
  });
});
