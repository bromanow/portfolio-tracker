import React from 'react'

export interface Column<T> {
  key: keyof T | string
  header: string
  render?: (row: T) => React.ReactNode
  className?: string
  headerClassName?: string
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  loading?: boolean
  emptyMessage?: string
  rowKey?: (row: T, i: number) => string | number
}

export function DataTable<T extends object>({
  columns,
  data,
  loading = false,
  emptyMessage = 'No data',
  rowKey,
}: DataTableProps<T>) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/50">
          <tr>
            {columns.map(col => (
              <th
                key={String(col.key)}
                className={`px-3 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider ${col.headerClassName || ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-card divide-y divide-border">
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr key={rowKey ? rowKey(row, i) : i} className="hover:bg-muted/50 transition-colors">
                {columns.map(col => (
                  <td
                    key={String(col.key)}
                    className={`px-3 py-2.5 whitespace-nowrap ${col.className || ''}`}
                  >
                    {col.render
                      ? col.render(row)
                      : String((row as Record<string, unknown>)[String(col.key)] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
