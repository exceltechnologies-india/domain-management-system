/**
 * Component tests for <StuckOrdersTable> (rescan-4 M14).
 * Pins the empty-render-nothing behaviour, the per-row identifying fields
 * (orderId, user, amount, and the "Last error" column: invoiceFailureReason
 * verbatim, truncated past 60 chars, or "no attempt recorded"), and — since
 * 25 Sep 2026 — that the table is read-only (no Re-sync).
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import StuckOrdersTable from "@/components/admin/invoice-diagnostics/StuckOrdersTable";
import type { OrderSlim } from "@/components/admin/invoice-diagnostics/types";

const stuckOne: OrderSlim = {
  _id: "o1",
  orderId: "ord-1",
  userName: "Alice",
  userEmail: "alice@example.com",
  status: "paid",
  amount: 1180,
  createdAt: "2025-01-01T10:00:00Z",
};

const stuckTwo: OrderSlim = {
  _id: "o2",
  orderId: "ord-2",
  userName: "Bob",
  userEmail: "bob@example.com",
  status: "paid",
  amount: 2000,
  invoiceFailedAt: "2025-02-01T10:05:00Z",
  invoiceFailureReason: "GSTIN missing on company profile",
  createdAt: "2025-02-01T10:00:00Z",
};

/** 74 characters — past the 60-char cut-off. */
const LONG_REASON =
  "Invoice number series exhausted for FY 2025-26; widen the series and retry";

const stuckLong: OrderSlim = {
  _id: "o3",
  orderId: "ord-3",
  userName: "Carol",
  userEmail: "carol@example.com",
  status: "paid",
  amount: 500,
  invoiceFailedAt: "2025-03-01T10:05:00Z",
  invoiceFailureReason: LONG_REASON,
  createdAt: "2025-03-01T10:00:00Z",
};

describe("<StuckOrdersTable>", () => {
  it("renders nothing when stuckOrders is empty", () => {
    const { container } = render(
      <StuckOrdersTable stuckOrders={[]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("names the section for what it is — paid orders with no bill, not a Zoho sync", () => {
    render(
      <StuckOrdersTable stuckOrders={[stuckOne]} />
    );
    expect(screen.getByRole("heading", { name: "Paid orders with no bill" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Reason" })).toBeInTheDocument();
    expect(screen.queryByText(/zoho/i)).not.toBeInTheDocument();
  });

  it("renders identifying fields and 'no attempt recorded' when no failure is on file", () => {
    render(
      <StuckOrdersTable stuckOrders={[stuckOne]} />
    );
    expect(screen.getByText("ord-1")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("₹1,180")).toBeInTheDocument();
    expect(screen.getByText("no attempt recorded")).toBeInTheDocument();
  });

  it("renders a short invoiceFailureReason verbatim", () => {
    render(
      <StuckOrdersTable stuckOrders={[stuckTwo]} />
    );
    expect(screen.getByText("GSTIN missing on company profile")).toBeInTheDocument();
    expect(screen.queryByText("no attempt recorded")).not.toBeInTheDocument();
  });

  it("truncates a reason over 60 chars and keeps the full text in the title", () => {
    expect(LONG_REASON.length).toBeGreaterThan(60);
    render(
      <StuckOrdersTable stuckOrders={[stuckLong]} />
    );
    const cell = screen.getByTitle(LONG_REASON);
    expect(cell.textContent).toBe(`${LONG_REASON.slice(0, 58)}…`);
  });

  // DMS issues no bills (owner decision, 24 Sep 2026): the Re-sync actions
  // that issued one from here were removed with the engine. The table is a
  // read-only list for an operator to bill in ResellerOS.
  it("offers no Re-sync action of any kind", () => {
    render(<StuckOrdersTable stuckOrders={[stuckOne, stuckTwo]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/re-sync/i)).not.toBeInTheDocument();
    expect(screen.getByText(/raise each bill in ResellerOS/)).toBeInTheDocument();
  });
});
