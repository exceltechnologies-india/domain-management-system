/**
 * Component tests for <StuckOrdersTable> (rescan-4 M14).
 * Pins the empty-render-nothing behaviour, the per-row identifying fields
 * (orderId, user, amount, zohoInvoiceId vs "missing"), the Re-sync row
 * callback, the Re-sync-all visibility gate (only when there's > 1 stuck
 * order), the bulkProgress progress bar + counts + label, and the
 * pendingId/bulkProgress disable rules on the row + bulk buttons.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
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
  zohoInvoiceId: "zoho-already-set",
  createdAt: "2025-02-01T10:00:00Z",
};

describe("<StuckOrdersTable>", () => {
  it("renders nothing when stuckOrders is empty", () => {
    const { container } = render(
      <StuckOrdersTable
        stuckOrders={[]}
        pendingId={null}
        bulkProgress={null}
        onResync={vi.fn()}
        onResyncAll={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders identifying fields with 'missing' when there's no zohoInvoiceId", () => {
    render(
      <StuckOrdersTable
        stuckOrders={[stuckOne]}
        pendingId={null}
        bulkProgress={null}
        onResync={vi.fn()}
        onResyncAll={vi.fn()}
      />
    );
    expect(screen.getByText("ord-1")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("₹1,180")).toBeInTheDocument();
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
  });

  it("renders zohoInvoiceId verbatim when present", () => {
    render(
      <StuckOrdersTable
        stuckOrders={[stuckTwo]}
        pendingId={null}
        bulkProgress={null}
        onResync={vi.fn()}
        onResyncAll={vi.fn()}
      />
    );
    expect(screen.getByText("zoho-already-set")).toBeInTheDocument();
  });

  it("hides the 'Re-sync all' button when there's only one stuck order", () => {
    render(
      <StuckOrdersTable
        stuckOrders={[stuckOne]}
        pendingId={null}
        bulkProgress={null}
        onResync={vi.fn()}
        onResyncAll={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: /re-sync all/i })).not.toBeInTheDocument();
  });

  it("shows 'Re-sync all (N)' when there are multiple stuck orders and fires onResyncAll on click", async () => {
    const user = userEvent.setup();
    const onResyncAll = vi.fn();
    render(
      <StuckOrdersTable
        stuckOrders={[stuckOne, stuckTwo]}
        pendingId={null}
        bulkProgress={null}
        onResync={vi.fn()}
        onResyncAll={onResyncAll}
      />
    );
    const bulkBtn = screen.getByRole("button", { name: /re-sync all \(2\)/i });
    await user.click(bulkBtn);
    expect(onResyncAll).toHaveBeenCalledTimes(1);
  });

  it("calls onResync with the row's orderId on per-row Re-sync click", async () => {
    const user = userEvent.setup();
    const onResync = vi.fn();
    render(
      <StuckOrdersTable
        stuckOrders={[stuckOne]}
        pendingId={null}
        bulkProgress={null}
        onResync={onResync}
        onResyncAll={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: /^re-sync$/i }));
    expect(onResync).toHaveBeenCalledWith("ord-1");
  });

  it("renders the progress bar + summary line + 'Re-syncing X/Y…' label while a bulk run is in flight", () => {
    render(
      <StuckOrdersTable
        stuckOrders={[stuckOne, stuckTwo]}
        pendingId={null}
        bulkProgress={{ total: 2, done: 1, success: 1, failed: 0 }}
        onResync={vi.fn()}
        onResyncAll={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /re-syncing 1\/2/i })).toBeDisabled();
    // Summary: "1 synced · 0 failed · 1 remaining"
    expect(screen.getByText(/1 synced · 0 failed · 1 remaining/)).toBeInTheDocument();
  });

  it("disables the per-row button matching pendingId and disables every Re-sync while bulkProgress is active", () => {
    render(
      <StuckOrdersTable
        stuckOrders={[stuckOne, stuckTwo]}
        pendingId="ord-2"
        bulkProgress={null}
        onResync={vi.fn()}
        onResyncAll={vi.fn()}
      />
    );
    const rowButtons = screen.getAllByRole("button", { name: /^re-sync$/i });
    expect(rowButtons[0]).not.toBeDisabled();
    expect(rowButtons[1]).toBeDisabled();
  });
});
