import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
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
    const va = String((a as Record<string, unknown>)[col] ?? '')
    const vb = String((b as Record<string, unknown>)[col] ?? '')
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

// ─── Column definitions ──────────────────────────────────────────────────────
// Built dynamically inside the component based on whether any position is USD-priced.

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
  const [expanded, setExpanded] = useState(false)
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(new Set())
  const [cashExpanded, setCashExpanded] = useState(false)
  const [sortCol, setSortCol] = useState('total_acb_cad')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [selectedPosition, setSelectedPosition] = useState<ConsolidatedPosition | null>(null)

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

  // All values shown in CAD. USD securities show native price/value as a subscript.
  const COLUMNS = [
    { label: 'Ticker / Name',    col: 'ticker',             right: false },
    { label: 'Class',            col: 'asset_class',         right: false },
    { label: 'Qty',              col: 'total_quantity',      right: true  },
    { label: 'ACB/Share (CAD)',  col: 'acb_per_share_cad',   right: true  },
    { label: 'Total Cost (CAD)', col: 'total_acb_cad',       right: true  },
    { label: 'Price (CAD)',      col: 'current_price_cad',   right: true  },
    { label: 'Mkt Value (CAD)', col: 'market_value_cad',    right: true  },
    { label: 'P&L ($)',         col: 'unrealized_pnl_cad',  right: true  },
    { label: 'P&L (%)',         col: 'unrealized_pnl_pct',  right: true  },
    { label: 'Day Gain ($)',    col: 'day_gain_cad',         right: true  },
    { label: 'Day Gain (%)',    col: 'day_change_pct',       right: true  },
  ]

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
            <div className="text-sm">
              <span className="text-xs text-gray-400 mr-1">Book</span>
              <span className="font-semibold text-gray-700">{fmtCAD0(totalACB)}</span>
            </div>
            {hasPrices && (
              <div className="text-sm">
                <span className="text-xs text-gray-400 mr-1">Securities</span>
                <span className="font-semibold text-gray-700">{fmtCAD0(totalMkt)}</span>
                {fallbackCount > 0 && (
                  <span className="text-amber-500 ml-0.5" title={`${fallbackCount} position(s) valued at cost — no market price available`}>*</span>
                )}
              </div>
            )}
            <div className="text-sm">
              <span className="text-xs text-gray-400 mr-1">Cash</span>
              <span className={`font-semibold ${totalCash < 0 ? 'text-red-500' : 'text-gray-700'}`}>
                {fmtCAD0(totalCash)}
              </span>
            </div>
            {hasPrices && (
              <>
                <div className="text-sm border-l border-gray-200 pl-5">
                  <span className="text-xs text-gray-400 mr-1">Total</span>
                  <span className="font-bold text-gray-900">{fmtCAD0(totalVal)}</span>
                </div>
                <div className={`text-sm flex items-center gap-1 ${pnlClass(totalPnl)}`}>
                  {totalPnl >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                  <span className="font-semibold">{fmtCAD0(totalPnl)}</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Export CSV — only when expanded; stop propagation so it doesn't toggle panel */}
        {expanded && !isLoading && (
          <button
            onClick={e => { e.stopPropagation(); exportCsv() }}
            className="ml-auto text-xs bg-white border border-gray-200 rounded px-3 py-1 hover:bg-gray-50 flex-shrink-0"
          >
            Export CSV
          </button>
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
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm divide-y divide-gray-100">
                <thead className="bg-gray-50">
                  <tr className="text-xs text-gray-500 uppercase">
                    {/* Expand chevron spacer */}
                    <th className="w-8 px-4 py-2.5" />
                    {COLUMNS.map(({ label, col, right }) => (
                      <th
                        key={col}
                        className={`px-4 py-2.5 cursor-pointer hover:bg-gray-100 select-none ${right ? 'text-right' : 'text-left'}`}
                        onClick={() => toggleSort(col)}
                      >
                        <div className={`flex items-center gap-1 ${right ? 'justify-end' : ''}`}>
                          {label}
                          <SortIcon col={col} />
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-100 bg-white">
                  {sorted.map(pos => {
                    const isExp = expandedTickers.has(pos.ticker)
                    const canExpand = pos.account_count > 1
                    return (
                      <>
                        <tr
                          key={pos.ticker}
                          className={`hover:bg-gray-50 ${canExpand ? 'cursor-pointer' : ''}`}
                          onClick={() => canExpand && toggleTicker(pos.ticker)}
                        >
                          {/* Expand chevron */}
                          <td className="w-8 px-4 py-2.5 text-gray-400">
                            {canExpand
                              ? isExp
                                ? <ChevronDown className="h-4 w-4" />
                                : <ChevronRight className="h-4 w-4" />
                              : null}
                          </td>

                          {/* Ticker / Name */}
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span
                              className="font-mono font-semibold text-blue-700 hover:underline cursor-pointer"
                              onClick={e => { e.stopPropagation(); setSelectedPosition(pos) }}
                            >
                              {pos.asset_class === 'OPTION' ? formatOptionTicker(pos.ticker) : pos.ticker}
                            </span>
                            {pos.asset_class !== 'OPTION' && pos.security_name && (
                              <span className="ml-2 text-xs text-gray-500">{pos.security_name}</span>
                            )}
                          </td>

                          {/* Class / Exchange */}
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${ASSET_CLASS_COLORS[pos.asset_class] || 'bg-gray-50 text-gray-600'}`}>
                              {pos.asset_class}
                            </span>
                            {pos.exchange && (
                              <span className="ml-1.5 text-xs text-gray-400">{pos.exchange}</span>
                            )}
                          </td>

                          {/* Qty */}
                          <td className="px-4 py-2.5 text-right">{fmtQty(pos.total_quantity)}</td>

                          {/* ACB/Share (CAD); USD securities show native USD equivalent as subscript */}
                          <td className="px-4 py-2.5 text-right text-gray-600">
                            {(() => {
                              const cadAcb = parseFloat(pos.acb_per_share_cad || '0')
                              const isUSD = pos.price_currency === 'USD'
                              // Derive USD ACB/share from CAD ACB/share using the current FX rate
                              const usdAcb = (isUSD && pos.current_price_cad && pos.current_price)
                                ? cadAcb * parseFloat(pos.current_price) / parseFloat(pos.current_price_cad)
                                : null
                              return (
                                <div>
                                  <div>{fmtCAD(pos.acb_per_share_cad)}</div>
                                  {usdAcb !== null && (
                                    <div className="text-xs text-gray-400 leading-none">
                                      US{fmtUSD(usdAcb)}
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </td>

                          {/* Total Cost */}
                          <td className="px-4 py-2.5 text-right font-semibold">{fmtCAD(pos.total_acb_cad)}</td>

                          {/* Price (CAD) — always CAD; USD securities show native price as subscript */}
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            {pos.current_price_cad ? (
                              <div>
                                <div className="font-semibold flex items-center justify-end gap-1">
                                  {fmtCAD(pos.current_price_cad)}
                                  {pos.day_change_pct && (
                                    <span className={`text-xs ${pnlClass(pos.day_change_pct)}`}>
                                      {fmtPct(pos.day_change_pct)}
                                    </span>
                                  )}
                                </div>
                                {/* USD native price subscript */}
                                {pos.price_currency === 'USD' && pos.current_price && (
                                  <div className="text-xs text-gray-400 leading-none">
                                    US{fmtUSD(parseFloat(pos.current_price))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>

                          {/* Mkt Value (CAD) — show book value with * when no market price;
                              USD securities show native USD value as subscript */}
                          <td className="px-4 py-2.5 text-right font-semibold">
                            {pos.market_value_cad ? (
                              <div>
                                <div>{fmtCAD(pos.market_value_cad)}</div>
                                {/* USD native market value subscript */}
                                {pos.price_currency === 'USD' && (() => {
                                  const usd = usdMarketValue(pos)
                                  return usd !== null ? (
                                    <div className="text-xs text-gray-400 font-normal leading-none">
                                      US{fmtUSD(usd)}
                                    </div>
                                  ) : null
                                })()}
                              </div>
                            ) : (
                              <span className="text-amber-600" title="Valued at cost — no market price available">
                                {fmtCAD(pos.total_acb_cad)}
                                <span className="text-amber-400 ml-0.5">*</span>
                              </span>
                            )}
                          </td>

                          {/* P&L ($) */}
                          <td className="px-4 py-2.5 text-right">
                            {pos.unrealized_pnl_cad ? (
                              <span className={`font-medium ${pnlClass(pos.unrealized_pnl_cad)}`}>
                                {fmtCAD(pos.unrealized_pnl_cad)}
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>

                          {/* P&L (%) */}
                          <td className="px-4 py-2.5 text-right">
                            {pos.unrealized_pnl_pct ? (
                              <span className={`font-medium ${pnlClass(pos.unrealized_pnl_pct)}`}>
                                {fmtPct(pos.unrealized_pnl_pct)}
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>

                          {/* Day Gain ($) */}
                          <td className="px-3 py-2 text-right">
                            {pos.day_gain_cad ? (
                              <span className={`font-medium ${pnlClass(pos.day_gain_cad)}`}>
                                {fmtCAD(pos.day_gain_cad)}
                              </span>
                            ) : '—'}
                          </td>

                          {/* Day Gain (%) */}
                          <td className="px-3 py-2 text-right">
                            {pos.day_change_pct ? (
                              <span className={`font-medium ${pnlClass(pos.day_change_pct)}`}>
                                {fmtPct(pos.day_change_pct)}
                              </span>
                            ) : '—'}
                          </td>
                        </tr>

                        {/* Per-account breakdown rows */}
                        {isExp && pos.accounts.map(acct => (
                          <tr key={`${pos.ticker}-${acct.account_id}`} className="bg-blue-50/40">
                            <td className="w-8 px-4 py-1.5" />
                            <td className="px-4 py-1.5 pl-10 text-xs text-gray-500" colSpan={2}>
                              <span className={`px-1.5 py-0.5 rounded text-xs mr-1.5 ${ACCOUNT_TYPE_COLORS[acct.account_type] || 'bg-gray-100 text-gray-600'}`}>
                                {acct.account_type}
                              </span>
                              {acct.account_name}
                            </td>
                            <td className="px-4 py-1.5 text-right text-xs text-gray-500">{fmtQty(acct.quantity)}</td>
                            <td />
                            <td className="px-4 py-1.5 text-right text-xs text-gray-500">{fmtCAD(acct.total_acb_cad)}</td>
                            <td colSpan={6} />
                          </tr>
                        ))}
                      </>
                    )
                  })}
                </tbody>

                {/* Securities subtotal row — sits between the last security and cash */}
                {cash.length > 0 && hasPrices && (
                  <tbody>
                    <tr className="bg-gray-50 border-t-2 border-gray-200 font-semibold text-sm">
                      <td colSpan={2} className="px-4 py-2 text-gray-500 text-xs uppercase tracking-wide">
                        Securities subtotal
                      </td>
                      <td colSpan={3} />
                      <td className="px-4 py-2 text-right">{fmtCAD(totalACB)}</td>
                      <td />
                      <td className="px-4 py-2 text-right">
                        {fmtCAD(totalMkt)}
                        {fallbackCount > 0 && <span className="text-amber-400 ml-0.5">*</span>}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className={pnlClass(totalPnl)}>{fmtCAD(totalPnl)}</span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {totalACB > 0 && (
                          <span className={pnlClass(totalPnl)}>
                            {fmtPct(String((totalPnl / totalACB) * 100))}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {hasDayGain && (
                          <span className={pnlClass(totalDayGain)}>
                            {fmtCAD(totalDayGain)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {hasDayGain && totalMkt > 0 && (
                          <span className={pnlClass(totalDayGain)}>
                            {fmtPct(String((totalDayGain / totalMkt) * 100))}
                          </span>
                        )}
                      </td>
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
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span className="font-mono font-semibold text-green-700">CASH</span>
                        <span className="ml-2 text-xs text-gray-400">
                          {cash.length} account{cash.length !== 1 ? 's' : ''}
                          {!cashExpanded && ' — click to expand'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">CASH</span>
                      </td>
                      <td colSpan={3} />
                      <td />
                      <td className="px-4 py-2.5 text-right font-semibold text-green-700">
                        {fmtCAD(totalCash)}
                      </td>
                      <td colSpan={4} />
                    </tr>

                    {/* Per-account cash rows, shown only when expanded */}
                    {cashExpanded && cash.map(c => (
                      <tr key={`${c.account_id}-${c.currency}`} className="bg-green-50/30 hover:bg-green-50/60">
                        <td className="w-8 px-4 py-2" />
                        <td className="px-4 py-2 pl-10 whitespace-nowrap">
                          <span className="text-xs text-gray-500">{c.account_name}</span>
                          <span className="ml-1.5 text-xs text-gray-400">· {c.currency}</span>
                        </td>
                          <td colSpan={4} />
                        <td />
                        <td className="px-4 py-2 text-right font-semibold text-green-700">
                          <div>{fmtCAD(c.balance_cad ?? c.balance)}</div>
                          {c.currency === 'USD' && (
                            <div className="text-xs text-gray-400 font-normal leading-none">
                              US{fmtUSD(parseFloat(c.balance))}
                            </div>
                          )}
                        </td>
                        <td colSpan={4} />
                      </tr>
                    ))}
                  </tbody>
                )}

                {/* Totals footer */}
                <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                  <tr className="font-semibold text-sm">
                    <td colSpan={2} className="px-4 py-2.5 text-gray-600">Totals</td>
                    <td colSpan={3} />
                    <td className="px-4 py-2.5 text-right">{fmtCAD(totalACB)}</td>
                    {/* Price column — empty */}
                    <td />
                    {/* Mkt Value (CAD) total — securities + cash (includes book-value fallback) */}
                    <td className="px-4 py-2.5 text-right">
                      {hasPrices ? (
                        <>
                          {fmtCAD(totalVal)}
                          {fallbackCount > 0 && <span className="text-amber-400 ml-0.5">*</span>}
                        </>
                      ) : '—'}
                    </td>
                    {/* P&L ($) total */}
                    <td className="px-4 py-2.5 text-right">
                      {hasPrices ? (
                        <span className={`font-semibold ${pnlClass(totalPnl)}`}>
                          {fmtCAD(totalPnl)}
                        </span>
                      ) : '—'}
                    </td>
                    {/* P&L (%) total */}
                    <td className="px-4 py-2.5 text-right">
                      {hasPrices && totalACB > 0 ? (
                        <span className={`font-semibold ${pnlClass(totalPnl)}`}>
                          {fmtPct(String((totalPnl / totalACB) * 100))}
                        </span>
                      ) : '—'}
                    </td>
                    {/* Day Gain ($) total */}
                    <td className="px-3 py-2.5 text-right">
                      {hasDayGain ? (
                        <span className={`font-semibold ${pnlClass(totalDayGain)}`}>
                          {fmtCAD(totalDayGain)}
                        </span>
                      ) : '—'}
                    </td>
                    {/* Day Gain (%) total — not summed, leave empty */}
                    <td className="px-3 py-2.5 text-right">—</td>
                  </tr>
                </tfoot>
              </table>
              {fallbackCount > 0 && (
                <p className="px-4 py-2 text-xs text-amber-600 bg-amber-50 border-t border-amber-100">
                  * {fallbackCount} position{fallbackCount !== 1 ? 's' : ''} valued at cost — no market price available
                </p>
              )}
            </div>
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
