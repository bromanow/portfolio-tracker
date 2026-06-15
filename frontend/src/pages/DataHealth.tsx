import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  HeartPulse, AlertTriangle, CircleCheck, ChevronDown, ChevronRight,
  RefreshCw, Loader2, ArrowUpRight,
} from 'lucide-react'
import { getDataHealth, type DataHealthCheck } from '../api/client'

const sevText: Record<string, string> = { warning: 'text-amber-600', danger: 'text-red-600' }
const sevBg: Record<string, string> = {
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger:  'bg-red-50 text-red-700 border-red-200',
}

// Per-check column layout for the items table — keeps each issue type readable.
const COLUMNS: Record<string, { key: string; label: string }[]> = {
  unpriced:        [{ key: 'ticker', label: 'Ticker' }, { key: 'account', label: 'Account' }, { key: 'quantity', label: 'Qty' }, { key: 'cost_cad', label: 'Cost' }, { key: 'reason', label: 'Why' }],
  expired_options: [{ key: 'ticker', label: 'Option' }, { key: 'account', label: 'Account' }, { key: 'expiry', label: 'Expired' }, { key: 'days_past', label: 'Days ago' }, { key: 'quantity', label: 'Qty' }],
  zero_cost:       [{ key: 'ticker', label: 'Ticker' }, { key: 'account', label: 'Account' }, { key: 'quantity', label: 'Qty' }],
  stale_prices:    [{ key: 'ticker', label: 'Ticker' }, { key: 'last_priced', label: 'Last priced' }, { key: 'days_old', label: 'Days old' }],
  stale_accounts:  [{ key: 'account', label: 'Account' }, { key: 'brokerage', label: 'Brokerage' }, { key: 'source', label: 'Source' }, { key: 'last_loaded', label: 'Last loaded' }, { key: 'days_since_load', label: 'Days' }],
  unused_securities: [{ key: 'ticker', label: 'Ticker' }, { key: 'name', label: 'Name' }, { key: 'asset_class', label: 'Class' }],
}

function fmtCell(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (key === 'cost_cad') return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  if (key === 'quantity') return String(Number(v))
  return String(v)
}

function CheckCard({ check, onAction }: { check: DataHealthCheck; onAction: (route: string) => void }) {
  const pass = check.status === 'pass'
  const [open, setOpen] = useState(!pass && check.severity === 'danger')
  const cols = COLUMNS[check.key] ?? []

  if (pass) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3">
        <CircleCheck className="h-5 w-5 text-emerald-500 flex-shrink-0" />
        <span className="font-medium text-gray-800">{check.title}</span>
        <span className="text-sm text-gray-400">— no issues</span>
      </div>
    )
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left">
        <div className="flex items-center gap-3 min-w-0">
          <AlertTriangle className={`h-5 w-5 flex-shrink-0 ${sevText[check.severity]}`} />
          <span className="font-medium text-gray-800">{check.title}</span>
          <span className={`text-xs px-2 py-0.5 rounded-md border ${sevBg[check.severity]}`}>{check.count}</span>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" /> : <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" />}
      </button>

      {open && (
        <div className="px-4 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <p className="text-sm text-gray-500">{check.hint}</p>
            <button
              onClick={() => onAction(check.action.route)}
              className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              {check.action.label} <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
                  {cols.map(c => <th key={c.key} className="py-1.5 pr-4 font-medium whitespace-nowrap">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {check.items.map((it, i) => (
                  <tr key={i} className="border-b border-gray-50 last:border-0">
                    {cols.map(c => (
                      <td key={c.key} className="py-2 pr-4 text-gray-700 whitespace-nowrap">{fmtCell(c.key, it[c.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DataHealth() {
  const navigate = useNavigate()
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['data-health'],
    queryFn: getDataHealth,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const issues = data?.issue_count ?? 0
  const passing = data?.checks_passing ?? 0
  const total = data?.checks_total ?? 0

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <HeartPulse className="h-6 w-6 text-blue-600" />
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">Data Health</h1>
            <p className="text-xs md:text-sm text-gray-400 mt-0.5">
              Keep the portfolio data clean so the analysis stays meaningful.
            </p>
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> Re-run
        </button>
      </div>

      {/* Summary */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500">Open issues</div>
            <div className={`text-2xl font-semibold ${issues > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{issues}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-500">Checks passing</div>
            <div className="text-2xl font-semibold text-gray-800">{passing} / {total}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 col-span-2 sm:col-span-1">
            <div className="text-xs text-gray-500">Last run</div>
            <div className="text-2xl font-semibold text-gray-800">
              {data.generated_at ? new Date(data.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Running checks…
        </div>
      ) : (
        <div className="space-y-3">
          {data?.checks
            .slice()
            .sort((a, b) => Number(b.count > 0) - Number(a.count > 0)
              || (a.severity === 'danger' ? -1 : 1) - (b.severity === 'danger' ? -1 : 1))
            .map(c => <CheckCard key={c.key} check={c} onAction={(r) => navigate(r)} />)}
        </div>
      )}
    </div>
  )
}
