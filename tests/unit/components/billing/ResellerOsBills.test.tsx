/**
 * <ResellerOsBills> — "Your bills" on the Invoices page.
 * Pinned: a failure renders a message, never an empty table; "No bills yet"
 * only on state no_bills (or a genuinely empty account); Pay only on a
 * pending quote, pointing at ResellerOS's payment_url.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const swr = vi.hoisted(() => ({ current: { data: undefined as unknown, error: undefined as unknown, isLoading: false } }));
vi.mock("swr", () => ({ default: () => swr.current }));
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));

import ResellerOsBills from "@/components/billing/ResellerOsBills";

beforeEach(() => {
  swr.current = { data: undefined, error: undefined, isLoading: false };
});

const QUOTES = [
  { id: "Q-1", amount: 708, currency: "INR", status: "accepted", pdfUrl: "https://ros.test/q1.pdf", paymentUrl: "https://ros.test/quote/Q-1/accept" },
  { id: "Q-2", amount: 1770, currency: "INR", status: "pending", pdfUrl: "https://ros.test/q2.pdf", paymentUrl: "https://ros.test/quote/Q-2/accept" },
];
const INVOICES = [
  { id: "INV-1", number: "INV-1", amount: 708, currency: "INR", status: "paid", issueDate: "2026-09-25", dueDate: null, pdfUrl: "https://ros.test/i1.pdf" },
];

describe("<ResellerOsBills>", () => {
  it("the DMS route failing shows a could-not-load message, not 'No bills yet'", () => {
    swr.current = { data: undefined, error: new Error("500"), isLoading: false };
    render(<ResellerOsBills />);
    expect(screen.getByRole("alert")).toHaveTextContent(/does not mean you have none/);
    expect(screen.queryByText("No bills yet")).not.toBeInTheDocument();
  });

  it("state unavailable shows the server's message, not an empty table", () => {
    swr.current = { data: { state: "unavailable", message: "We couldn't load your bills right now." }, error: undefined, isLoading: false };
    render(<ResellerOsBills />);
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't load your bills right now.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("state no_bills says so", () => {
    swr.current = { data: { state: "no_bills" }, error: undefined, isLoading: false };
    render(<ResellerOsBills />);
    expect(screen.getByText("No bills yet")).toBeInTheDocument();
  });

  it("lists paid orders and invoices with PDF links; Pay only on the pending quote, at ResellerOS's URL", () => {
    swr.current = { data: { state: "ok", quotes: QUOTES, invoices: INVOICES }, error: undefined, isLoading: false };
    render(<ResellerOsBills />);
    expect(screen.getByText("Paid order")).toBeInTheDocument();
    expect(screen.getByText("Awaiting payment")).toBeInTheDocument();
    const pay = screen.getAllByRole("link", { name: /^Pay/ });
    expect(pay).toHaveLength(1);
    expect(pay[0]).toHaveAttribute("href", "https://ros.test/quote/Q-2/accept");
    expect(pay[0]).toHaveTextContent("₹1,770");
    expect(screen.getByTitle("Download INV-1 (PDF)")).toHaveAttribute("href", "https://ros.test/i1.pdf");
    expect(screen.getByText(/One bill is waiting for payment/)).toBeInTheDocument();
  });

  it("a quote with no PDF says so rather than rendering a dead link", () => {
    swr.current = { data: { state: "ok", quotes: [{ ...QUOTES[0], pdfUrl: null }], invoices: [] }, error: undefined, isLoading: false };
    render(<ResellerOsBills />);
    expect(screen.getByText("PDF not available")).toBeInTheDocument();
  });
});
