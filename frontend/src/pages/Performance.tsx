import Reports from './Reports'
import { useState, useMemo, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import {
  RefreshCw, Loader2, AlertCircle, Pencil, X, Check,
  ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight,
  Download, Printer,
} from 'lucide-react'
import api from '../api/client'
import { getAccounts } from '../api/client'
import type { Account } from '../api/client'
import MultiSelectDropdown from '../components/MultiSelectDropdown'
import DatePicker from '../components/DatePicker'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TimelinePoint {
  date: string
  values: Record<string, number>
  invested: Record<string, number>
}
interface ChartEventItem {
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'JOURNAL'
  amount_cad: number
  account: string
  group_label: string
}
interface ChartEvent {
  date: string
  net_cad: number
  items: ChartEventItem[]
}
interface TimelineResponse {
  series_labels: string[]
  points: TimelinePoint[]
  events: ChartEvent[]
}
interface AccountReturn {
  account_ids: number[]
  account_name: string
  account_type: string
  brokerage: string
  current_value: number
  inception_date: string
  inception_date_custom: boolean
  returns: Record<string, number | null>
}

// ─── Constants ────────────────────────────────────────────────────────────────

type GroupBy = 'total' | 'brokerage' | 'account_type' | 'account'
type Period  = '1M' | '3M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL'
type TableGroup = 'none' | 'brokerage' | 'account_type'
type SortDir = 'asc' | 'desc'

// null = special-cased in fromDate (YTD = Jan 1 this year; ALL = 2020-01-01 floor).
const PERIOD_DAYS: Record<Period, number | null> = {
  '1M': 30, '3M': 90, 'YTD': null, '1Y': 365, '3Y': 1095, '5Y': 1825, 'ALL': null,
}
const DEFAULT_START = '2020-01-01'   // meaningful start for the combined (multi-account) data
const RETURN_PERIODS = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', 'inception'] as const
const PALETTE = [
  '#2563eb','#16a34a','#dc2626','#d97706','#7c3aed',
  '#0891b2','#be185d','#65a30d','#9333ea','#0f766e',
  '#b45309','#0369a1','#15803d','#b91c1c','#6d28d9',
]
// Benchmark indices offered as comparison overlays (must match backend whitelist).
const COMPARISON_INDICES = [
  { value: '^GSPTSE', label: 'S&P/TSX' },
  { value: '^GSPC',   label: 'S&P 500' },
  { value: '^DJI',    label: 'Dow Jones' },
  { value: '^IXIC',   label: 'NASDAQ' },
  { value: '^RUT',    label: 'Russell 2K' },
]
// Distinct (dashed) colours for benchmark lines so they read apart from portfolio series.
const INDEX_PALETTE = ['#0ea5e9','#f59e0b','#ec4899','#14b8a6','#a855f7']

interface IndexHistory {
  symbol: string
  label: string
  points: { date: string; close: number }[]
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const fmtCAD = (n: number | null | undefined) => {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n)
}
const fmtShort = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return n.toFixed(0)
}
const fmtPct = (n: number | null | undefined) => {
  if (n == null) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}
const pctClass = (n: number | null | undefined) =>
  n == null ? 'text-gray-400' : n >= 0 ? 'text-emerald-600' : 'text-red-500'

// Cash-flow event helpers: classify deposits/transfers-in as inflows (↑ green),
// withdrawals/transfers-out as outflows (↓ red); JOURNAL by amount sign.
const isInflowEvent = (it: ChartEventItem) =>
  it.type === 'DEPOSIT' || it.type === 'TRANSFER_IN' || (it.type === 'JOURNAL' && it.amount_cad >= 0)
const FLOW_LABEL: Record<ChartEventItem['type'], string> = {
  DEPOSIT: 'Deposit', WITHDRAWAL: 'Withdrawal',
  TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out', JOURNAL: 'Transfer',
}
// Cash-flow dot categories (which event dots to show on the chart).
const FLOW_OPTIONS = [
  { value: 'deposit', label: 'Deposits' },
  { value: 'withdrawal', label: 'Withdrawals' },
  { value: 'transfer', label: 'Transfers' },
]
const FLOW_CAT: Record<ChartEventItem['type'], string> = {
  DEPOSIT: 'deposit', WITHDRAWAL: 'withdrawal',
  TRANSFER_IN: 'transfer', TRANSFER_OUT: 'transfer', JOURNAL: 'transfer',
}

