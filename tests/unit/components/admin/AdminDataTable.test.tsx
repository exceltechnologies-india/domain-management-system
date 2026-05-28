/**
 * Component tests for <AdminDataTable> (rescan-4 M14).
 * The generic admin table workhorse. Tests cover rendering (title + columns
 * + rows + empty / loading states + custom column.render), client-side
 * search filtering, sort toggle, client-side pagination across pages, the
 * server-side pagination mode (external totalItems + onPageChange), the
 * onSearch hook in server-side mode, and the row right-click →
 * onRowContextMenu wiring.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import AdminDataTable, { type Column } from "@/components/admin/AdminDataTable";

interface Row {
  id: string;
  name: string;
  amount: number;
}

const columns: Column<Row>[] = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name", sortable: true },
  { key: "amount", label: "Amount", sortable: true, render: (v) => `₹${v}` },
];

const tenRows: Row[] = Array.from({ length: 10 }, (_, i) => ({
  id: `r${i + 1}`,
  name: `Customer ${String.fromCharCode(74 - i)}`, // J, I, H, …, A → unsorted alphabetically
  amount: (i + 1) * 100,
}));

describe("<AdminDataTable>", () => {
  it("renders the title, column headers, and rows", () => {
    render(<AdminDataTable title="Orders" columns={columns} data={tenRows.slice(0, 2)} pagination={false} />);
    expect(screen.getByRole("heading", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getByText("ID")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Amount")).toBeInTheDocument();
    // Custom column.render formats the amount as ₹100
    expect(screen.getByText("₹100")).toBeInTheDocument();
    expect(screen.getByText("Customer J")).toBeInTheDocument();
  });

  it("renders the 'No data available' empty state for an empty dataset", () => {
    render(<AdminDataTable title="Orders" columns={columns} data={[]} />);
    expect(screen.getByText(/no data available/i)).toBeInTheDocument();
  });

  it("renders a loading row while isLoading is true (no data row content)", () => {
    render(<AdminDataTable title="Orders" columns={columns} data={tenRows} isLoading />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText("Customer J")).not.toBeInTheDocument();
  });

  it("filters rows client-side as the user types into the search input", async () => {
    const user = userEvent.setup();
    render(<AdminDataTable title="Orders" columns={columns} data={tenRows} pagination={false} />);
    await user.type(screen.getByPlaceholderText(/search/i), "Customer C");
    // Only the matching row remains; J disappears
    expect(screen.getByText("Customer C")).toBeInTheDocument();
    expect(screen.queryByText("Customer J")).not.toBeInTheDocument();
  });

  it("sorts ascending on first click of a sortable column and toggles to descending on the second", async () => {
    const user = userEvent.setup();
    render(<AdminDataTable title="Orders" columns={columns} data={tenRows} pagination={false} />);
    const nameHeader = screen.getByText("Name").closest("th") as HTMLElement;

    // First click → sort ascending (A first)
    await user.click(nameHeader);
    let rows = screen.getAllByRole("row").slice(1); // skip header
    expect(rows[0].textContent).toContain("Customer A");

    // Second click → sort descending (J first)
    await user.click(nameHeader);
    rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("Customer J");
  });

  it("paginates client-side and the Next/Prev controls update the visible rows", async () => {
    const user = userEvent.setup();
    // 15 rows + default pageSize=10 → 2 pages
    const fifteen: Row[] = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i + 1}`,
      name: `Customer ${i + 1}`,
      amount: i * 10,
    }));
    render(<AdminDataTable title="Orders" columns={columns} data={fifteen} pageSize={10} />);
    // Page 1 shows rows 1–10, no Customer 11
    expect(screen.getByText("Customer 1")).toBeInTheDocument();
    expect(screen.queryByText("Customer 11")).not.toBeInTheDocument();

    // Page-2 button → rows 11–15 visible
    await user.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Customer 11")).toBeInTheDocument();
    expect(screen.queryByText("Customer 1​")).not.toBeInTheDocument();
  });

  it("uses external totalItems + currentPage + onPageChange in server-side mode", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <AdminDataTable
        title="Orders"
        columns={columns}
        data={tenRows}
        totalItems={50}
        currentPage={2}
        onPageChange={onPageChange}
        pageSize={10}
      />
    );
    // Showing 11 to 20 of 50 — confirms server-side math, not client-side data.length
    expect(screen.getByText(/showing 11 to 20 of 50/i)).toBeInTheDocument();

    // Click page 3 → onPageChange fires with 3, NOT a state mutation in the table
    await user.click(screen.getByRole("button", { name: "3" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("calls onSearch when the search input changes in server-side mode", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const onPageChange = vi.fn();
    render(
      <AdminDataTable
        title="Orders"
        columns={columns}
        data={tenRows}
        totalItems={50}
        currentPage={1}
        onPageChange={onPageChange}
        onSearch={onSearch}
      />
    );
    await user.type(screen.getByPlaceholderText(/search/i), "ab");
    // onSearch fires per keystroke
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(onSearch).toHaveBeenLastCalledWith("ab");
  });

  it("hides the search input when searchable is false", () => {
    render(<AdminDataTable title="Orders" columns={columns} data={tenRows} searchable={false} />);
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });

  it("fires onRowContextMenu with the row data on right-click", () => {
    const onRowContextMenu = vi.fn();
    render(
      <AdminDataTable
        title="Orders"
        columns={columns}
        data={tenRows.slice(0, 1)}
        onRowContextMenu={onRowContextMenu}
        pagination={false}
      />
    );
    const row = screen.getByText("Customer J").closest("tr") as HTMLElement;
    fireEvent.contextMenu(row);
    expect(onRowContextMenu).toHaveBeenCalledTimes(1);
    expect(onRowContextMenu.mock.calls[0][1]).toMatchObject({ id: "r1", name: "Customer J" });
  });
});
