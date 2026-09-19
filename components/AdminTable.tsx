// Generic over the row type — the heavier-weight `AdminDataTable` keeps a
// `value: any` for variance compatibility; this simpler component can stay
// `unknown` because its handful of callsites don't narrow on the value.
interface Column<T = unknown> {
  key: string;
  label: string;
  render?: (value: unknown, item: T) => React.ReactNode;
}

interface AdminTableProps<T = unknown> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
}

export default function AdminTable<T>({
  columns,
  data,
  loading = false,
  emptyMessage = 'No data available',
  className = ''
}: AdminTableProps<T>) {
  if (loading) {
    return (
      <div className={`bg-paper rounded-lg border border-hairline shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}>
        <div className="p-8 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber mx-auto"></div>
          <p className="mt-2 text-sm text-ink-3">Loading...</p>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className={`bg-paper rounded-lg border border-hairline shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}>
        <div className="p-8 text-center text-sm text-ink-3">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-paper rounded-lg border border-hairline shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden ${className}`}>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-hairline">
          <thead className="bg-paper-2/40">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="px-6 py-3 text-left text-[11px] font-bold text-ink-3 uppercase tracking-wider"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-paper divide-y divide-hairline">
            {data.map((item, index) => (
              <tr key={index} className="transition-colors hover:bg-paper-2/60">
                {columns.map((column) => (
                  <td key={column.key} className="px-6 py-4 whitespace-nowrap text-sm text-ink">
                    {column.render
                      ? column.render((item as Record<string, unknown>)[column.key], item)
                      : ((item as Record<string, unknown>)[column.key] as React.ReactNode)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
