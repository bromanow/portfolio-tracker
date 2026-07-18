import { useState, useMemo } from 'react'
import {
  ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight,
} from 'lucide-react'
import type { Account, CashStatementRow, ContinuityReport } from '../../api/client'
import { getPref } from '../../hooks/usePreference'

// ── Shared helpers ────────────────────────────────────────────────────────────

export function fmtCAD(val: number | string | null | undefined) {
  if (val === null || val === undefined || val === '') return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  if (getPref('hideValues')) return '••••••'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(n)
}

export function fmtCAD0(val: number | string | null | undefined) {
  if (val === null || val === undefined || val === '') return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  if (getPref('hideValues')) return '••••••'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

export function fmtCAD0Signed(val: number | string | null | undefined) {
  if (val === null || val === undefined || val === '') return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  if (getPref('hideValues')) return '••••••'
  const abs = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(n))
  return n < 0 ? `(${abs})` : abs
}

export function fmtCADAxis(val: number) {
  if (getPref('hideValues')) return '••••'
  if (Math.abs(val) >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (Math.abs(val) >= 1_000)     return `$${(val / 1_000).toFixed(0)}K`
  return `$${val}`
}

export function fmtAmt(val: string, decimals = 2) {
  const n = parseFloat(val)
  if (isNaN(n)) return '—'
  if (getPref('hideValues')) return '••••••'
  return Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export function fmtPct(v: number | null | undefined) {
  if (v === null || v === undefined) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

export const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6b7280']

// Matches PositionsPanel.tsx's ACCOUNT_TYPE_COLORS — same badge styling everywhere account
// type shows up, so RRSP/TFSA/etc. read consistently across Holdings and this report.
const ACCOUNT_TYPE_COLORS: Record<string, string> = {
  RRSP: 'bg-blue-100 text-blue-700',
  TFSA: 'bg-green-100 text-green-700',
  RESP: 'bg-yellow-100 text-yellow-700',
  NON_REG: 'bg-gray-100 text-gray-600',
  '401K': 'bg-purple-100 text-purple-700',
  IRA: 'bg-indigo-100 text-indigo-700',
  ROTH: 'bg-pink-100 text-pink-700',
}
export function AccountTypeBadge({ type }: { type: string | null | undefined }) {
  if (!type) return <span className="text-gray-300">—</span>
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs whitespace-nowrap ${ACCOUNT_TYPE_COLORS[type] || 'bg-gray-100 text-gray-600'}`}>
      {type}
    </span>
  )
}

export type SortDir = 'asc' | 'desc'

export function useSortState(defaultCol: string, defaultDir: SortDir = 'asc') {
  const [sort, setSort] = useState({ col: defaultCol, dir: defaultDir })
  const toggle = (col: string) => setSort(s => ({ col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' }))
  return { sort, toggle }
}

export function SortTh({ label, col, sort, toggle, className = '' }: {
  label: string; col: string; sort: { col: string; dir: SortDir }; toggle: (c: string) => void; className?: string
}) {
  const active = sort.col === col
  return (
    <th className={`cursor-pointer select-none hover:bg-gray-100 ${className}`} onClick={() => toggle(col)}>
      <div className="flex items-center gap-1">
        {label}
        {active
          ? sort.dir === 'asc' ? <ChevronUp className="h-3 w-3 text-blue-600" /> : <ChevronDown className="h-3 w-3 text-blue-600" />
          : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
      </div>
    </th>
  )
}

export function sortRows<T>(rows: T[], col: string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const va = String((a as Record<string, unknown>)[col] ?? '')
    const vb = String((b as Record<string, unknown>)[col] ?? '')
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

// ── Pagination bar (shared) ───────────────────────────────────────────────────
interface PaginationBarProps {
  page: number
  totalPages: number
  pageSize: number
  totalRows: number
  setPage: React.Dispatch<React.SetStateAction<number>>
  setPageSize: (n: number) => void
}

export function PaginationBar({ page, totalPages, pageSize, totalRows, setPage, setPageSize }: PaginationBarProps) {
  const start = totalRows === 0 ? 0 : (page - 1) * pageSize + 1
  const end   = Math.min(page * pageSize, totalRows)
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600 select-none">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Rows per page:</span>
        <select
          value={pageSize}
          onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
          className="border border-gray-300 rounded px-1.5 py-0.5 text-xs"
        >
          {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">
          {totalRows === 0 ? 'No rows' : `${start}–${end} of ${totalRows}`}
        </span>
        <div className="flex gap-1">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Portfolio Value & Continuity helpers ──────────────────────────────────────

export type PortfolioRange = 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL'

export function computePortfolioRange(range: PortfolioRange): { fromDate: string | undefined; toDate: string } {
  const today = new Date()
  const toStr = today.toISOString().slice(0, 10)
  if (range === 'ALL') return { fromDate: undefined, toDate: toStr }
  if (range === 'YTD') return { fromDate: `${today.getFullYear()}-01-01`, toDate: toStr }
  const years = range === '1Y' ? 1 : range === '3Y' ? 3 : 5
  const d = new Date(today); d.setFullYear(d.getFullYear() - years)
  return { fromDate: d.toISOString().slice(0, 10), toDate: toStr }
}

// Shared brokerage → account cascade used by portfolio reports
export function useAccountCascade(accts: Account[]) {
  const [brokerageFilter, setBrokerageFilterRaw] = useState('')
  const [selectedAccountIds, setSelectedAccountIds]   = useState<string[]>([])

  const brokerages = useMemo(
    () => [...new Set(accts.map(a => a.brokerage_name))].sort(),
    [accts],
  )
  const accountOptions = useMemo(
    () => accts
      .filter(a => !brokerageFilter || a.brokerage_name === brokerageFilter)
      .map(a => ({ value: String(a.id), label: a.name })),
    [accts, brokerageFilter],
  )
  const setBrokerageFilter = (brok: string) => {
    setBrokerageFilterRaw(brok)
    if (brok) {
      // Auto-select all accounts for this brokerage so the filter takes effect
      const ids = accts.filter(a => a.brokerage_name === brok).map(a => String(a.id))
      setSelectedAccountIds(ids)
    } else {
      // Clear selection to revert to "all accounts"
      setSelectedAccountIds([])
    }
  }
  // Default to all user accounts when nothing selected (ensures non-admin users are scoped)
  const accountIds = selectedAccountIds.length > 0
    ? selectedAccountIds.join(',')
    : accts.map(a => String(a.id)).join(',') || undefined

  return { brokerageFilter, setBrokerageFilter, brokerages, accountOptions, selectedAccountIds, setSelectedAccountIds, accountIds }
}

// ── Continuity table (shared between the Continuity report and any future use) ─
const CONT_ROWS: Array<{ key: keyof ContinuityReport; label: string; sign: 1 | -1 | 0; prefix?: string }> = [
  { key: 'contributions',           label: 'Contributions',               sign:  1, prefix: '+' },
  { key: 'withdrawals',             label: 'Withdrawals',                 sign: -1, prefix: '–' },
  { key: 'transfers',               label: 'Transfers (Net)',             sign:  0, prefix: '±' },
  { key: 'dividends_interest',      label: 'Dividends & Interest',        sign:  1, prefix: '+' },
  { key: 'realized_gains',          label: 'Realized Gains',              sign:  1, prefix: '+' },
  { key: 'fees',                    label: 'Fees & Withholding',          sign: -1, prefix: '–' },
  { key: 'unrealized_gains_change', label: 'Unrealized Gain/Loss Change', sign:  1, prefix: '±' },
]

export function ContinuityTable({ data }: { data: ContinuityReport }) {
  const open  = parseFloat(data.opening_balance)
  const close = parseFloat(data.closing_balance)
  const netChange = close - open
  const maxAbs = Math.max(Math.abs(open), ...CONT_ROWS.map(r => Math.abs(parseFloat(data[r.key] as string) || 0)))

  function rowColor(val: number, sign: 1 | -1 | 0) {
    if (sign === 0) return val >= 0 ? 'text-emerald-600' : 'text-red-500'
    if (val > 0) return sign === 1 ? 'text-emerald-600' : 'text-red-500'
    if (val < 0) return sign === -1 ? 'text-emerald-600' : 'text-red-500'
    return 'text-gray-400'
  }
  function barWidth(val: number) {
    if (maxAbs === 0) return '0%'
    return `${Math.min(100, Math.abs(val) / maxAbs * 100).toFixed(1)}%`
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <tbody>
          <tr className="border-b border-gray-200">
            <td className="py-2.5 pr-4 text-gray-500 w-8 text-xs font-mono" />
            <td className="py-2.5 pr-4 font-semibold text-gray-800 w-56">Opening Balance</td>
            <td className="py-2.5 text-right font-bold text-gray-900 w-36 tabular-nums">{fmtCAD0(data.opening_balance)}</td>
            <td className="py-2.5 pl-4 w-48 hidden sm:table-cell"><div className="h-2 bg-blue-200 rounded" style={{ width: barWidth(open) }} /></td>
          </tr>
          {CONT_ROWS.map(({ key, label, sign, prefix }) => {
            const val = parseFloat(data[key] as string) || 0
            if (val === 0 && key === 'transfers') return null
            return (
              <tr key={key} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 pr-4 text-gray-400 text-xs font-mono w-8">{prefix}</td>
                <td className="py-2 pr-4 text-gray-700 w-56">{label}</td>
                <td className={`py-2 text-right font-medium w-36 tabular-nums ${rowColor(val, sign)}`}>{fmtCAD0Signed(val)}</td>
                <td className="py-2 pl-4 w-48 hidden sm:table-cell">
                  <div className={`h-2 rounded ${val >= 0 ? 'bg-emerald-200' : 'bg-red-200'}`} style={{ width: barWidth(val) }} />
                </td>
              </tr>
            )
          })}
          <tr className="border-t-2 border-gray-300">
            <td className="py-3 pr-4 text-gray-500 w-8 text-xs font-mono">=</td>
            <td className="py-3 pr-4 font-bold text-gray-900 w-56">Closing Balance</td>
            <td className="py-3 text-right w-36 tabular-nums">
              <span className="font-bold text-gray-900">{fmtCAD0(data.closing_balance)}</span>
              <span className={`ml-2 text-xs font-medium ${netChange >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                {netChange >= 0 ? '▲' : '▼'} {fmtCAD0(Math.abs(netChange))}
              </span>
            </td>
            <td className="py-3 pl-4 w-48 hidden sm:table-cell"><div className="h-2 bg-blue-400 rounded" style={{ width: barWidth(close) }} /></td>
          </tr>
        </tbody>
      </table>
      {data.period_start && (
        <p className="mt-3 text-xs text-gray-400">
          Period: {data.period_start} → {data.period_end}
        </p>
      )}
      {!data.has_market_prices && (
        <p className="mt-2 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded">
          Note: Market prices not available for this period — balances reflect book value.
        </p>
      )}
    </div>
  )
}

// ── Cash statement helpers ──────────────────────────────────────────────────────

export const CASH_TYPE_LABELS: Record<string, string> = {
  CASH_OPENING: 'Opening Balance', BUY: 'Buy', SELL: 'Sell',
  DIVIDEND: 'Dividend', DRIP: 'DRIP', RETURN_OF_CAPITAL: 'Return of Capital',
  INTEREST: 'Interest', FEE: 'Fee', DEPOSIT: 'Deposit', WITHDRAWAL: 'Withdrawal',
  TRANSFER_IN: 'Transfer In', TRANSFER_OUT: 'Transfer Out',
  FX_CONVERSION: 'FX Conversion', FX_ADJUSTMENT: 'FX Adjustment',
  OPTION_BUY: 'Option Buy', OPTION_SELL: 'Option Sell',
  OPTION_EXPIRY: 'Option Expiry', OPTION_ASSIGNMENT: 'Option Assignment',
  OPTION_EXERCISE: 'Option Exercise', JOURNAL: 'Journal',
  ADJUSTMENT: 'Adjustment', OTHER: 'Other',
}

export function cashExportCsv(rows: CashStatementRow[], accountName: string, _currency: string, _closingBalance: string) {
  const headers = ['Date', 'Settlement Date', 'Account', 'Type', 'Ticker', 'Description', 'Debit', 'Credit', 'Balance']
  const esc = (v: string | null | undefined) => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = rows.map(r => {
    const n = parseFloat(r.impact)
    return [
      r.date, r.settlement_date ?? '', r.account_name ?? accountName,
      CASH_TYPE_LABELS[r.transaction_type] ?? r.transaction_type,
      r.ticker ?? '', r.description ?? '',
      n < 0 ? Math.abs(n).toFixed(2) : '',
      n > 0 ? n.toFixed(2) : '',
      r.balance != null ? parseFloat(r.balance).toFixed(2) : '',
    ].map(esc).join(',')
  })
  const csv = [headers.join(','), ...body].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `cash_statement_${accountName.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function cashExportPdf(rows: CashStatementRow[], accountName: string, currency: string, closingBalance: string) {
  const fmtN = (n: number) => Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const totalCredits = rows.filter(r => parseFloat(r.impact) > 0).reduce((s, r) => s + parseFloat(r.impact), 0)
  const totalDebits  = rows.filter(r => parseFloat(r.impact) < 0).reduce((s, r) => s + parseFloat(r.impact), 0)
  const bodyRows = rows.map(r => {
    const n = parseFloat(r.impact)
    const label = CASH_TYPE_LABELS[r.transaction_type] ?? r.transaction_type
    const desc = [r.ticker, r.description].filter(Boolean).join(' · ')
    return `<tr>
      <td>${r.date}</td>
      <td>${r.account_name ?? ''}</td>
      <td>${label}</td>
      <td class="desc">${desc}</td>
      <td class="num red">${n < 0 ? fmtN(n) : ''}</td>
      <td class="num grn">${n > 0 ? fmtN(n) : ''}</td>
      <td class="num bold">${r.balance != null ? fmtN(parseFloat(r.balance)) : '—'}</td>
    </tr>`
  }).join('')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <title>Cash Statement — ${accountName}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#111;padding:24px 32px}
    h1{font-size:18px;font-weight:700;margin-bottom:2px}
    .meta{font-size:11px;color:#666;margin-bottom:16px}
    .summary{display:flex;gap:32px;margin-bottom:16px;padding:10px 16px;background:#f8f9fa;border-radius:6px}
    .summary div{display:flex;flex-direction:column;gap:2px}
    .summary .lbl{font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em}
    .summary .val{font-size:14px;font-weight:700;font-family:monospace}
    .red{color:#dc2626}.grn{color:#059669}
    table{width:100%;border-collapse:collapse}
    thead th{background:#f1f5f9;border-bottom:2px solid #cbd5e1;padding:5px 7px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#475569}
    th.num{text-align:right}
    tbody tr:nth-child(even){background:#f8fafc}
    td{padding:4px 7px;border-bottom:1px solid #e2e8f0;vertical-align:top}
    td.num{text-align:right;font-family:monospace;white-space:nowrap}
    td.bold{font-weight:600}
    td.desc{max-width:200px;word-break:break-word}
    tfoot td{padding:6px 7px;border-top:2px solid #94a3b8;font-weight:700;background:#f1f5f9}
    tfoot td.num{text-align:right;font-family:monospace}
    @media print{body{padding:10px 14px}@page{margin:14mm 10mm;size:A4 landscape}}
  </style></head><body>
  <h1>Cash Statement</h1>
  <div class="meta">${accountName} &nbsp;·&nbsp; ${currency} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString('en-CA')}</div>
  <div class="summary">
    <div><span class="lbl">Closing Balance</span><span class="val">${fmtN(parseFloat(closingBalance))}</span></div>
    <div><span class="lbl">Total Credits</span><span class="val grn">${fmtN(totalCredits)}</span></div>
    <div><span class="lbl">Total Debits</span><span class="val red">${fmtN(Math.abs(totalDebits))}</span></div>
  </div>
  <table>
    <thead><tr>
      <th>Date</th><th>Account</th><th>Type</th><th>Description</th>
      <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>
    </tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr>
      <td colspan="4">Closing Balance</td>
      <td class="num red">${totalDebits !== 0 ? fmtN(Math.abs(totalDebits)) : '—'}</td>
      <td class="num grn">${totalCredits !== 0 ? fmtN(totalCredits) : '—'}</td>
      <td class="num">${fmtN(parseFloat(closingBalance))}</td>
    </tr></tfoot>
  </table>
  <script>window.onload=()=>window.print()<\/script>
  </body></html>`
  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(html)
  win.document.close()
}

export function ImpactCells({ row }: { row: CashStatementRow }) {
  const n = parseFloat(row.impact)
  if (row.transaction_type === 'CASH_OPENING') {
    return (
      <>
        <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
        <td className="px-4 py-2.5 text-right font-mono text-sm text-emerald-600">{fmtAmt(row.impact)}</td>
      </>
    )
  }
  if (n < 0) {
    return (
      <>
        <td className="px-4 py-2.5 text-right font-mono text-sm text-red-600">{fmtAmt(row.impact)}</td>
        <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
      </>
    )
  }
  return (
    <>
      <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
      <td className="px-4 py-2.5 text-right font-mono text-sm text-emerald-600">{fmtAmt(row.impact)}</td>
    </>
  )
}