// ─── Chart tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, dateToEvents, indexLabels, mode }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  dateToEvents?: Record<string, ChartEvent>
  indexLabels?: Set<string>
  mode?: 'value' | 'indexed'
}) {
  if (!active || !payload?.length) return null
  const ev = label ? dateToEvents?.[label] : undefined
  const isIdx = mode === 'indexed'
  // In indexed mode series values are % change from the window start, not dollars.
  const fmtVal = (v: number | null | undefined) =>
    isIdx ? `${(v ?? 0) >= 0 ? '+' : ''}${(v ?? 0).toFixed(2)}%` : fmtCAD(v)
  // Split payload into portfolio series, benchmark indices, and invested baselines.
  const indexRows    = payload.filter(p => indexLabels?.has(p.name))
  const portfolioRows = payload.filter(p => !indexLabels?.has(p.name))
  // Total = sum of value lines only (exclude the dashed "(invested)" baselines).
  // Summing percentages is meaningless, so the Total row is hidden in indexed mode.
  const valueRows = portfolioRows.filter(p => !p.name.endsWith(' (invested)'))
  const total = valueRows.reduce((s, p) => s + (p.value ?? 0), 0)
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-xs min-w-[180px]">
      <div className="text-gray-500 font-medium mb-1.5 border-b border-gray-100 pb-1">{label}</div>
      {portfolioRows.map(p => (
        <div key={p.name} className="flex justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-semibold">{fmtVal(p.value)}</span>
        </div>
      ))}
      {!isIdx && valueRows.length > 1 && (
        <div className="flex justify-between gap-4 py-0.5 mt-1 pt-1 border-t border-gray-100">
          <span className="font-bold text-gray-700">Total</span>
          <span className="font-bold text-gray-900">{fmtCAD(total)}</span>
        </div>
      )}
      {indexRows.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-100 space-y-1">
          <div className="text-gray-400 text-[10px] uppercase tracking-wide mb-0.5">Benchmarks (if invested at start)</div>
          {indexRows.map(p => (
            <div key={p.name} className="flex justify-between gap-4 py-0.5">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-0.5 rounded" style={{ background: p.color }} />
                {p.name}
              </span>
              <span className="font-semibold">{fmtVal(p.value)}</span>
            </div>
          ))}
        </div>
      )}
      {ev && ev.items.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-100 space-y-1">
          <div className="text-gray-400 text-[10px] uppercase tracking-wide mb-0.5">Cash flows</div>
          {ev.items.map((item, i) => (
            <div key={i} className={`flex justify-between gap-3 font-medium ${isInflowEvent(item) ? 'text-emerald-600' : 'text-red-500'}`}>
              <span className="truncate max-w-[150px]">
                {isInflowEvent(item) ? '↑' : '↓'} {FLOW_LABEL[item.type]} · {item.account}
              </span>
              <span className="whitespace-nowrap">{fmtCAD(item.amount_cad)}</span>
            </div>
          ))}
          {ev.items.length > 1 && (
            <div className={`flex justify-between gap-3 font-bold border-t border-gray-100 pt-0.5 ${ev.net_cad >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
              <span>Net</span>
              <span>{fmtCAD(ev.net_cad)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, color = '' }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs text-gray-400 mb-0.5">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── Multi-select filter pill ─────────────────────────────────────────────────

function FilterPills<T extends string>({
  label, options, selected, onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  selected: Set<T>
  onChange: (v: Set<T>) => void
}) {
  const toggle = (v: T) => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange(next)
  }
  const allSelected = selected.size === 0 || selected.size === options.length
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-gray-400 font-medium">{label}:</span>
      <button
        onClick={() => onChange(new Set())}
        className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
          allSelected ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-500 hover:border-blue-400'
        }`}
      >All</button>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => toggle(o.value)}
          className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
            selected.has(o.value) && selected.size > 0
              ? 'bg-blue-600 text-white border-blue-600'
              : 'border-gray-300 text-gray-500 hover:border-blue-400'
          }`}
        >{o.label}</button>
      ))}
    </div>
  )
}

// ─── Inception date inline editor ─────────────────────────────────────────────

function InceptionDateCell({
  accountIds, date: currentDate, isCustom, onSaved,
}: {
  accountIds: number[]; date: string; isCustom: boolean; onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue]     = useState(currentDate)
  const [saving, setSaving]   = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => { setValue(currentDate); setEditing(true); setTimeout(() => inputRef.current?.focus(), 0) }
  const cancel    = () => { setEditing(false); setValue(currentDate) }

  const save = async () => {
    setSaving(true)
    try {
      await Promise.all(accountIds.map(id =>
        api.patch(`/accounts/${id}/returns-start-date`, { returns_start_date: value || null })
      ))
      onSaved(); setEditing(false)
    } finally { setSaving(false) }
  }
  const clear = async () => {
    setSaving(true)
    try {
      await Promise.all(accountIds.map(id =>
        api.patch(`/accounts/${id}/returns-start-date`, { returns_start_date: null })
      ))
      onSaved(); setEditing(false)
    } finally { setSaving(false) }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input ref={inputRef} type="date" value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel() }}
          className="text-xs border border-blue-400 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500 w-32" />
        <button onClick={save} disabled={saving} className="p-0.5 text-emerald-600 hover:text-emerald-700 disabled:opacity-50">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
        <button onClick={cancel} className="p-0.5 text-gray-400 hover:text-gray-600"><X className="h-3.5 w-3.5" /></button>
        {isCustom && <button onClick={clear} disabled={saving} className="text-[10px] text-gray-400 hover:text-red-500 ml-1">reset</button>}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1 group">
      <span className={isCustom ? 'text-blue-600 font-medium' : 'text-gray-400 italic'}>{currentDate}</span>
      <button onClick={startEdit} className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-blue-500 transition-opacity">
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  )
}

// ─── Sortable column header ───────────────────────────────────────────────────

function SortTh({ label, col, sortCol, sortDir, onSort, right = false }: {
  label: string; col: string; sortCol: string; sortDir: SortDir
  onSort: (c: string) => void; right?: boolean
}) {
  const active = sortCol === col
  return (
    <th
      className={`px-3 py-2.5 cursor-pointer select-none hover:bg-gray-100 transition-colors ${right ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {active
          ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
          : <ChevronsUpDown className="h-3 w-3 text-gray-300" />}
      </span>
    </th>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

type PageTab = 'performance' | 'reports'

function PerformanceInner() {
  const queryClient = useQueryClient()

  // Chart controls
  const [groupBy, setGroupBy]         = useState<GroupBy>('account_type')
  const [period, setPeriod]           = useState<Period>('ALL')
  const [showInvested, setShowInvested] = useState(false)
  const [showFlows, setShowFlows] = useState(true)             // master on/off for cash-flow dots
  const [flowFilter, setFlowFilter] = useState<string[]>([])   // [] = show all cash-flow dots
  // 'value' = dollar axis auto-fitted to the data; 'indexed' = every series rebased
  // to its first visible point and shown as % change, so different-sized accounts
  // become directly comparable on one scale.
  const [axisMode, setAxisMode] = useState<'value' | 'indexed'>('value')
  const [compareIndices, setCompareIndices] = useState<string[]>([])

  // Chart filters (which accounts to include) — string[] matches MultiSelectDropdown
  const [filterBrokerages, setFilterBrokerages] = useState<string[]>([])
  const [filterTypes, setFilterTypes]           = useState<string[]>([])
  const [filterAccounts, setFilterAccounts]     = useState<string[]>([])

  // Custom date range (overrides period pills when set)
  const [customFromDate, setCustomFromDate] = useState<string>('')
  const [customToDate, setCustomToDate]     = useState<string>('')

  // Returns table controls
  const [tableGroup, setTableGroup]   = useState<TableGroup>('none')
  const [tableSearch, setTableSearch] = useState('')
  const [collapsed, setCollapsed]     = useState<Set<string>>(new Set())
  const [sortCol, setSortCol]         = useState('account_name')
  const [sortDir, setSortDir]         = useState<SortDir>('asc')

  // Account list for filter panel
  const accountsQ = useQuery({
    queryKey: ['accounts'],
    queryFn: getAccounts,
    staleTime: 60_000,
  })
  const allAccounts: Account[] = accountsQ.data ?? []

  const brokerageOptions = useMemo(() =>
    [...new Set(allAccounts.map(a => a.brokerage_name).filter(Boolean))].sort()
      .map(b => ({ value: b!, label: b! })),
  [allAccounts])

  const typeOptions = useMemo(() =>
    [...new Set(allAccounts.map(a => a.account_type))].sort()
      .map(t => ({ value: t, label: t })),
  [allAccounts])

  const accountOptions = useMemo(() =>
    allAccounts
      .filter(a => {
        if (filterBrokerages.length > 0 && !filterBrokerages.includes(a.brokerage_name!)) return false
        if (filterTypes.length > 0 && !filterTypes.includes(a.account_type)) return false
        return true
      })
      .map(a => ({ value: String(a.id), label: a.name })),
  [allAccounts, filterBrokerages, filterTypes])

  // Compute account_ids filter string for API — always scoped to user's accounts
  const chartAccountIds = useMemo(() => {
    const matching = allAccounts.filter(a => {
      if (filterBrokerages.length > 0 && !filterBrokerages.includes(a.brokerage_name!)) return false
      if (filterTypes.length > 0 && !filterTypes.includes(a.account_type)) return false
      if (filterAccounts.length > 0 && !filterAccounts.includes(String(a.id))) return false
      return true
    })
    return matching.map(a => a.id).join(',') || undefined
  }, [allAccounts, filterBrokerages, filterTypes, filterAccounts])

  const fromDate = useMemo(() => {
    if (customFromDate) return customFromDate
    if (period === 'YTD') return `${new Date().getFullYear()}-01-01`
    if (period === 'ALL') return DEFAULT_START   // floor "ALL" at the meaningful combined-data start
    const days = PERIOD_DAYS[period]
    if (days == null) return DEFAULT_START
    const d = new Date(); d.setDate(d.getDate() - days)
    return d.toISOString().slice(0, 10)
  }, [period, customFromDate])

  const toDate = customToDate || undefined

  const timelineQ = useQuery({
    queryKey: ['perf-timeline', groupBy, fromDate, toDate, chartAccountIds],
    queryFn: () => api.get<TimelineResponse>('/portfolio/performance/timeline', {
      params: {
        group_by: groupBy,
        ...(fromDate ? { from_date: fromDate } : {}),
        ...(toDate   ? { to_date:   toDate   } : {}),
        ...(chartAccountIds ? { account_ids: chartAccountIds } : {}),
      },
    }).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const returnsQ = useQuery({
    queryKey: ['perf-returns'],
    queryFn: () => api.get<AccountReturn[]>('/portfolio/performance/returns').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const computeMut = useMutation({
    mutationFn: () => api.post<{ job_id: string }>('/portfolio/compute-snapshots').then(r => r.data),
    onSuccess: (data) => {
      const poll = setInterval(async () => {
        const res = await api.get(`/portfolio/jobs/${data.job_id}`)
        if (res.data.status === 'done' || res.data.status === 'failed') {
          clearInterval(poll)
          timelineQ.refetch()
          returnsQ.refetch()
        }
      }, 2000)
    },
  })

  const timeline = timelineQ.data
  const labels   = timeline?.series_labels ?? []
  const points   = timeline?.points ?? []
  const allEvents = timeline?.events ?? []
  // Cash-flow dots: master toggle (showFlows) gates them entirely; the filter then
  // narrows to the chosen types (empty filter = all types).
  const events = useMemo(() => {
    if (!showFlows) return []
    if (!flowFilter.length) return allEvents
    const sel = new Set(flowFilter)
    return allEvents
      .map(e => ({ ...e, items: e.items.filter(it => sel.has(FLOW_CAT[it.type])) }))
      .filter(e => e.items.length > 0)
  }, [allEvents, flowFilter, showFlows])
  const returns  = returnsQ.data ?? []

  // Map date → event (for tooltip)
  // Snapshots are sparse (only on dates with price history), so a flow date can
  // fall on a gap day with no data point. Recharts only draws dots at data
  // points, so snap each event to the nearest available chart point.
  const snapToPoint = useMemo(() => {
    const sorted = points.map(p => p.date.slice(0, 10)).sort()
    return (d: string): string => {
      if (!sorted.length) return d
      let best = sorted[0], bestDiff = Infinity
      for (const pd of sorted) {
        const diff = Math.abs(Date.parse(pd) - Date.parse(d))
        if (diff < bestDiff) { bestDiff = diff; best = pd }
      }
      return best
    }
  }, [points])

  const dateToEvents = useMemo(() => {
    const m: Record<string, ChartEvent> = {}
    for (const e of events) {
      const key = snapToPoint(e.date)
      if (m[key]) {
        m[key] = { ...m[key], net_cad: m[key].net_cad + e.net_cad, items: [...m[key].items, ...e.items] }
      } else {
        m[key] = { ...e, date: key }
      }
    }
    return m
  }, [events, snapToPoint])

  // Map series-label → Set of (snapped) dates that have events for that label (for dots)
  const labelEventDates = useMemo(() => {
    const m: Record<string, Set<string>> = {}
    for (const ev of events) {
      const key = snapToPoint(ev.date)
      for (const item of ev.items) {
        ;(m[item.group_label] ??= new Set()).add(key)
      }
    }
    return m
  }, [events, snapToPoint])

  const chartData = useMemo(() => points.map(p => {
    const row: Record<string, string | number> = { date: p.date.slice(0, 10) }
    for (const lbl of labels) {
      row[lbl] = p.values[lbl] ?? 0
      if (showInvested) row[`${lbl} (invested)`] = p.invested[lbl] ?? 0
    }
    return row
  }), [points, labels, showInvested])

  // ── Benchmark index comparison ────────────────────────────────────────────────
  // Fetch raw index closes over the visible date range, then rebase each so it
  // starts at the portfolio's total value on the first chart date — i.e. "what your
  // starting balance would be worth had you invested it in this index instead."
  const firstPointDate = points[0]?.date?.slice(0, 10)
  const lastPointDate  = points[points.length - 1]?.date?.slice(0, 10)

  const indexQ = useQuery({
    queryKey: ['perf-index-history', compareIndices, firstPointDate, lastPointDate],
    queryFn: () => api.get<IndexHistory[]>('/prices/index-history', {
      params: {
        symbols: compareIndices.join(','),
        from_date: firstPointDate,
        ...(lastPointDate ? { to_date: lastPointDate } : {}),
      },
    }).then(r => r.data),
    enabled: compareIndices.length > 0 && !!firstPointDate,
    staleTime: 30 * 60 * 1000,
  })

  const indexSeries = useMemo(() => {
    const histories = indexQ.data ?? []
    if (!histories.length || !points.length) return []
    const portfolioStart = labels.reduce((s, l) => s + (points[0].values[l] ?? 0), 0)
    if (portfolioStart <= 0) return []
    const chartDates = chartData.map(r => r.date as string)
    return histories
      .map((h, i) => {
        const sorted = [...h.points].sort((a, b) => a.date.localeCompare(b.date))
        if (!sorted.length) return null
        const baseClose = sorted[0].close
        if (!baseClose) return null
        // Forward-fill the most recent close onto each chart date, then rebase.
        const valueByDate: Record<string, number> = {}
        let j = 0, lastClose = baseClose
        for (const d of chartDates) {
          while (j < sorted.length && sorted[j].date <= d) { lastClose = sorted[j].close; j++ }
          valueByDate[d] = portfolioStart * (lastClose / baseClose)
        }
        return {
          key: `idx:${h.label}`,
          label: h.label,
          color: INDEX_PALETTE[i % INDEX_PALETTE.length],
          valueByDate,
        }
      })
      .filter((s): s is { key: string; label: string; color: string; valueByDate: Record<string, number> } => s !== null)
  }, [indexQ.data, points, labels, chartData])

  const indexLabels = useMemo(() => new Set(indexSeries.map(s => s.label)), [indexSeries])

  // Merge rebased benchmark values into each chart row (keyed by index label).
  const chartDataWithIndices = useMemo(() => {
    if (!indexSeries.length) return chartData
    return chartData.map(row => {
      const next = { ...row }
      for (const s of indexSeries) {
        const v = s.valueByDate[row.date as string]
        if (v != null) next[s.label] = v
      }
      return next
    })
  }, [chartData, indexSeries])

  // In 'indexed' mode, rebase every numeric series to its starting value as % change.
  // Two guards keep the math sane for accounts that open mid-window:
  //   • the baseline is the first value that's a meaningful fraction of the series' peak,
  //     so a tiny early seed (e.g. a $1 opening before real funding) doesn't blow up the % ;
  //   • the line is drawn only from that baseline date onward, so a type reads as "no line"
  //     before it opens instead of a spurious −100% (value 0 ÷ baseline − 1).
  const displayData = useMemo(() => {
    if (axisMode === 'value') return chartDataWithIndices
    const peak: Record<string, number> = {}
    for (const row of chartDataWithIndices)
      for (const k of Object.keys(row)) {
        if (k === 'date') continue
        const v = row[k]
        if (typeof v === 'number' && isFinite(v)) peak[k] = Math.max(peak[k] ?? 0, Math.abs(v))
      }
    const base: Record<string, number> = {}
    const baseDate: Record<string, string> = {}
    for (const row of chartDataWithIndices)
      for (const k of Object.keys(row)) {
        if (k === 'date' || k in base) continue
        const v = row[k]
        if (typeof v === 'number' && isFinite(v) && v !== 0 && Math.abs(v) >= (peak[k] ?? 0) * 0.01) {
          base[k] = v; baseDate[k] = row.date as string
        }
      }
    return chartDataWithIndices.map(row => {
      const next: Record<string, string | number> = { date: row.date as string }
      for (const k of Object.keys(row)) {
        if (k === 'date') continue
        const v = row[k]
        const b = base[k]
        // Skip zeros entirely (not just before open): a value of 0 means the account is empty
        // — e.g. the 1-day gap during a statement→live-feed handoff — and should read as a gap,
        // not a −100% crash.
        if (b && (row.date as string) >= baseDate[k] && typeof v === 'number' && isFinite(v) && v !== 0)
          next[k] = (v / b - 1) * 100
      }
      return next
    })
  }, [chartDataWithIndices, axisMode])

  // Auto-fit the Y axis to the visible data (with a little headroom) instead of
  // pinning it to zero, so movement in the lines is actually legible.
  const yDomain = useMemo<[number, number] | [number, string]>(() => {
    let min = Infinity, max = -Infinity
    for (const row of displayData) {
      for (const k of Object.keys(row)) {
        if (k === 'date') continue
        const v = (row as Record<string, string | number>)[k]
        if (typeof v === 'number' && isFinite(v)) { if (v < min) min = v; if (v > max) max = v }
      }
    }
    if (!isFinite(min) || !isFinite(max)) return [0, 'auto']
    if (min === max) return [min - 1, max + 1]
    const pad = (max - min) * 0.08
    return [min - pad, max + pad]
  }, [displayData])

  // ── Unified filtering ─────────────────────────────────────────────────────
  // The chart's account/type/brokerage filters drive the table AND summary cards,
  // so one set of controls updates everything together.
  const scopedReturns = useMemo(() => returns.filter(r => {
    if (filterBrokerages.length > 0 && !filterBrokerages.includes(r.brokerage)) return false
    if (filterTypes.length > 0 && !filterTypes.includes(r.account_type)) return false
    if (filterAccounts.length > 0 && !r.account_ids.some(id => filterAccounts.includes(String(id)))) return false
    return true
  }), [returns, filterBrokerages, filterTypes, filterAccounts])

  const onSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const filteredReturns = useMemo(() => {
    let rows = scopedReturns.filter(r =>
      !tableSearch || r.account_name.toLowerCase().includes(tableSearch.toLowerCase())
    )
    rows = [...rows].sort((a, b) => {
      let va: number | string, vb: number | string
      if (sortCol === 'account_name') { va = a.account_name; vb = b.account_name }
      else if (sortCol === 'current_value') { va = a.current_value; vb = b.current_value }
      else { va = a.returns[sortCol] ?? -Infinity; vb = b.returns[sortCol] ?? -Infinity }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      return sortDir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return rows
  }, [scopedReturns, tableSearch, sortCol, sortDir])

  // Group rows for display
  const groupedRows = useMemo(() => {
    if (tableGroup === 'none') return [{ key: '', label: '', rows: filteredReturns }]
    const groups: Record<string, AccountReturn[]> = {}
    for (const r of filteredReturns) {
      const key = tableGroup === 'brokerage' ? r.brokerage : r.account_type
      ;(groups[key] ??= []).push(r)
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => ({ key, label: key, rows }))
  }, [filteredReturns, tableGroup])

  const toggleCollapse = (key: string) => setCollapsed(s => {
    const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n
  })

  // Summary stats — scoped to the active filters so the cards match the chart + table
  const totalCurrent = useMemo(() => scopedReturns.reduce((s, r) => s + r.current_value, 0), [scopedReturns])
  const sorted1Y = [...scopedReturns].filter(r => r.returns['1Y'] != null).sort((a, b) => (b.returns['1Y'] ?? 0) - (a.returns['1Y'] ?? 0))
  const bestAcct  = sorted1Y[0]
  const worstAcct = sorted1Y[sorted1Y.length - 1]
  const latestDate = points.length ? points[points.length - 1].date : null
  // YTD card: value-weighted average of the per-account Modified Dietz YTD returns,
  // so the card matches the table (and excludes transfers/deposits) rather than the
  // naive (end−start)/start over the chart timeline.
  const ytdPct = useMemo(() => {
    const weighted = scopedReturns.reduce(
      (s, r) => { const v = r.returns['YTD']; return v != null ? s + v * r.current_value : s }, 0)
    const tw = scopedReturns
      .filter(r => r.returns['YTD'] != null)
      .reduce((s, r) => s + r.current_value, 0)
    return tw > 0 ? weighted / tw : null
  }, [scopedReturns])

  // Window stats: annualized (time-weighted) return + max drawdown over the visible
  // window. We chain per-step returns net of external cash flows so deposits/withdrawals
  // don't read as performance, and take drawdown off the same flow-adjusted index — so a
  // big transfer can't masquerade as a crash. Annualized only when the window ≥ 1 year;
  // shorter windows show the cumulative return instead (extrapolating < 1y is misleading).
  const windowStats = useMemo(() => {
    const empty = { value: null as number | null, annualized: false, maxDD: null as number | null }
    if (points.length < 2) return empty
    const totals = points.map(p => labels.reduce((s, l) => s + (p.values[l] ?? 0), 0))
    const flowByDate: Record<string, number> = {}
    for (const e of events) {
      const k = snapToPoint(e.date)
      flowByDate[k] = (flowByDate[k] ?? 0) + e.net_cad
    }
    let index = 1, peak = 1, maxDD = 0
    for (let i = 1; i < points.length; i++) {
      const prev = totals[i - 1]
      if (prev <= 0) continue
      const flow = flowByDate[points[i].date] ?? 0
      index *= 1 + (totals[i] - prev - flow) / prev
      if (index > peak) peak = index
      if (peak > 0) maxDD = Math.max(maxDD, (peak - index) / peak)
    }
    const days = (new Date(points[points.length - 1].date + 'T00:00:00').getTime()
      - new Date(points[0].date + 'T00:00:00').getTime()) / 864e5
    if (days >= 365 && index > 0) {
      return { value: (Math.pow(index, 365.25 / days) - 1) * 100, annualized: true, maxDD: -maxDD * 100 }
    }
    return { value: (index - 1) * 100, annualized: false, maxDD: -maxDD * 100 }
  }, [points, labels, events, snapToPoint])

  // ── Exports ────────────────────────────────────────────────────────────────
  // CSV of the chart series: date + every plotted line (portfolio, invested, benchmarks).
  const exportChartCsv = () => {
    if (!chartDataWithIndices.length) return
    const keys = new Set<string>()
    for (const row of chartDataWithIndices) for (const k of Object.keys(row)) if (k !== 'date') keys.add(k)
    const cols = ['date', ...keys]
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [cols.map(esc).join(',')]
    for (const row of chartDataWithIndices) {
      lines.push(cols.map(c => esc((row as Record<string, unknown>)[c] ?? '')).join(','))
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `performance_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 100)
  }

  // Print → 'Save as PDF'. A print stylesheet (`.print-area` in index.css) isolates
  // the chart + cards + table, so the browser's print dialog produces a crisp,
  // vector PDF — no rasterization, no extra dependencies.
  const printReport = () => window.print()

  const noData = !timelineQ.isLoading && points.length === 0
  const hasFilters = filterBrokerages.length > 0 || filterTypes.length > 0 || filterAccounts.length > 0

  return (
    <div className="space-y-4 md:space-y-6 max-w-7xl mx-auto">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">Performance</h1>
          <p className="text-xs md:text-sm text-gray-400 mt-0.5">Portfolio value over time · {latestDate ?? '—'}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Exports — disabled until there's a timeline to export */}
          <button
            onClick={exportChartCsv}
            disabled={points.length === 0}
            title="Download chart data as CSV"
            className="flex items-center gap-1.5 px-2.5 md:px-3 py-2 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            <Download className="h-4 w-4" />
            <span className="hidden md:inline">CSV</span>
          </button>
          <button
            onClick={printReport}
            disabled={points.length === 0}
            title="Print / Save as PDF (chart, stats, returns)"
            className="flex items-center gap-1.5 px-2.5 md:px-3 py-2 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors print:hidden"
          >
            <Printer className="h-4 w-4" />
            <span className="hidden md:inline">Print / PDF</span>
          </button>
          {/* Desktop: full button label; mobile: icon only */}
          <button
            onClick={() => computeMut.mutate()}
            disabled={computeMut.isPending}
            className="flex items-center gap-2 px-3 md:px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${computeMut.isPending ? 'animate-spin' : ''}`} />
            <span className="hidden md:inline">{computeMut.isPending ? 'Computing…' : 'Recompute Snapshots'}</span>
          </button>
        </div>
      </div>

      {/* Print region (Save-as-PDF): chart + stat cards + returns table */}
      <div className="print-area space-y-4 md:space-y-6">
      <div className="report-print-title">
        Portfolio Performance · {latestDate ?? new Date().toISOString().slice(0, 10)}
      </div>

      {/* ── Chart panel ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-3 md:p-5 space-y-3">
        {/* Row 1: group-by + period + date range + show-invested */}
        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
            {(['total','brokerage','account_type','account'] as GroupBy[]).map(g => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${groupBy === g ? 'bg-white shadow text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}>
                {g === 'account_type' ? 'By Type' : g === 'account' ? 'By Account' : g === 'brokerage' ? 'By Brokerage' : 'Total'}
              </button>
            ))}
          </div>
          {/* Period pills */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
            {(['1M','3M','YTD','1Y','3Y','5Y','ALL'] as Period[]).map(p => (
              <button key={p} onClick={() => { setPeriod(p); setCustomFromDate(''); setCustomToDate('') }}
                className={`px-2.5 py-1.5 text-xs rounded-md font-medium transition-colors ${period === p && !customFromDate ? 'bg-white shadow text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}>
                {p}
              </button>
            ))}
          </div>
          {/* Custom date range — desktop only */}
          <div className="hidden md:flex items-center gap-1 text-xs text-gray-500">
            <DatePicker
              value={customFromDate} onChange={setCustomFromDate}
              min="2000-01-01" max={new Date().toISOString().slice(0, 10)}
              placeholder="From" highlight={!!customFromDate} />
            <span className="text-gray-400">→</span>
            <DatePicker
              value={customToDate} onChange={setCustomToDate}
              min="2000-01-01" max={new Date().toISOString().slice(0, 10)}
              placeholder="To" highlight={!!customToDate} />
          </div>
          <div className="ml-auto flex items-center gap-3">
            {/* Y-axis mode: dollar value vs. indexed (% change from window start) */}
            <div className="flex items-center rounded border border-gray-200 overflow-hidden text-xs">
              <button
                onClick={() => setAxisMode('value')}
                className={`px-2.5 py-1 ${axisMode === 'value' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
                title="Dollar value (axis auto-fitted to the data)"
              >
                $
              </button>
              <button
                onClick={() => setAxisMode('indexed')}
                className={`px-2.5 py-1 border-l border-gray-200 ${axisMode === 'indexed' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
                title="Indexed — each series rebased to its start as % change, for comparing differently-sized accounts"
              >
                %
              </button>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showInvested} onChange={e => setShowInvested(e.target.checked)} className="rounded" />
              Show invested
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showFlows} onChange={e => setShowFlows(e.target.checked)} className="rounded" />
              Show cash flows
            </label>
          </div>
        </div>

        {/* Row 2: account filters (same MultiSelectDropdown style as header) */}
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelectDropdown
            placeholder="All Brokerages"
            options={brokerageOptions}
            selected={filterBrokerages}
            onChange={vals => { setFilterBrokerages(vals); setFilterAccounts([]) }}
          />
          <MultiSelectDropdown
            placeholder="All Types"
            options={typeOptions}
            selected={filterTypes}
            onChange={vals => { setFilterTypes(vals); setFilterAccounts([]) }}
          />
          <MultiSelectDropdown
            placeholder="All Accounts"
            options={accountOptions}
            selected={filterAccounts}
            onChange={setFilterAccounts}
            disabled={accountOptions.length === 0}
          />
          <MultiSelectDropdown
            placeholder="All cash flows"
            options={FLOW_OPTIONS}
            selected={flowFilter}
            onChange={setFlowFilter}
            disabled={!showFlows}
          />
          {hasFilters && (
            <button
              onClick={() => { setFilterBrokerages([]); setFilterTypes([]); setFilterAccounts([]) }}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" /> Clear
            </button>
          )}
          {/* Benchmark index comparison — desktop only */}
          <div className="hidden md:flex items-center gap-2 ml-auto">
            <span className="text-xs text-gray-400 font-medium whitespace-nowrap">Compare:</span>
            <MultiSelectDropdown
              placeholder="Add indices"
              options={COMPARISON_INDICES}
              selected={compareIndices}
              onChange={setCompareIndices}
            />
            {indexQ.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
          </div>
        </div>

        {/* Chart */}
        {timelineQ.isLoading ? (
          <div className="flex items-center justify-center h-72 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : noData ? (
          <div className="flex flex-col items-center justify-center h-72 text-gray-400 gap-3">
            <AlertCircle className="h-8 w-8" />
            <div className="text-center">
              <p className="font-medium">No snapshot data yet</p>
              <p className="text-sm mt-1">Click "Recompute Snapshots" to build the portfolio timeline.</p>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={displayData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date"
                tickFormatter={d => { const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('en-CA', { month: 'short', year: '2-digit' }) }}
                tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={60} />
              <YAxis
                domain={yDomain}
                allowDataOverflow
                tickFormatter={v => axisMode === 'indexed' ? `${v >= 0 ? '+' : ''}${v.toFixed(0)}%` : '$' + fmtShort(v)}
                tick={{ fontSize: 10 }} width={72} />
              <Tooltip
                cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '4 4' }}
                content={(props) => <ChartTooltip {...(props as any)} dateToEvents={dateToEvents} indexLabels={indexLabels} mode={axisMode} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {labels.map((lbl, i) => {
                const color = PALETTE[i % PALETTE.length]
                const eventDates = labelEventDates[lbl]
                return (
                  <Line
                    key={lbl} type="monotone" dataKey={lbl}
                    stroke={color} strokeWidth={2} name={lbl} connectNulls
                    dot={eventDates
                      ? (dotProps: any) => {
                          const { cx, cy, payload } = dotProps
                          const date: string = payload?.date
                          if (!date || !eventDates.has(date) || cx == null || cy == null) {
                            return <g key={`dot-${lbl}-${date}`} />
                          }
                          const ev = dateToEvents[date]
                          const lblItems = ev?.items.filter(it => it.group_label === lbl) ?? []
                          const hasDeposit    = lblItems.some(it => isInflowEvent(it))
                          const hasWithdrawal = lblItems.some(it => !isInflowEvent(it))
                          const fill = (hasWithdrawal && hasDeposit) ? '#d97706' : hasWithdrawal ? '#ef4444' : '#10b981'
                          return (
                            <circle key={`dot-${lbl}-${date}`} cx={cx} cy={cy} r={5} fill={fill} stroke="white" strokeWidth={2} />
                          )
                        }
                      : false
                    }
                    activeDot={{ r: 4, strokeWidth: 1.5, stroke: 'white' }}
                  />
                )
              })}
              {showInvested && labels.map((lbl, i) => (
                <Line key={`${lbl}-inv`} type="monotone" dataKey={`${lbl} (invested)`} stroke={PALETTE[i % PALETTE.length]} strokeWidth={1} strokeDasharray="4 3" dot={false} name={`${lbl} (invested)`} />
              ))}
              {indexSeries.map(s => (
                <Line key={s.key} type="monotone" dataKey={s.label} stroke={s.color} strokeWidth={1.5} strokeDasharray="5 3" dot={false} name={s.label} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Summary cards (scoped to the active filters) ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <SummaryCard label="Total Portfolio Value" value={fmtCAD(totalCurrent)} sub={latestDate ?? undefined} />
        <SummaryCard label="YTD Return" value={fmtPct(ytdPct)} color={pctClass(ytdPct)} />
        <SummaryCard
          label={windowStats.annualized ? 'Annualized' : 'Return (window)'}
          value={fmtPct(windowStats.value)}
          color={pctClass(windowStats.value)}
          sub="time-weighted"
        />
        <SummaryCard
          label="Max Drawdown"
          value={fmtPct(windowStats.maxDD)}
          color={pctClass(windowStats.maxDD)}
          sub="over window"
        />
        <SummaryCard label="Best Account (1Y)" value={bestAcct ? fmtPct(bestAcct.returns['1Y']) : '—'} sub={bestAcct?.account_name} color={pctClass(bestAcct?.returns['1Y'])} />
        <SummaryCard label="Worst Account (1Y)" value={worstAcct ? fmtPct(worstAcct.returns['1Y']) : '—'} sub={worstAcct?.account_name} color={pctClass(worstAcct?.returns['1Y'])} />
      </div>

      {/* ── Returns table ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">Period Returns by Account</h2>
            {returnsQ.isLoading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          </div>
          {/* Table controls */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text" placeholder="Search account…" value={tableSearch}
              onChange={e => setTableSearch(e.target.value)}
              className="text-xs border border-gray-200 rounded px-2 py-1 w-40 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            {hasFilters && (
              <span className="text-[11px] text-blue-600 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5">
                Filtered by chart controls
              </span>
            )}
            {/* Group by */}
            <div className="ml-auto flex items-center gap-1 text-xs text-gray-500">
              <span>Group:</span>
              {(['none','brokerage','account_type'] as TableGroup[]).map(g => (
                <button key={g} onClick={() => setTableGroup(g)}
                  className={`px-2 py-0.5 rounded border transition-colors ${tableGroup === g ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 hover:border-blue-300'}`}>
                  {g === 'none' ? 'None' : g === 'brokerage' ? 'Brokerage' : 'Type'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-xs divide-y divide-gray-100">
            <thead className="bg-gray-50 text-gray-500 uppercase text-[10px] tracking-wide">
              <tr>
                <SortTh label="Account"  col="account_name"  sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                <th className="px-3 py-2.5 text-left">Type</th>
                {tableGroup !== 'brokerage' && <th className="px-3 py-2.5 text-left">Brokerage</th>}
                <SortTh label="Value" col="current_value" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                {RETURN_PERIODS.map(p => (
                  <SortTh key={p} label={p} col={p} sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                ))}
                <th className="px-4 py-2.5 text-left" title="Click pencil to set custom start date">Since</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredReturns.length === 0 && !returnsQ.isLoading ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-400">No data.</td></tr>
              ) : groupedRows.map(group => (
                <>
                  {/* Group header */}
                  {tableGroup !== 'none' && (
                    <tr key={`g-${group.key}`} className="bg-gray-50 cursor-pointer" onClick={() => toggleCollapse(group.key)}>
                      <td colSpan={10} className="px-4 py-1.5 font-semibold text-gray-600 text-[11px] uppercase tracking-wide">
                        <span className="flex items-center gap-1">
                          {collapsed.has(group.key) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          {group.label} ({group.rows.length})
                        </span>
                      </td>
                    </tr>
                  )}
                  {/* Group rows */}
                  {!collapsed.has(group.key) && group.rows.map(r => (
                    <tr key={r.account_ids.join('-')} className="hover:bg-gray-50">
                      <td className="px-3 py-2.5 font-medium text-gray-800">{r.account_name}</td>
                      <td className="px-3 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          r.account_type === 'TFSA' ? 'bg-green-100 text-green-700' :
                          r.account_type === 'RRSP' ? 'bg-blue-100 text-blue-700' :
                          r.account_type === 'RESP' ? 'bg-purple-100 text-purple-700' :
                          'bg-gray-100 text-gray-600'}`}>{r.account_type}</span>
                      </td>
                      {tableGroup !== 'brokerage' && <td className="px-3 py-2.5 text-gray-500">{r.brokerage}</td>}
                      <td className="px-3 py-2.5 text-right font-semibold text-gray-800">{fmtCAD(r.current_value)}</td>
                      {RETURN_PERIODS.map(p => {
                        const val = r.returns[p]
                        return <td key={p} className={`px-3 py-2.5 text-right font-medium ${pctClass(val)}`}>{fmtPct(val)}</td>
                      })}
                      <td className="px-4 py-2.5">
                        <InceptionDateCell accountIds={r.account_ids} date={r.inception_date} isCustom={r.inception_date_custom}
                          onSaved={() => queryClient.invalidateQueries({ queryKey: ['perf-returns'] })} />
                      </td>
                    </tr>
                  ))}
                  {/* Group subtotal */}
                  {tableGroup !== 'none' && !collapsed.has(group.key) && group.rows.length > 1 && (
                    <tr key={`gt-${group.key}`} className="bg-gray-50/80 border-t border-gray-200">
                      <td className="px-3 py-1.5 text-[10px] font-bold text-gray-500 italic" colSpan={tableGroup === 'brokerage' ? 2 : 3}>
                        {group.label} subtotal
                      </td>
                      <td className="px-3 py-1.5 text-right text-[10px] font-bold text-gray-700">
                        {fmtCAD(group.rows.reduce((s, r) => s + r.current_value, 0))}
                      </td>
                      {RETURN_PERIODS.map(p => {
                        const weighted = group.rows.reduce((s, r) => {
                          const v = r.returns[p]; return v != null ? s + v * r.current_value : s
                        }, 0)
                        const tw = group.rows.filter(r => r.returns[p] != null).reduce((s, r) => s + r.current_value, 0)
                        const avg = tw > 0 ? weighted / tw : null
                        return <td key={p} className={`px-3 py-1.5 text-right text-[10px] font-bold ${pctClass(avg)}`}>{fmtPct(avg)}</td>
                      })}
                      <td />
                    </tr>
                  )}
                </>
              ))}
            </tbody>

            {/* Grand total footer */}
            {filteredReturns.length > 1 && (
              <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                <tr>
                  <td className="px-3 py-2.5 font-bold text-gray-800" colSpan={tableGroup === 'brokerage' ? 2 : 3}>Total Portfolio</td>
                  <td className="px-3 py-2.5 text-right font-bold text-gray-800">{fmtCAD(filteredReturns.reduce((s, r) => s + r.current_value, 0))}</td>
                  {RETURN_PERIODS.map(p => {
                    const weighted = filteredReturns.reduce((s, r) => { const v = r.returns[p]; return v != null ? s + v * r.current_value : s }, 0)
                    const tw = filteredReturns.filter(r => r.returns[p] != null).reduce((s, r) => s + r.current_value, 0)
                    const avg = tw > 0 ? weighted / tw : null
                    return <td key={p} className={`px-3 py-2.5 text-right font-bold ${pctClass(avg)}`}>{fmtPct(avg)}</td>
                  })}
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      {/* end PDF-capture region */}
      </div>

    </div>
  )
}

export default function Performance() {
  const [tab, setTab] = useState<PageTab>('performance')

  return (
    <div className="space-y-4">
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-1">
          {(['performance', 'reports'] as PageTab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors ${
                tab === t
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t === 'performance' ? 'Returns' : 'Reports'}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'performance' && <PerformanceInner />}
      {tab === 'reports'     && <Reports />}
    </div>
  )
}
