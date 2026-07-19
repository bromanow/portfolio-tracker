import { useState } from 'react'
import { AlertTriangle, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'

// ─── Confirmation Dialog ──────────────────────────────────────────────────────
export function ConfirmDialog({
  title, message, confirmLabel = 'Delete', onConfirm, onCancel, danger = true,
  requireTyping,
}: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
  requireTyping?: string
}) {
  const [typed, setTyped] = useState('')
  const canConfirm = !requireTyping || typed === requireTyping
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className={`h-6 w-6 flex-shrink-0 mt-0.5 ${danger ? 'text-red-500 dark:text-red-400' : 'text-yellow-500'}`} />
          <div>
            <h3 className="font-semibold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{message}</p>
          </div>
        </div>
        {requireTyping && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">Type <strong>{requireTyping}</strong> to confirm:</p>
            <input
              className="bg-background text-foreground border rounded px-3 py-1.5 text-sm w-full"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={requireTyping}
            />
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm border border-border rounded hover:bg-muted/50">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm rounded text-white disabled:opacity-40 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-primary/90'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sort Helpers ─────────────────────────────────────────────────────────────
export type SortDir = 'asc' | 'desc'
export type SortState = { col: string; dir: SortDir }

export function useSortState(defaultCol: string, defaultDir: SortDir = 'asc') {
  const [sort, setSort] = useState<SortState>({ col: defaultCol, dir: defaultDir })
  const toggle = (col: string) =>
    setSort(s => ({ col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' }))
  return { sort, toggle }
}

export function sortRows<T>(rows: T[], col: string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const va = String((a as Record<string, unknown>)[col] ?? '')
    const vb = String((b as Record<string, unknown>)[col] ?? '')
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

export function SortTh({ label, col, sort, toggle, className = '' }: {
  label: string; col: string; sort: SortState; toggle: (col: string) => void; className?: string
}) {
  const active = sort.col === col
  return (
    <th className={`cursor-pointer select-none hover:bg-accent ${className}`} onClick={() => toggle(col)}>
      <div className="flex items-center gap-1">
        {label}
        {active
          ? sort.dir === 'asc'
            ? <ChevronUp className="h-3 w-3 text-primary" />
            : <ChevronDown className="h-3 w-3 text-primary" />
          : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
      </div>
    </th>
  )
}
