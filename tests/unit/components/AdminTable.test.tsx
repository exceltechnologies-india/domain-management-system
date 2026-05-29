/**
 * Component tests for the simpler <AdminTable> (rescan-4 M14).
 * The heavier `<AdminDataTable>` (covered in slice 7bt) handles search +
 * pagination; this lightweight sibling is just columns/data with a
 * loading + empty state.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import AdminTable from "@/components/AdminTable";

interface Row {
  name: string;
  status: string;
}

const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
];

const ROWS: Row[] = [
  { name: "alpha", status: "ok" },
  { name: "bravo", status: "down" },
];

describe("<AdminTable>", () => {
  it("loading=true renders a spinner + 'Loading...' (no table)", () => {
    const { container } = render(
      <AdminTable<Row> columns={COLUMNS} data={[]} loading />
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });

  it("empty data shows the default 'No data available' message", () => {
    render(<AdminTable<Row> columns={COLUMNS} data={[]} />);
    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("emptyMessage prop overrides the default copy", () => {
    render(
      <AdminTable<Row> columns={COLUMNS} data={[]} emptyMessage="nothing here yet" />
    );
    expect(screen.getByText("nothing here yet")).toBeInTheDocument();
  });

  it("renders headers + one row per data item using key→value mapping", () => {
    render(<AdminTable<Row> columns={COLUMNS} data={ROWS} />);
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "alpha" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "bravo" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "down" })).toBeInTheDocument();
  });

  it("column.render(value, row) wins over the default value lookup", () => {
    render(
      <AdminTable<Row>
        columns={[
          { key: "name", label: "Name" },
          {
            key: "status",
            label: "Status",
            render: (v, row) => <strong>{String(v).toUpperCase()}@{row.name}</strong>,
          },
        ]}
        data={ROWS}
      />
    );
    expect(screen.getByText("OK@alpha")).toBeInTheDocument();
    expect(screen.getByText("DOWN@bravo")).toBeInTheDocument();
  });
});
