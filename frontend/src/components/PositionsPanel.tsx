import { useState, useMemo, Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getConsolidatedPositions } from '../api/client'
import type { ConsolidatedPosition, CashBalance } from '../api/client'
import {
  ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown,
  TrendingUp, TrendingDown,
} from 'lucide-react'
import { formatOptionTicker } from '../utils/optionFormat'
import SecurityDetailPanel from './SecurityDetailPanel'

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtCAD(val: string | number | null | undefined) {
  if (val === null || val === undefined || val === '') return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n)
}

function fmtCAD0(val: number) {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(val)
}

function fmtUSD(val: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(val)
}

/** Derive USD market value from CAD market value using the price ratio. Works for options too. */
function usdMarketValue(pos: ConsolidatedPosition): number | null {
  if (pos.price_currency !== 'USD') return null
  const mkt     = parseFloat(pos.market_value_cad ?? '')
  const priceCad = parseFloat(pos.current_price_cad ?? '')
  const priceUsd = parseFloat(pos.current_price ?? '')
  if (isNaN(mkt) || isNaN(priceCad) || isNaN(priceUsd) || priceCad === 0) return null
  return mkt * priceUsd / priceCad
}

function fmtQty(val: string | number | null | undefined) {
  if (!val) return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  return n.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
}

function fmtPct(val: string | null | undefined) {
  if (!val) return null
  const n = parseFloat(val)
  if (isNaN(n)) return null
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

function pnlClass(val: string | number | null | undefined) {
  const n = typeof val === 'string' ? parseFloat(val) : (val ?? 0)
  if ((n as number) > 0) return 'text-emerald-600'
  if ((n as number) < 0) return 'text-red-500'
  return 'text-gray-500'
}

// ─── Colours ─────────────────────────────────────────────────────────────────

const ACCOUNT_TYPE_COLORS: Record<string, string> = {
  RRSP: 'bg-blue-100 text-blue-700',
  TFSA: 'bg-green-100 text-green-700',
  RESP: 'bg-yellow-100 text-yellow-700',
  NON_REG: 'bg-gray-100 text-gray-600',
  '401K': 'bg-purple-100 text-purple-700',
  IRA: 'bg-indigo-100 text-indigo-700',
  ROTH: 'bg-pink-100 text-pink-700',
}
const ASSET_CLASS_COLORS: Record<string, string> = {
  EQUITY: 'bg-blue-50 text-blue-700',
  ETF: 'bg-indigo-50 text-indigo-700',
  OPTION: 'bg-purple-50 text-purple-700',
  FIXED_INCOME: 'bg-green-50 text-green-700',
  CASH: 'bg-gray-50 text-gray-600',
}

// ─── PnL Badge ───────────────────────────────────────────────────────────────

function PnlBadge({ pnl, pct }: { pnl: string | null | undefined; pct: string | null | undefined }) {
  if (!pnl) return <span className="text-gray-300 text-xs">—</span>
  const n = parseFloat(pnl)
  const isPos = n >= 0
  const pctStr = fmtPct(pct)
  return (
    <div className={`flex items-center gap-0.5 justify-end ${isPos ? 'text-emerald-600' : 'text-red-500'}`}>
      {isPos ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      <span className="font-medium text-xs">{fmtCAD(pnl)}</span>
      {pctStr && <span className="text-xs opacity-75">({pctStr})</span>}
    </div>
  )
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc'

function sortRows<T>(rows: T[], col: string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const rawA = (a as Record<string, unknown>)[col] ?? ''
    const rawB = (b as Record<string, unknown>)[col] ?? ''
    const numA = parseFloat(String(rawA))
    const numB = parseFloat(String(rawB))
    // Use numeric comparison when both values are numbers (handles negatives correctly).
    // Fall back to locale-aware string compare for text columns (ticker, name, etc.).
    const cmp = (!isNaN(numA) && !isNaN(numB))
      ? numA - numB
      : String(rawA).localeCompare(String(rawB), undefined, { sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

// ─── Column definitions ──────────────────────────────────────────────────────
// The desktop table is data-driven: a single ordered list of column ids drives
// the header, body, breakdown, subtotal and totals rows. Users can drag column
// headers to reorder, and the order is persisted to localStorage.

const COL_ORDER_KEY = 'holdings-col-order'
const DEFAULT_COL_ORDER = [
  'ticker', 'asset_class', 'total_quantity', 'acb_per_share_cad', 'total_acb_cad',
  'current_price_cad', 'market_value_cad', 'day_gain_cad', 'day_change_pct',
  'unrealized_pnl_cad', 'unrealized_pnl_pct',
]

/** Load the saved column order, dropping unknown ids and appending any new columns (forward-compatible). */
function loadColOrder(): string[] {
  try {
    const raw = localStorage.getItem(COL_ORDER_KEY)
    if (!raw) return DEFAULT_COL_ORDER
    const saved = JSON.parse(raw)
    if (!Array.isArray(saved)) return DEFAULT_COL_ORDER
    const known = saved.filter((c: unknown): c is string => typeof c === 'string' && DEFAULT_COL_ORDER.includes(c))
    const missing = DEFAULT_COL_ORDER.filter(c => !known.includes(c))
    return [...known, ...missing]
  } catch {
    return DEFAULT_COL_ORDER
  }
}

type AcctPos = ConsolidatedPosition['accounts'][number]
/** Aggregates for subtotal / group-header / totals rows. `mkt` is the value to show
 *  in the Mkt-Value column; `mktForPct` is the base for the day-gain percentage. */
type SummaryCtx = { cost: number; mkt: number; mktForPct: number; pnl: number; day: number; hasDay: boolean; fallback: number }
interface ColDef {
  col: string
  label: string
  right: boolean
  nowrap?: boolean
  tdClass?: string
  cell: (pos: ConsolidatedPosition) => React.ReactNode
  summary?: (c: SummaryCtx) => React.ReactNode
  acct?: (a: AcctPos) => React.ReactNode
}

// ─── Main component ───────────────────────────────────────────────────────────

interface PositionsPanelProps {
  /** Comma-separated account IDs, undefined for all accounts, null while account list is loading */
  accountIds: string | null | undefined
  /** Already-filtered cash balances from the parent */
  cash: CashBalance[]
  /** Historical date (YYYY-MM-DD); omit for current positions */
  asOf?: string
}

export default function PositionsPanel({ accountIds, cash, asOf }: PositionsPanelProps) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(new Set())
  const [cashExpanded, setCashExpanded] = useState(false)
  const [sortCol, setSortCol] = useState('total_acb_cad')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [selectedPosition, setSelectedPosition] = useState<ConsolidatedPosition | null>(null)
  const [groupByClass, setGroupByClass] = useState(false)
  const [collapsedClasses, setCollapsedClasses] = useState<Set<string>>(new Set())
  const toggleClass = (k: string) =>
    setCollapsedClasses(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })

  // Column order (drag-to-reorder, persisted). dragCol = the column being dragged;
  // dragOverCol = the header currently hovered as the drop target.
  const [colOrder, setColOrder] = useState<string[]>(loadColOrder)
  const [dragCol, setDragCol] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<string | null>(null)
  const persistOrder = (order: string[]) => {
    setColOrder(order)
    try { localStorage.setItem(COL_ORDER_KEY, JSON.stringify(order)) } catch { /* ignore */ }
  }
  const dropColumn = (target: string) => {
    if (dragCol && dragCol !== target) {
      const next = colOrder.filter(c => c !== dragCol)
      next.splice(next.indexOf(target), 0, dragCol)   // insert dragged col before the drop target
      persistOrder(next)
    }
    setDragCol(null); setDragOverCol(null)
  }
  const isCustomOrder = colOrder.join(',') !== DEFAULT_COL_ORDER.join(',')

  const handleTickerClick = (pos: ConsolidatedPosition, e: React.MouseEvent) => {
    e.stopPropagation()
    // On mobile (< md = 768px) navigate to full-page detail; on desktop open slide-over
    if (pos.security_id && window.innerWidth < 768) {
      navigate(`/holdings/security/${pos.security_id}`)
    } else {
      setSelectedPosition(pos)
    }
  }

  const { data: consolidated = [], isLoading } = useQuery({
    queryKey: ['consolidated-positions', accountIds, asOf],
    queryFn: () => getConsolidatedPositions({ account_ids: accountIds ?? undefined, as_of: asOf }),
    // null means "accounts still loading with active filter" — wait before querying
    enabled: accountIds !== null,
  })

  const toggleTicker = (ticker: string) =>
    setExpandedTickers(prev => {
      const next = new Set(prev)
      if (next.has(ticker)) next.delete(ticker); else next.add(ticker)
      return next
    })

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  // Summary metrics — mirror Dashboard's fallback: when no live price exists,
  // use book value (total_acb_cad) so the totals stay consistent across pages.
  const totalACB = (consolidated as ConsolidatedPosition[]).reduce((s, p) => s + parseFloat(p.total_acb_cad || '0'), 0)
  const { totalMkt, totalPnl, fallbackCount, totalDayGain, hasDayGain } = useMemo(() => {
    let mkt = 0, pnl = 0, fallback = 0, dayGain = 0, hasDay = false
    for (const p of (consolidated as ConsolidatedPosition[])) {
      const bv = parseFloat(p.total_acb_cad || '0')
      if (p.market_value_cad) {
        const mv = parseFloat(p.market_value_cad)
        mkt += mv
        pnl += mv - bv
      } else {
        mkt += bv   // fallback: value at cost (same as Dashboard)
        fallback++
      }
      if (p.day_gain_cad) { dayGain += parseFloat(p.day_gain_cad); hasDay = true }
    }
    return { totalMkt: mkt, totalPnl: pnl, fallbackCount: fallback, totalDayGain: dayGain, hasDayGain: hasDay }
  }, [consolidated])
  const totalCash = cash.reduce((s, c) => s + parseFloat(c.balance_cad || '0'), 0)
  const hasPrices = (consolidated as ConsolidatedPosition[]).some(p => p.market_value_cad)
  const totalVal  = totalMkt + totalCash

  const sorted = useMemo(
    () => sortRows(consolidated as ConsolidatedPosition[], sortCol, sortDir),
    [consolidated, sortCol, sortDir],
  )

  // Optionally group the (already-sorted) rows by asset class, each group
  // carrying its own subtotals. When grouping is off, everything sits in a
  // single unlabelled group so the render path stays the same.
  const groups = useMemo(() => {
    const summarize = (key: string, positions: ConsolidatedPosition[]) => {
      let mkt = 0, pnl = 0, day = 0, cost = 0, hasDay = false
      for (const p of positions) {
        cost += parseFloat(p.total_acb_cad || '0')
        mkt += p.market_value_cad ? parseFloat(p.market_value_cad) : parseFloat(p.total_acb_cad || '0')
        if (p.unrealized_pnl_cad) pnl += parseFloat(p.unrealized_pnl_cad)
        if (p.day_gain_cad) { day += parseFloat(p.day_gain_cad); hasDay = true }
      }
      return { key, positions, mkt, pnl, day, cost, hasDay }
    }
    if (!groupByClass) return [summarize('', sorted)]
    const m = new Map<string, ConsolidatedPosition[]>()
    for (const p of sorted) {
      const k = p.asset_class || 'OTHER'
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(p)
    }
    return [...m.entries()].map(([k, ps]) => summarize(k, ps))
  }, [sorted, groupByClass])

  // All values shown in CAD. USD securities show native price/value as a subscript.
  // Each column carries its own renderers: cell (position row), summary (subtotal/
  // group/totals rows) and acct (per-account breakdown row).
  const COLUMNS: Record<string, ColDef> = {
    ticker: {
      col: 'ticker', label: 'Ticker / Name', right: false, nowrap: true,
      cell: pos => {
        // Proprietary funds have no public symbol (ticker is a synthetic 'PLAID:…');
        // show the fund name as the primary label instead of the opaque id.
        const synthetic = pos.ticker.includes(':')
        const primary = synthetic
          ? (pos.security_name || 'Fund')
          : (pos.asset_class === 'OPTION' ? formatOptionTicker(pos.ticker) : pos.ticker)
        return (
          <>
            <span
              className="font-mono font-semibold text-blue-700 hover:underline cursor-pointer"
              onClick={e => handleTickerClick(pos, e)}
            >
              {primary}
            </span>
            {!synthetic && pos.asset_class !== 'OPTION' && pos.security_name && (
              <span className="ml-2 text-xs text-gray-500">{pos.security_name}</span>
            )}
          </>
        )
      },
      acct: a => (
        <>
          <span className={`px-1.5 py-0.5 rounded text-xs mr-1.5 ${ACCOUNT_TYPE_COLORS[a.account_type] || 'bg-gray-100 text-gray-600'}`}>
            {a.account_type}
          </span>
          {a.account_name}
        </>
      ),
    },
    asset_class: {
      col: 'asset_class', label: 'Class', right: false, nowrap: true,
      cell: pos => (
        <>
          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${ASSET_CLASS_COLORS[pos.asset_class] || 'bg-gray-50 text-gray-600'}`}>
            {pos.asset_class}
          </span>
          {pos.exchange && <span className="ml-1.5 text-xs text-gray-400">{pos.exchange}</span>}
        </>
      ),
    },
    total_quantity: {
      col: 'total_quantity', label: 'Qty', right: true,
      cell: pos => fmtQty(pos.total_quantity),
      acct: a => fmtQty(a.quantity),
    },
    acb_per_share_cad: {
      col: 'acb_per_share_cad', label: 'ACB/Share (CAD)', right: true, tdClass: 'text-gray-600',
      cell: pos => {
        const cadAcb = parseFloat(pos.acb_per_share_cad || '0')
        const isUSD = pos.price_currency === 'USD'
        const usdAcb = (isUSD && pos.current_price_cad && pos.current_price)
          ? cadAcb * parseFloat(pos.current_price) / parseFloat(pos.current_price_cad)
          : null
        return (
          <div>
            <div>{fmtCAD(pos.acb_per_share_cad)}</div>
            {usdAcb !== null && <div className="text-xs text-gray-400 leading-none">US{fmtUSD(usdAcb)}</div>}
          </div>
        )
      },
    },
    total_acb_cad: {
      col: 'total_acb_cad', label: 'Total Cost (CAD)', right: true, tdClass: 'font-semibold',
      cell: pos => fmtCAD(pos.total_acb_cad),
      acct: a => fmtCAD(a.total_acb_cad),
      summary: c => fmtCAD(c.cost),
    },
    current_price_cad: {
      col: 'current_price_cad', label: 'Price (CAD)', right: true, nowrap: true,
      cell: pos => pos.current_price_cad ? (
        <div>
          <div className="font-semibold flex items-center justify-end gap-1">
            {fmtCAD(pos.current_price_cad)}
            {pos.day_change_pct && (
              <span className={`text-xs ${pnlClass(pos.day_change_pct)}`}>{fmtPct(pos.day_change_pct)}</span>
            )}
          </div>
          {pos.price_currency === 'USD' && pos.current_price && (
            <div className="text-xs text-gray-400 leading-none">US{fmtUSD(parseFloat(pos.current_price))}</div>
          )}
        </div>
      ) : <span className="text-gray-300">—</span>,
    },
    market_value_cad: {
      col: 'market_value_cad', label: 'Mkt Value (CAD)', right: true, tdClass: 'font-semibold',
      cell: pos => pos.market_value_cad ? (
        <div>
          <div>{fmtCAD(pos.market_value_cad)}</div>
          {pos.price_currency === 'USD' && (() => {
            const usd = usdMarketValue(pos)
            return usd !== null ? (
              <div className="text-xs text-gray-400 font-normal leading-none">US{fmtUSD(usd)}</div>
            ) : null
          })()}
        </div>
      ) : (
        <span className="text-amber-600" title="Valued at cost — no market price available">
          {fmtCAD(pos.total_acb_cad)}<span className="text-amber-400 ml-0.5">*</span>
        </span>
      ),
      summary: c => (
        <>
          {fmtCAD(c.mkt)}
          {c.fallback > 0 && <span className="text-amber-400 ml-0.5">*</span>}
        </>
      ),
    },
    day_gain_cad: {
      col: 'day_gain_cad', label: 'Day Gain ($)', right: true,
      cell: pos => pos.day_gain_cad
        ? <span className={`font-medium ${pnlClass(pos.day_gain_cad)}`}>{fmtCAD(pos.day_gain_cad)}</span>
        : '—',
      summary: c => c.hasDay ? <span className={pnlClass(c.day)}>{fmtCAD(c.day)}</span> : null,
    },
    day_change_pct: {
      col: 'day_change_pct', label: 'Day Gain (%)', right: true,
      cell: pos => pos.day_change_pct
        ? <span className={`font-medium ${pnlClass(pos.day_change_pct)}`}>{fmtPct(pos.day_change_pct)}</span>
        : '—',
      summary: c => (c.hasDay && c.mktForPct > 0)
        ? <span className={pnlClass(c.day)}>{fmtPct(String((c.day / c.mktForPct) * 100))}</span>
        : null,
    },
    unrealized_pnl_cad: {
      col: 'unrealized_pnl_cad', label: 'P&L ($)', right: true,
      cell: pos => pos.unrealized_pnl_cad
        ? <span className={`font-medium ${pnlClass(pos.unrealized_pnl_cad)}`}>{fmtCAD(pos.unrealized_pnl_cad)}</span>
        : <span className="text-gray-300">—</span>,
      summary: c => <span className={pnlClass(c.pnl)}>{fmtCAD(c.pnl)}</span>,
    },
    unrealized_pnl_pct: {
      col: 'unrealized_pnl_pct', label: 'P&L (%)', right: true,
      cell: pos => pos.unrealized_pnl_pct
        ? <span className={`font-medium ${pnlClass(pos.unrealized_pnl_pct)}`}>{fmtPct(pos.unrealized_pnl_pct)}</span>
        : <span className="text-gray-300">—</span>,
      summary: c => c.cost > 0
        ? <span className={pnlClass(c.pnl)}>{fmtPct(String((c.pnl / c.cost) * 100))}</span>
        : null,
    },
  }

  // The ordered, resolved column list that drives every desktop row.
  const orderedCols = colOrder.map(id => COLUMNS[id]).filter(Boolean) as ColDef[]
  const sortableCols = orderedCols.filter(c => c.col !== 'asset_class')

  const tdClassFor = (c: ColDef) =>
    `px-4 py-2.5 ${c.right ? 'text-right' : ''} ${c.nowrap ? 'whitespace-nowrap' : ''} ${c.tdClass ?? ''}`

  // Subtotal / group-header / totals numeric cells. `lead` fills the Ticker column.
  const summaryCells = (ctx: SummaryCtx, lead: React.ReactNode) =>
    orderedCols.map(c => (
      <td key={c.col} className={`px-4 py-2 ${c.right ? 'text-right' : ''}`}>
        {c.col === 'ticker' ? lead : (c.summary ? c.summary(ctx) : null)}
      </td>
    ))

  const exportCsv = () => {
    const headers = ['Ticker', 'Name', 'Currency', 'Total Qty',
      'ACB/Share (CAD)', 'ACB/Share (Native)', 'Total ACB (CAD)',
      'Price (CAD)', 'Price (Native)', 'Mkt Value (CAD)', 'Mkt Value (Native)',
      'P&L ($)', 'P&L (%)']
    const rows = (consolidated as ConsolidatedPosition[]).map(p => {
      const usd = usdMarketValue(p)
      const isUSD = p.price_currency === 'USD'
      const usdRate = (isUSD && p.current_price_cad && p.current_price)
        ? parseFloat(p.current_price_cad) / parseFloat(p.current_price)
        : null
      const acbShareNative = (isUSD && usdRate && p.acb_per_share_cad)
        ? (parseFloat(p.acb_per_share_cad) / usdRate).toFixed(4)
        : ''
      return [
        p.ticker, p.security_name ?? '', p.currency ?? '', p.total_quantity,
        p.acb_per_share_cad, acbShareNative,
        p.total_acb_cad,
        p.current_price_cad ?? '',
        isUSD && p.current_price ? `US$${parseFloat(p.current_price).toFixed(2)}` : '',
        p.market_value_cad ?? '',
        usd !== null ? `US$${usd.toFixed(2)}` : '',
        p.unrealized_pnl_cad ?? '', p.unrealized_pnl_pct ?? '',
      ]
    })
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.href = url
    a.download = `holdings_${new Date().toISOString().slice(0, 10)}.csv`
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 100)
  }

  function SortIcon({ col }: { col: string }) {
    if (sortCol !== col) return <ChevronsUpDown className="h-3 w-3 opacity-30 flex-shrink-0" />
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-blue-600 flex-shrink-0" />
      : <ChevronDown className="h-3 w-3 text-blue-600 flex-shrink-0" />
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">

      {/* ── Collapsible header ── */}
      <div
        className="px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 select-none"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Chevron + title */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {expanded
            ? <ChevronDown className="h-4 w-4 text-gray-400" />
            : <ChevronRight className="h-4 w-4 text-gray-400" />}
          <h2 className="font-semibold text-gray-800">Holdings</h2>
          {!isLoading && (
            <span className="text-xs text-gray-400">
              {(consolidated as ConsolidatedPosition[]).length} securities
            </span>
          )}
        </div>

        {/* Summary metrics */}
        {isLoading ? (
          <span className="text-xs text-gray-400 ml-2">Loading…</span>
        ) : (
          <div className="flex items-center gap-x-5 gap-y-1 flex-wrap ml-1">
            {/* Book / Securities / Cash — desktop only (redundant with Total on mobile) */}
            <div className="hidden md:block text-sm">
              <span className="text-xs text-gray-400 mr-1">Book</span>
              <span className="font-semibold text-gray-700">{fmtCAD0(totalACB)}</span>
            </div>
            {hasPrices && (
              <div className="hidden md:block text-sm">
                <span className="text-xs text-gray-400 mr-1">Securities</span>
                <span className="font-semibold text-gray-700">{fmtCAD0(totalMkt)}</span>
                {fallbackCount > 0 && (
                  <span className="text-amber-500 ml-0.5" title={`${fallbackCount} position(s) valued at cost — no market price available`}>*</span>
                )}
              </div>
            )}
            <div className="hidden md:block text-sm">
              <span className="text-xs text-gray-400 mr-1">Cash</span>
              <span className={`font-semibold ${totalCash < 0 ? 'text-red-500' : 'text-gray-700'}`}>
                {fmtCAD0(totalCash)}
              </span>
            </div>
            {hasPrices && (
              <>
                <div className="text-sm md:border-l md:border-gray-200 md:pl-5">
                  <span className="text-xs text-gray-400 mr-1">Total</span>
                  <span className="font-bold text-gray-900">{fmtCAD0(totalVal)}</span>
                </div>
                <div className={`text-sm flex items-center gap-1 ${pnlClass(totalPnl)}`}>
                  {totalPnl >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                  <span className="font-semibold">{fmtCAD0(totalPnl)}</span>
                  {totalACB !== 0 && <span className="text-xs">({totalPnl >= 0 ? '+' : ''}{(totalPnl / Math.abs(totalACB) * 100).toFixed(1)}%)</span>}
                </div>
              </>
            )}
          </div>
        )}

        {/* Group-by-class toggle + Export CSV — only when expanded; stop propagation so they don't toggle the panel */}
        {expanded && !isLoading && (
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            {isCustomOrder && (
              <button
                onClick={e => { e.stopPropagation(); persistOrder(DEFAULT_COL_ORDER) }}
                className="hidden md:block text-xs border border-gray-200 rounded px-3 py-1 bg-white text-gray-500 hover:bg-gray-50"
                title="Reset column order to default"
              >
                Reset columns
              </button>
            )}
            <button
              onClick={e => { e.stopPropagation(); setGroupByClass(g => !g) }}
              className={`hidden md:block text-xs border rounded px-3 py-1 ${groupByClass ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              title="Group holdings by asset class with subtotals"
            >
              Group by Class
            </button>
            <button
              onClick={e => { e.stopPropagation(); exportCsv() }}
              className="text-xs bg-white border border-gray-200 rounded px-3 py-1 hover:bg-gray-50"
            >
              Export CSV
            </button>
          </div>
        )}
      </div>

      {/* ── Expanded table ── */}
      {expanded && (
        <div className="border-t border-gray-100">
          {isLoading ? (
            <div className="flex items-center justify-center h-24">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
            </div>
          ) : (consolidated as ConsolidatedPosition[]).length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">No positions found.</div>
          ) : (
            <>
            {/* ── Mobile: sort control ── */}
            <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50/40">
              <span className="text-xs text-gray-400">Sort</span>
              <select
                value={sortCol}
                onChange={e => setSortCol(e.target.value)}
                className="flex-1 text-sm border border-gray-200 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                {sortableCols.map(c => (
                  <option key={c.col} value={c.col}>{c.label}</option>
                ))}
              </select>
              <button
                onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                className="text-sm border border-gray-200 rounded px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50"
                title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
              <button
                onClick={() => setGroupByClass(g => !g)}
                className={`text-sm border rounded px-3 py-1.5 ${groupByClass ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                title="Group by asset class"
              >
                Group
              </button>
            </div>

            {/* ── Mobile card list ── */}
            <div className="md:hidden">
              {groups.map(group => {
                const collapsed = collapsedClasses.has(group.key)
                return (
                  <div key={group.key || 'all'}>
                    {groupByClass && group.key && (
                      <div
                        className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 cursor-pointer select-none"
                        onClick={() => toggleClass(group.key)}
                      >
                        {collapsed
                          ? <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                          : <ChevronDown className="h-3.5 w-3.5 text-gray-400" />}
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ASSET_CLASS_COLORS[group.key] || 'bg-gray-100 text-gray-600'}`}>{group.key}</span>
                        <span className="text-xs text-gray-400">{group.positions.length}</span>
                        <span className="ml-auto text-sm font-semibold text-gray-800">{fmtCAD(group.mkt)}</span>
                        {group.pnl !== 0 && (
                          <span className={`text-xs font-medium ${group.pnl >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {group.pnl >= 0 ? '+' : ''}{fmtCAD(group.pnl)}
                          </span>
                        )}
                      </div>
                    )}
                    {!collapsed && (
                      <div className="divide-y divide-gray-100">
                        {group.positions.map(pos => {
                const mktVal  = pos.market_value_cad ? parseFloat(pos.market_value_cad) : null
                const pnl     = pos.unrealized_pnl_cad ? parseFloat(pos.unrealized_pnl_cad) : null
                const pnlPct  = pos.unrealized_pnl_pct ? parseFloat(pos.unrealized_pnl_pct) : null
                const dayChg  = pos.day_change_pct ? parseFloat(pos.day_change_pct) : null
                const qty     = parseFloat(pos.total_quantity || '0')
                return (
                  <div
                    key={pos.ticker}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 active:bg-gray-100 cursor-pointer"
                    onClick={() => pos.security_id && handleTickerClick(pos, { stopPropagation: () => {} } as React.MouseEvent)}
                  >
                    {/* Left: ticker + name */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-semibold text-blue-700 text-sm truncate">
                          {pos.ticker.includes(':')
                            ? (pos.security_name || 'Fund')
                            : (pos.asset_class === 'OPTION' ? formatOptionTicker(pos.ticker) : pos.ticker)}
                        </span>
                        <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${ASSET_CLASS_COLORS[pos.asset_class] || 'bg-gray-50 text-gray-500'}`}>
                          {pos.asset_class}
                        </span>
                      </div>
                      <div className="text-xs text-gray-400 truncate mt-0.5">
                        {pos.security_name ?? pos.exchange ?? ''}
                        {qty !== 0 && <span className="ml-1">· {qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)} shares</span>}
                      </div>
                    </div>

                    {/* Right: value + P&L */}
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-semibold text-gray-900">
                        {mktVal != null ? fmtCAD(mktVal) : '—'}
                      </div>
                      <div className={`text-xs font-medium ${pnl != null ? (pnl >= 0 ? 'text-emerald-600' : 'text-red-500') : 'text-gray-400'}`}>
                        {pnl != null ? (pnl >= 0 ? '+' : '') + fmtCAD(pnl) : '—'}
                        {pnlPct != null && <span className="ml-1 text-[10px]">({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)</span>}
                      </div>
                      {dayChg != null && (
                        <div className={`text-[10px] ${dayChg >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                          {dayChg >= 0 ? '▲' : '▼'} {Math.abs(dayChg).toFixed(2)}% today
                        </div>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-300 flex-shrink-0" />
                  </div>
                )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ── Desktop table ── */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full text-sm divide-y divide-gray-100">
                <thead className="bg-gray-50">
                  <tr className="text-xs text-gray-500 uppercase">
                    {/* Expand chevron spacer */}
                    <th className="w-8 px-4 py-2.5" />
                    {orderedCols.map(c => (
                      <th
                        key={c.col}
                        draggable
                        onDragStart={() => setDragCol(c.col)}
                        onDragOver={e => { e.preventDefault(); if (dragOverCol !== c.col) setDragOverCol(c.col) }}
                        onDragLeave={() => setDragOverCol(o => (o === c.col ? null : o))}
                        onDrop={() => dropColumn(c.col)}
                        onDragEnd={() => { setDragCol(null); setDragOverCol(null) }}
                        onClick={() => toggleSort(c.col)}
                        title="Drag to reorder · click to sort"
                        className={`px-4 py-2.5 cursor-move hover:bg-gray-100 select-none ${c.right ? 'text-right' : 'text-left'} ${dragCol === c.col ? 'opacity-40' : ''} ${dragOverCol === c.col && dragCol && dragCol !== c.col ? 'border-l-2 border-blue-400' : ''}`}
                      >
                        <div className={`flex items-center gap-1 ${c.right ? 'justify-end' : ''}`}>
                          {c.label}
                          <SortIcon col={c.col} />
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-100 bg-white">
                  {groups.map(group => {
                    const groupCollapsed = collapsedClasses.has(group.key)
                    return (
                      <Fragment key={group.key || 'all'}>
                        {groupByClass && group.key && (
                          <tr
                            className="bg-gray-50/80 border-t border-gray-200 cursor-pointer select-none hover:bg-gray-100 font-semibold text-sm"
                            onClick={() => toggleClass(group.key)}
                          >
                            <td className="w-8 px-4 py-2 text-gray-400">
                              {groupCollapsed
                                ? <ChevronRight className="h-4 w-4" />
                                : <ChevronDown className="h-4 w-4" />}
                            </td>
                            {summaryCells(
                              { cost: group.cost, mkt: group.mkt, mktForPct: group.mkt, pnl: group.pnl, day: group.day, hasDay: group.hasDay, fallback: 0 },
                              <>
                                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${ASSET_CLASS_COLORS[group.key] || 'bg-gray-100 text-gray-600'}`}>{group.key}</span>
                                <span className="ml-2 text-xs font-normal text-gray-400">{group.positions.length} position{group.positions.length !== 1 ? 's' : ''}</span>
                              </>,
                            )}
                          </tr>
                        )}
                        {!groupCollapsed && group.positions.map(pos => {
                          const isExp = expandedTickers.has(pos.ticker)
                          const canExpand = pos.account_count > 1
                          return (
                            <Fragment key={pos.ticker}>
                              <tr
                                className={`hover:bg-gray-50 ${canExpand ? 'cursor-pointer' : ''}`}
                                onClick={() => canExpand && toggleTicker(pos.ticker)}
                              >
                                {/* Expand chevron (fixed leading column) */}
                                <td className="w-8 px-4 py-2.5 text-gray-400">
                                  {canExpand
                                    ? isExp
                                      ? <ChevronDown className="h-4 w-4" />
                                      : <ChevronRight className="h-4 w-4" />
                                    : null}
                                </td>
                                {orderedCols.map(c => (
                                  <td key={c.col} className={tdClassFor(c)}>{c.cell(pos)}</td>
                                ))}
                              </tr>

                              {/* Per-account breakdown rows */}
                              {isExp && pos.accounts.map(acct => (
                                <tr key={`${pos.ticker}-${acct.account_id}`} className="bg-blue-50/40">
                                  <td className="w-8 px-4 py-1.5" />
                                  {orderedCols.map(c => (
                                    <td
                                      key={c.col}
                                      className={`px-4 py-1.5 text-xs text-gray-500 ${c.right ? 'text-right' : ''} ${c.col === 'ticker' ? 'pl-10 whitespace-nowrap' : ''}`}
                                    >
                                      {c.acct ? c.acct(acct) : null}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </Fragment>
                          )
                        })}
                      </Fragment>
                    )
                  })}
                </tbody>

                {/* Securities subtotal row — sits between the last security and cash */}
                {cash.length > 0 && hasPrices && (
                  <tbody>
                    <tr className="bg-gray-50 border-t-2 border-gray-200 font-semibold text-sm">
                      <td className="w-8 px-4 py-2" />
                      {summaryCells(
                        { cost: totalACB, mkt: totalMkt, mktForPct: totalMkt, pnl: totalPnl, day: totalDayGain, hasDay: hasDayGain, fallback: fallbackCount },
                        <span className="text-gray-500 text-xs uppercase tracking-wide">Securities subtotal</span>,
                      )}
                    </tr>
                  </tbody>
                )}

                {/* Cash rows — collapsed by default, expandable per account */}
                {cash.length > 0 && (
                  <tbody className="divide-y divide-green-50/80">
                    {/* Collapsible header row */}
                    <tr
                      className="bg-green-50/60 hover:bg-green-50 cursor-pointer select-none"
                      onClick={() => setCashExpanded(e => !e)}
                    >
                      <td className="w-8 px-4 py-2.5 text-green-600">
                        {cashExpanded
                          ? <ChevronDown className="h-4 w-4" />
                          : <ChevronRight className="h-4 w-4" />}
                      </td>
                      {orderedCols.map(c => (
                        <td key={c.col} className={`px-4 py-2.5 ${c.right ? 'text-right' : ''} ${c.col === 'ticker' ? 'whitespace-nowrap' : ''}`}>
                          {c.col === 'ticker' ? (
                            <>
                              <span className="font-mono font-semibold text-green-700">CASH</span>
                              <span className="ml-2 text-xs text-gray-400">
                                {cash.length} account{cash.length !== 1 ? 's' : ''}
                                {!cashExpanded && ' — click to expand'}
                              </span>
                            </>
                          ) : c.col === 'asset_class' ? (
                            <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">CASH</span>
                          ) : c.col === 'market_value_cad' ? (
                            <span className="font-semibold text-green-700">{fmtCAD(totalCash)}</span>
                          ) : null}
                        </td>
                      ))}
                    </tr>

                    {/* Per-account cash rows, shown only when expanded */}
                    {cashExpanded && cash.map(cc => (
                      <tr key={`${cc.account_id}-${cc.currency}`} className="bg-green-50/30 hover:bg-green-50/60">
                        <td className="w-8 px-4 py-2" />
                        {orderedCols.map(c => (
                          <td key={c.col} className={`px-4 py-2 ${c.right ? 'text-right' : ''} ${c.col === 'ticker' ? 'pl-10 whitespace-nowrap' : ''}`}>
                            {c.col === 'ticker' ? (
                              <>
                                <span className="text-xs text-gray-500">{cc.account_name}</span>
                                <span className="ml-1.5 text-xs text-gray-400">· {cc.currency}</span>
                              </>
                            ) : c.col === 'market_value_cad' ? (
                              <>
                                <div className="font-semibold text-green-700">{fmtCAD(cc.balance_cad ?? cc.balance)}</div>
                                {cc.currency === 'USD' && (
                                  <div className="text-xs text-gray-400 font-normal leading-none">US{fmtUSD(parseFloat(cc.balance))}</div>
                                )}
                              </>
                            ) : null}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                )}

                {/* Totals footer */}
                <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                  <tr className="font-semibold text-sm">
                    <td className="w-8 px-4 py-2.5" />
                    {orderedCols.map(c => {
                      const ctx: SummaryCtx = {
                        cost: totalACB, mkt: totalVal, mktForPct: totalMkt,
                        pnl: totalPnl, day: totalDayGain, hasDay: hasDayGain, fallback: fallbackCount,
                      }
                      let content: React.ReactNode = null
                      if (c.col === 'ticker') content = <span className="text-gray-600">Totals</span>
                      else if (c.col === 'market_value_cad') content = hasPrices ? c.summary?.(ctx) : '—'
                      else if (c.col === 'unrealized_pnl_cad') content = hasPrices ? c.summary?.(ctx) : '—'
                      else if (c.col === 'unrealized_pnl_pct') content = (hasPrices && totalACB > 0) ? c.summary?.(ctx) : '—'
                      else if (c.col === 'day_change_pct') content = '—'   // total day % isn't meaningful — not summed
                      else if (c.summary) content = c.summary(ctx)
                      return (
                        <td key={c.col} className={`px-4 py-2.5 ${c.right ? 'text-right' : ''}`}>{content}</td>
                      )
                    })}
                  </tr>
                </tfoot>
              </table>
              {fallbackCount > 0 && (
                <p className="px-4 py-2 text-xs text-amber-600 bg-amber-50 border-t border-amber-100">
                  * {fallbackCount} position{fallbackCount !== 1 ? 's' : ''} valued at cost — no market price available
                </p>
              )}
            </div>
            </>
          )}
        </div>
      )}

      {selectedPosition && (
        <SecurityDetailPanel
          position={selectedPosition}
          allPositions={sorted}
          onClose={() => setSelectedPosition(null)}
        />
      )}
    </div>
  )
}
