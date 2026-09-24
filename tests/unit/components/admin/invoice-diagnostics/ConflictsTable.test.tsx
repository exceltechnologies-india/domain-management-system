/**
 * Component tests for <ConflictsTable> (rescan-4 M14).
 * Pins the empty-render-nothing behaviour, the group-header invoiceNumber +
 * count, the per-order row rendering (orderId, user, status, amount,
 * "Issued by" provider label, isDeleted tag), the
 * Clear # callback, and the pendingId disable.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ConflictsTable from "@/components/admin/invoice-diagnostics/ConflictsTable";
import type { ConflictGroup } from "@/components/admin/invoice-diagnostics/types";

const sampleGroup: ConflictGroup = {
  invoiceNumber: "INV-001",
  count: 2,
  orders: [
    {
      _id: "o1",
      orderId: "ord-aaa",
      userEmail: "alice@example.com",
      userName: "Alice",
      status: "paid",
      amount: 1180,
      invoiceProvider: "primary",
      createdAt: "2025-01-01T10:00:00Z",
    },
    {
      _id: "o2",
      orderId: "ord-bbb",
      userEmail: "bob@example.com",
      userName: "Bob",
      status: "failed",
      amount: 2000,
      invoiceProvider: "zoho",
      createdAt: "2025-02-01T10:00:00Z",
      isDeleted: true,
    },
  ],
};

describe("<ConflictsTable>", () => {
  it("renders nothing when conflicts is empty", () => {
    const { container } = render(
      <ConflictsTable conflicts={[]} pendingId={null} onClearInvoiceNumber={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the group header with invoiceNumber and '2 orders' count chip", () => {
    render(
      <ConflictsTable conflicts={[sampleGroup]} pendingId={null} onClearInvoiceNumber={vi.fn()} />
    );
    expect(screen.getByText("INV-001")).toBeInTheDocument();
    expect(screen.getByText("2 orders")).toBeInTheDocument();
  });

  it("renders each conflicting order's identifying fields", () => {
    render(
      <ConflictsTable conflicts={[sampleGroup]} pendingId={null} onClearInvoiceNumber={vi.fn()} />
    );
    expect(screen.getByText("ord-aaa")).toBeInTheDocument();
    expect(screen.getByText("ord-bbb")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("₹1,180")).toBeInTheDocument();
    expect(screen.getByText("₹2,000")).toBeInTheDocument();
  });

  it("tags isDeleted rows with the 'deleted' marker", () => {
    render(
      <ConflictsTable conflicts={[sampleGroup]} pendingId={null} onClearInvoiceNumber={vi.fn()} />
    );
    expect(screen.getByText(/deleted/i)).toBeInTheDocument();
  });

  it("labels who issued each invoice in the 'Issued by' column", () => {
    const unissued: ConflictGroup = {
      ...sampleGroup,
      invoiceNumber: "INV-002",
      orders: [{ ...sampleGroup.orders[0], _id: "o3", orderId: "ord-ccc", invoiceProvider: undefined }],
      count: 1,
    };
    render(
      <ConflictsTable conflicts={[sampleGroup, unissued]} pendingId={null} onClearInvoiceNumber={vi.fn()} />
    );
    expect(screen.getAllByRole("columnheader", { name: "Issued by" })).toHaveLength(2);
    const row = (orderId: string) => screen.getByText(orderId).closest("tr");
    expect(row("ord-aaa")?.textContent).toContain("GST engine");
    expect(row("ord-bbb")?.textContent).toContain("Zoho (historical)");
    const unissuedRow = row("ord-ccc");
    expect(unissuedRow?.textContent).toContain("—");
    expect(unissuedRow?.textContent).not.toContain("GST engine");
    expect(unissuedRow?.textContent).not.toContain("Zoho");
  });

  it("calls onClearInvoiceNumber with the order's orderId when Clear # is clicked", async () => {
    const user = userEvent.setup();
    const onClearInvoiceNumber = vi.fn();
    render(
      <ConflictsTable
        conflicts={[sampleGroup]}
        pendingId={null}
        onClearInvoiceNumber={onClearInvoiceNumber}
      />
    );
    const [firstBtn] = screen.getAllByRole("button", { name: /clear #/i });
    await user.click(firstBtn);
    expect(onClearInvoiceNumber).toHaveBeenCalledWith("ord-aaa");
  });

  it("disables only the row whose orderId matches pendingId", () => {
    render(
      <ConflictsTable
        conflicts={[sampleGroup]}
        pendingId="ord-bbb"
        onClearInvoiceNumber={vi.fn()}
      />
    );
    const buttons = screen.getAllByRole("button", { name: /clear #/i });
    expect(buttons[0]).not.toBeDisabled();
    expect(buttons[1]).toBeDisabled();
  });
});
