import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { TrendingUp, TrendingDown, ChevronDown, ChevronRight } from 'lucide-react'
import {
  getCashBalances, getImports, getAccounts, getPositions,
  getFxRateLookup, getMarketIndicators, getSummaryMetrics,
} from '../api/client'
import type { Position, CashBalance, Account, MarketIndicator, SummaryMetrics } from '../api/client'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'
import { useFilterContext } from '../context/FilterContext'

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4', '#84CC16']

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCAD(val: string | number | null | undefined) {
  if (val === null || val === undefined) return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n)
}

function pnlClass(n: number) {
  return n > 0 ? 'text-emerald-600' : n < 0 ? 'text-red-500' : 'text-gray-500'
}

function fmtPct(n: number) {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

// ─── Brokerage Summary ────────────────────────────────────────────────────────

// Strip "(USD)" / "(CAD)" / "(XXX)" suffix to find canonical account name for pairing
function canonicalName(name: string): string {
  return name.replace(/\s*\([A-Z]{3}\)\s*$/i, '').trim()
}

interface AccountRow {
  account_id: number; account_name: string; account_type: string; base_currency: string
  securities: number; book_value: number; cash: number; total: number; pnl: number
  dayGain: number; hasDayGain: boolean
  hasPrices: boolean; hasFallback: boolean
  // Set when this row is a combined group header for paired CAD+USD accounts
  subAccounts?: AccountRow[]
}
interface BrokerageRow {
  name: string; accounts: AccountRow[]
  totalSecurities: number; totalBook: number; totalCash: number; total: number; pnl: number
  dayGain: number; hasDayGain: boolean
  hasPrices: boolean; hasFallback: boolean
}

function fmtUSD(val: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(val)
}

function BrokerageSummary({ data, usdCadRate }: { data: BrokerageRow[]; usdCadRate: number | null }) {
  const [expanded, setExpanded]       = useState<Set<string>>(new Set())
  const [expandedGrp, setExpandedGrp] = useState<Set<string>>(new Set())

  const toggleBrok = (name: string) =>
    setExpanded(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })
  const toggleGrp = (key: string) =>
    setExpandedGrp(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })

  if (data.length === 0)
    return <p className="text-gray-400 text-sm py-4">No positions found.</p>

  return (
    <>
    {/* ── Mobile: brokerage cards (the table is too dense for phones) ── */}
    <div className="md:hidden space-y-3">
      {data.map(brok => {
        const isOpen = expanded.has(brok.name)
        return (
          <div key={brok.name} className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <button
              onClick={() => toggleBrok(brok.name)}
              className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left active:bg-gray-50"
            >
              <div className="min-w-0">
                <div className="font-semibold text-gray-900 flex items-center gap-1.5">
                  {isOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
                  {brok.name}
                </div>
                <div className="text-xs text-gray-400 mt-0.5 truncate">
                  {brok.accounts.length} acct{brok.accounts.length !== 1 ? 's' : ''} · Cash {fmtCAD(brok.totalCash)}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="font-bold text-blue-700">{fmtCAD(brok.total)}</div>
                <div className={`text-xs font-medium ${brok.hasPrices ? pnlClass(brok.pnl) : 'text-gray-400'}`}>
                  {brok.hasPrices ? (brok.pnl >= 0 ? '+' : '') + fmtCAD(brok.pnl) + ' P&L' : '—'}
                </div>
              </div>
            </button>
            {isOpen && (
              <div className="border-t border-gray-100 divide-y divide-gray-50 bg-gray-50/30">
                {brok.accounts.map(acct => (
                  <div key={acct.account_id} className="px-4 py-2 flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium whitespace-nowrap">{acct.account_type}</span>
                      <span className="text-gray-700 truncate">{acct.account_name}</span>
                    </span>
                    <span className="font-mono font-medium text-gray-900 flex-shrink-0">{fmtCAD(acct.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>

    {/* ── Desktop: full table ── */}
    <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      <table className="w-full text-sm">
        <colgroup>
          <col />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-28" />
          <col className="w-32" />
          <col className="w-28" />
          <col className="w-24" />
          <col className="w-28" />
        </colgroup>
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-400 uppercase tracking-wide">
            <th className="px-4 py-2.5 text-left">Brokerage / Account</th>
            <th className="px-3 py-2.5 text-right"></th>
            <th className="px-3 py-2.5 text-right">Book Value</th>
            <th className="px-3 py-2.5 text-right">Securities</th>
            <th className="px-3 py-2.5 text-right">Cash</th>
            <th className="px-3 py-2.5 text-right">Total Value</th>
            <th className="px-3 py-2.5 text-right">Day Gain ($)</th>
            <th className="px-3 py-2.5 text-right">Day Gain (%)</th>
            <th className="px-4 py-2.5 text-right">P&L</th>
          </tr>
        </thead>
        <tbody>
          {data.map((brok, bi) => {
            const isOpen = expanded.has(brok.name)
            return (
              <>
                {/* ── Brokerage row ── */}
                <tr
                  key={brok.name}
                  onClick={() => toggleBrok(brok.name)}
                  className={`cursor-pointer hover:bg-blue-50 transition-colors ${bi > 0 ? 'border-t border-gray-200' : ''} bg-gray-50/70`}
                >
                  <td className="px-4 py-3 font-semibold text-gray-900">
                    <span className="inline-flex items-center gap-2">
                      {isOpen
                        ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                        : <ChevronRight className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
                      {brok.name}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-gray-400">
                    {brok.accounts.length} acct{brok.accounts.length !== 1 ? 's' : ''}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-gray-600 text-sm">{fmtCAD(brok.totalBook)}</td>
                  <td className="px-3 py-3 text-right font-mono text-gray-800 text-sm font-medium">
                    {fmtCAD(brok.totalSecurities)}
                    {brok.hasFallback && <span className="text-amber-500 ml-0.5" title="Some positions valued at cost">*</span>}
                  </td>
                  <td className={`px-3 py-3 text-right font-mono text-sm ${brok.totalCash < 0 ? 'text-red-600' : 'text-gray-700'}`}>
                    {fmtCAD(brok.totalCash)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono font-bold text-blue-700 text-sm">{fmtCAD(brok.total)}</td>
                  <td className={`px-3 py-3 text-right font-mono text-sm font-medium ${brok.hasDayGain ? pnlClass(brok.dayGain) : 'text-gray-300'}`}>
                    {brok.hasDayGain ? (brok.dayGain >= 0 ? '+' : '') + fmtCAD(brok.dayGain) : '—'}
                  </td>
                  <td className={`px-3 py-3 text-right font-mono text-sm font-medium ${brok.hasDayGain && brok.totalSecurities > 0 ? pnlClass(brok.dayGain) : 'text-gray-300'}`}>
                    {brok.hasDayGain && brok.totalSecurities > 0 ? fmtPct(brok.dayGain / brok.totalSecurities * 100) : '—'}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono text-sm font-medium ${brok.hasPrices ? pnlClass(brok.pnl) : 'text-gray-400'}`}>
                    {brok.hasPrices ? (brok.pnl >= 0 ? '+' : '') + fmtCAD(brok.pnl) : '—'}
                  </td>
                </tr>

                {/* ── Account / group rows (shown when brokerage expanded) ── */}
                {isOpen && brok.accounts.map(acct => {
                  const isPaired = !!acct.subAccounts?.length
                  const grpKey   = `${brok.name}::${acct.account_name}`
                  const grpOpen  = expandedGrp.has(grpKey)

                  return (
                    <>
                      {/* Account or combined group row */}
                      <tr
                        key={acct.account_id}
                        onClick={isPaired ? () => toggleGrp(grpKey) : undefined}
                        className={`border-t border-gray-100 bg-white ${isPaired ? 'cursor-pointer hover:bg-blue-50/40' : 'hover:bg-gray-50'}`}
                      >
                        <td className="px-4 py-2.5 pl-10 text-gray-700">
                          <span className="inline-flex items-center gap-2">
                            {isPaired && (grpOpen
                              ? <ChevronDown className="h-3 w-3 text-gray-400 flex-shrink-0" />
                              : <ChevronRight className="h-3 w-3 text-gray-400 flex-shrink-0" />)}
                            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium whitespace-nowrap">
                              {acct.account_type}
                            </span>
                            {acct.account_name}
                            {isPaired && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 font-medium">CAD+USD</span>
                            )}
                          </span>
                        </td>
                        <td></td>
                        <td className="px-3 py-2.5 text-right font-mono text-gray-400 text-xs">{fmtCAD(acct.book_value)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-gray-700 text-xs">
                          {acct.securities > 0 ? fmtCAD(acct.securities) : '—'}
                          {acct.hasFallback && <span className="text-amber-500 ml-0.5" title="Valued at cost">*</span>}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-mono text-xs ${acct.cash < 0 ? 'text-red-600' : 'text-gray-600'}`}>
                          {fmtCAD(acct.cash)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-semibold text-blue-700 text-xs">{fmtCAD(acct.total)}</td>
                        <td className={`px-3 py-2.5 text-right font-mono text-xs font-medium ${acct.hasDayGain ? pnlClass(acct.dayGain) : 'text-gray-300'}`}>
                          {acct.hasDayGain ? (acct.dayGain >= 0 ? '+' : '') + fmtCAD(acct.dayGain) : '—'}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-mono text-xs font-medium ${acct.hasDayGain && acct.securities > 0 ? pnlClass(acct.dayGain) : 'text-gray-300'}`}>
                          {acct.hasDayGain && acct.securities > 0 ? fmtPct(acct.dayGain / acct.securities * 100) : '—'}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium ${acct.hasPrices ? pnlClass(acct.pnl) : 'text-gray-400'}`}>
                          {acct.hasPrices ? (acct.pnl >= 0 ? '+' : '') + fmtCAD(acct.pnl) : '—'}
                        </td>
                      </tr>

                      {/* Sub-account rows (CAD + USD legs when group is expanded) */}
                      {isPaired && grpOpen && acct.subAccounts!.map(sub => {
                        const isUSD = sub.base_currency === 'USD'
                        const rate  = usdCadRate ?? 1
                        return (
                          <tr key={sub.account_id} className="border-t border-gray-50 bg-white hover:bg-gray-50">
                            <td className="px-4 py-2 pl-16 text-gray-600 text-xs">
                              <span className="inline-flex items-center gap-2">
                                <span className={`px-1.5 py-0.5 rounded font-medium ${isUSD ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                                  {sub.base_currency}
                                </span>
                                {sub.account_name}
                              </span>
                            </td>
                            <td></td>
                            <td className="px-3 py-2 text-right font-mono text-gray-400 text-xs">
                              {isUSD ? fmtUSD(sub.book_value / rate) : fmtCAD(sub.book_value)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-xs text-gray-700">
                              {sub.securities > 0
                                ? isUSD ? <>{fmtUSD(sub.securities / rate)}<span className="text-gray-400 ml-1">= {fmtCAD(sub.securities)}</span></> : fmtCAD(sub.securities)
                                : '—'}
                              {sub.hasFallback && <span className="text-amber-500 ml-0.5">*</span>}
                            </td>
                            <td className={`px-3 py-2 text-right font-mono text-xs ${sub.cash < 0 ? 'text-red-600' : 'text-gray-600'}`}>
                              {isUSD
                                ? <>{fmtUSD(sub.cash / rate)}<span className="text-gray-400 ml-1">= {fmtCAD(sub.cash)}</span></>
                                : fmtCAD(sub.cash)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-blue-700">
                              {isUSD
                                ? <>{fmtUSD(sub.total / rate)}<span className="text-gray-400 ml-1">= {fmtCAD(sub.total)}</span></>
                                : fmtCAD(sub.total)}
                            </td>
                            <td className={`px-3 py-2 text-right font-mono text-xs ${sub.hasDayGain ? pnlClass(sub.dayGain) : 'text-gray-300'}`}>
                              {sub.hasDayGain ? (sub.dayGain >= 0 ? '+' : '') + fmtCAD(sub.dayGain) : '—'}
                            </td>
                            <td className={`px-3 py-2 text-right font-mono text-xs ${sub.hasDayGain && sub.securities > 0 ? pnlClass(sub.dayGain) : 'text-gray-300'}`}>
                              {sub.hasDayGain && sub.securities > 0 ? fmtPct(sub.dayGain / sub.securities * 100) : '—'}
                            </td>
                            <td className={`px-4 py-2 text-right font-mono text-xs ${sub.hasPrices ? pnlClass(sub.pnl) : 'text-gray-400'}`}>
                              {sub.hasPrices ? (sub.pnl >= 0 ? '+' : '') + fmtCAD(sub.pnl) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </>
                  )
                })}
              </>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold text-sm">
            <td className="px-4 py-3 text-gray-700">Total</td>
            <td></td>
            <td className="px-3 py-3 text-right font-mono text-gray-600">{fmtCAD(data.reduce((s, b) => s + b.totalBook, 0))}</td>
            <td className="px-3 py-3 text-right font-mono text-gray-800">{fmtCAD(data.reduce((s, b) => s + b.totalSecurities, 0))}</td>
            <td className={`px-3 py-3 text-right font-mono ${data.reduce((s, b) => s + b.totalCash, 0) < 0 ? 'text-red-600' : 'text-gray-700'}`}>
              {fmtCAD(data.reduce((s, b) => s + b.totalCash, 0))}
            </td>
            <td className="px-3 py-3 text-right font-mono text-blue-700">{fmtCAD(data.reduce((s, b) => s + b.total, 0))}</td>
            {(() => {
              const totalDG = data.reduce((s, b) => s + b.dayGain, 0)
              const hasDG   = data.some(b => b.hasDayGain)
              const totSec  = data.reduce((s, b) => s + b.totalSecurities, 0)
              return (
                <>
                  <td className={`px-3 py-3 text-right font-mono ${hasDG ? pnlClass(totalDG) : 'text-gray-300'}`}>
                    {hasDG ? (totalDG >= 0 ? '+' : '') + fmtCAD(totalDG) : '—'}
                  </td>
                  <td className={`px-3 py-3 text-right font-mono ${hasDG && totSec > 0 ? pnlClass(totalDG) : 'text-gray-300'}`}>
                    {hasDG && totSec > 0 ? fmtPct(totalDG / totSec * 100) : '—'}
                  </td>
                </>
              )
            })()}
            <td className={`px-4 py-3 text-right font-mono ${pnlClass(data.filter(b => b.hasPrices).reduce((s, b) => s + b.pnl, 0))}`}>
              {data.some(b => b.hasPrices)
                ? (() => { const p = data.filter(b => b.hasPrices).reduce((s, b) => s + b.pnl, 0); return (p >= 0 ? '+' : '') + fmtCAD(p) })()
                : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
      {data.some(b => b.hasFallback) && (
        <p className="px-4 py-2 text-xs text-amber-600 bg-amber-50 border-t border-amber-100">
          * Valued at cost — no market price available for these positions
        </p>
      )}
      {usdCadRate && (
        <p className="px-4 py-2 text-xs text-gray-400 bg-gray-50 border-t border-gray-100">
          USD amounts shown at {usdCadRate.toFixed(4)} USD/CAD (rate as of selected date)
        </p>
      )}
    </div>
    </>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  // Time range from global context (set via header)
  const { toDate } = useFilterContext()

  // Data queries
  const { data: rawAccounts = [], isLoading: accountsLoading } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const { data: positions    = [] } = useQuery({ queryKey: ['positions', toDate],       queryFn: () => getPositions({ as_of: toDate }) })
  const { data: cashBalances = [] } = useQuery({ queryKey: ['cash-balances', toDate],   queryFn: () => getCashBalances({ as_of: toDate }) })
  const { data: imports      = [] } = useQuery({ queryKey: ['imports'],                queryFn: getImports })

  const accounts = rawAccounts as Account[]

  // Global account filter
  const { effectiveAccountIds, hasFilter } = usePortfolioFilters(accounts)

  const filteredPositions = useMemo(() => {
    if (accountsLoading) return []
    return effectiveAccountIds.size > 0
      ? (positions as Position[]).filter(p => effectiveAccountIds.has(p.account_id))
      : (positions as Position[])
  }, [positions, effectiveAccountIds, accountsLoading])

  const filteredCash = useMemo(() => {
    if (accountsLoading) return []
    return effectiveAccountIds.size > 0
      ? (cashBalances as CashBalance[]).filter(c => effectiveAccountIds.has(c.account_id))
      : (cashBalances as CashBalance[])
  }, [cashBalances, effectiveAccountIds, accountsLoading])

  // USD/CAD rate on toDate — used to display USD sub-account values in native currency
  const { data: usdCadData } = useQuery({
    queryKey: ['fx-rate', 'USD', 'CAD', toDate],
    queryFn: () => getFxRateLookup(toDate, 'USD', 'CAD'),
    staleTime: 60_000,
  })
  const usdCadRate = usdCadData ? parseFloat(usdCadData.rate) : null

  const { data: indicators = [] } = useQuery({
    queryKey: ['market-indicators'],
    queryFn: getMarketIndicators,
    staleTime: 4 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })

  // Wait for accounts to load before computing IDs — avoids firing the summary
  // with account_ids=undefined (all accounts) while the accounts query is in flight.
  const metricsAccountIds = accountsLoading
    ? null                                          // null disables the query (see `enabled` below)
    : effectiveAccountIds.size > 0
      ? [...effectiveAccountIds].join(',')
      : undefined

  const { data: summaryMetrics } = useQuery({
    queryKey: ['summary-metrics', metricsAccountIds, toDate],
    queryFn: () => getSummaryMetrics({ account_ids: metricsAccountIds ?? undefined, as_of: toDate }),
    enabled: metricsAccountIds !== null,   // wait until accounts have loaded
    staleTime: 5 * 60 * 1000,
  })

  const pendingImports = imports.filter((i: { status: string }) => i.status === 'PENDING')

  // ── Summary totals (with no-price fallback) ───────────────────────────────
  const { totalSecurities, totalPnl, fallbackCount } = useMemo(() => {
    let securities = 0, pnl = 0, fallback = 0
    for (const p of filteredPositions) {
      const bv = parseFloat(p.total_acb_cad || '0')
      if (p.market_value_cad) { const mv = parseFloat(p.market_value_cad); securities += mv; pnl += mv - bv }
      else { securities += bv; fallback++ }
    }
    return { totalSecurities: securities, totalPnl: pnl, fallbackCount: fallback }
  }, [filteredPositions])

  const totalBookValue = filteredPositions.reduce((s, p) => s + parseFloat(p.total_acb_cad || '0'), 0)
  const totalCash      = filteredCash.reduce((s, c) => s + parseFloat(c.balance_cad || '0'), 0)
  const totalValue     = totalSecurities + totalCash
  const hasPrices      = filteredPositions.some(p => p.market_value_cad)

  const { totalDayGain, hasDayGain } = useMemo(() => {
    let total = 0, hasAny = false
    for (const p of filteredPositions) {
      if (p.day_gain_cad) { total += parseFloat(p.day_gain_cad); hasAny = true }
    }
    return { totalDayGain: total, hasDayGain: hasAny }
  }, [filteredPositions])

  const allAcctIds = useMemo(() => {
    const ids = new Set<number>()
    filteredPositions.forEach(p => ids.add(p.account_id))
    filteredCash.forEach(c => ids.add(c.account_id))
    return [...ids]
  }, [filteredPositions, filteredCash])

  // ── Brokerage summary ─────────────────────────────────────────────────────
  const brokerageSummary = useMemo((): BrokerageRow[] => {
    const accountMap = new Map<number, Account>()
    for (const a of accounts) accountMap.set(a.id, a)
    const byBrokerage = new Map<string, { accounts: Map<number, AccountRow> }>()

    const ensureAccount = (id: number, name: string, type: string, ccy: string, brok: string): AccountRow => {
      if (!byBrokerage.has(brok)) byBrokerage.set(brok, { accounts: new Map() })
      const be = byBrokerage.get(brok)!
      if (!be.accounts.has(id))
        be.accounts.set(id, { account_id: id, account_name: name, account_type: type,
          base_currency: ccy, securities: 0, book_value: 0, cash: 0, total: 0, pnl: 0,
          dayGain: 0, hasDayGain: false,
          hasPrices: false, hasFallback: false })
      return be.accounts.get(id)!
    }

    for (const p of filteredPositions) {
      const acct = accountMap.get(p.account_id); if (!acct) continue
      const row = ensureAccount(p.account_id, p.account_name, p.account_type, acct.base_currency, acct.brokerage_name)
      const bv = parseFloat(p.total_acb_cad || '0')
      row.book_value += bv
      if (p.market_value_cad) { row.securities += parseFloat(p.market_value_cad); row.hasPrices = true }
      else { row.securities += bv; row.hasFallback = true }
      if (p.day_gain_cad) { row.dayGain += parseFloat(p.day_gain_cad); row.hasDayGain = true }
    }
    for (const c of filteredCash) {
      const acct = accountMap.get(c.account_id); if (!acct) continue
      const row = ensureAccount(c.account_id, c.account_name, c.account_type, acct.base_currency, acct.brokerage_name)
      row.cash += parseFloat(c.balance_cad || '0')
    }

    return [...byBrokerage.entries()].map(([brokName, data]) => {
      // Compute totals on individual accounts first
      const rawRows = [...data.accounts.values()].map(a => ({
        ...a, total: a.securities + a.cash,
        pnl: a.hasPrices ? a.securities - a.book_value : 0,
      }))

      // Group by canonical name (strip "(USD)"/"(CAD)" suffix) to detect pairs
      const byCanonical = new Map<string, AccountRow[]>()
      for (const row of rawRows) {
        const key = canonicalName(row.account_name)
        if (!byCanonical.has(key)) byCanonical.set(key, [])
        byCanonical.get(key)!.push(row)
      }

      // Build display rows — merge pairs into a combined group row
      const acctRows: AccountRow[] = []
      for (const [key, group] of byCanonical.entries()) {
        if (group.length === 1) {
          acctRows.push(group[0])
        } else {
          // Multiple accounts share a canonical name → create a combined group header
          const sorted = [...group].sort((a, b) => a.base_currency.localeCompare(b.base_currency))
          const combined: AccountRow = {
            account_id:    sorted[0].account_id,
            account_name:  key,
            account_type:  sorted[0].account_type,
            base_currency: 'CAD',
            securities:    sorted.reduce((s, r) => s + r.securities, 0),
            book_value:    sorted.reduce((s, r) => s + r.book_value, 0),
            cash:          sorted.reduce((s, r) => s + r.cash, 0),
            total:         sorted.reduce((s, r) => s + r.total, 0),
            pnl:           sorted.filter(r => r.hasPrices).reduce((s, r) => s + r.pnl, 0),
            dayGain:       sorted.reduce((s, r) => s + r.dayGain, 0),
            hasDayGain:    sorted.some(r => r.hasDayGain),
            hasPrices:     sorted.some(r => r.hasPrices),
            hasFallback:   sorted.some(r => r.hasFallback),
            subAccounts:   sorted,
          }
          acctRows.push(combined)
        }
      }

      acctRows.sort((a, b) => a.account_name.localeCompare(b.account_name))

      return {
        name: brokName, accounts: acctRows,
        totalSecurities: acctRows.reduce((s, a) => s + a.securities, 0),
        totalBook:        acctRows.reduce((s, a) => s + a.book_value, 0),
        totalCash:        acctRows.reduce((s, a) => s + a.cash, 0),
        total:            acctRows.reduce((s, a) => s + a.total, 0),
        pnl:              acctRows.filter(a => a.hasPrices).reduce((s, a) => s + a.pnl, 0),
        dayGain:          acctRows.reduce((s, a) => s + a.dayGain, 0),
        hasDayGain:       acctRows.some(a => a.hasDayGain),
        hasPrices:        acctRows.some(a => a.hasPrices),
        hasFallback:      acctRows.some(a => a.hasFallback),
      }
    }).sort((a, b) => b.total - a.total)
  }, [filteredPositions, filteredCash, accounts])

  // ── Allocation by account type ────────────────────────────────────────────
  const allocationByType = useMemo(() => {
    const byType: Record<string, number> = {}
    for (const p of filteredPositions) {
      const type = p.account_type || 'Unknown'
      byType[type] = (byType[type] || 0) + (p.market_value_cad ? parseFloat(p.market_value_cad) : parseFloat(p.total_acb_cad || '0'))
    }
    for (const c of filteredCash) {
      const type = (c as CashBalance).account_type || 'Unknown'
      const val = parseFloat(c.balance_cad || '0')
      if (val > 0) byType[type] = (byType[type] || 0) + val
    }
    const total = Object.values(byType).reduce((s, v) => s + v, 0) || 1
    return Object.entries(byType).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a)
      .map(([type, val]) => ({ account_type: type, total_cad: val, pct: (val / total) * 100 }))
  }, [filteredPositions, filteredCash])

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>

      {/* ── Market Indicators bar ── */}
      <div className="bg-gray-900 rounded-xl overflow-x-auto">
        <div className="flex items-center gap-0 min-w-max px-2 py-1.5">
          {(indicators as MarketIndicator[]).map(ind => {
            const isUp = ind.day_change_pct != null && ind.day_change_pct > 0
            const isDown = ind.day_change_pct != null && ind.day_change_pct < 0
            const pctStr = ind.day_change_pct != null
              ? (ind.day_change_pct > 0 ? '+' : '') + ind.day_change_pct.toFixed(2) + '%'
              : '—'
            const priceStr = ind.price != null
              ? ind.symbol === 'CADUSD=X'
                ? ind.price.toFixed(4)
                : ind.price >= 1000
                  ? ind.price.toLocaleString('en', { maximumFractionDigits: 0 })
                  : ind.price.toFixed(2)
              : '—'
            return (
              <div key={ind.symbol} className="flex items-center gap-2 px-3 py-1 border-r border-gray-700 last:border-0">
                <span className="text-xs text-gray-400 font-medium whitespace-nowrap">{ind.label}</span>
                <span className="text-xs font-semibold text-white whitespace-nowrap">{priceStr}</span>
                <span className={`text-xs font-medium whitespace-nowrap ${isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-gray-500'}`}>
                  {pctStr}
                </span>
              </div>
            )
          })}
          {(indicators as MarketIndicator[]).length === 0 && (
            <span className="text-xs text-gray-500 px-3 py-1">Loading market data…</span>
          )}
        </div>
      </div>

      {pendingImports.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-center gap-3">
          <span className="text-yellow-700 font-medium">
            {pendingImports.length} import batch{pendingImports.length > 1 ? 'es' : ''} pending review
          </span>
          <a href="/import" className="text-sm text-yellow-700 underline">Review now</a>
        </div>
      )}

      {/* ── Summary bar ── */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-4 md:px-6 shadow-sm">
        {/* ── Mobile: Total Value hero + compact 2-col grid ── */}
        <div className="md:hidden">
          <div className="text-center pb-3 mb-3 border-b border-blue-200">
            <div className="text-xs text-blue-500 uppercase tracking-wide">Total Value</div>
            <div className="text-3xl font-bold text-blue-900">{fmtCAD(totalValue)}</div>
            <div className="text-[11px] text-blue-400 mt-0.5">{filteredPositions.length} positions · {allAcctIds.length} accounts</div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <div className="text-[11px] text-blue-500 uppercase tracking-wide">Book Value</div>
              <div className="text-lg font-bold text-blue-900">{fmtCAD(totalBookValue)}</div>
            </div>
            <div>
              <div className="text-[11px] text-blue-500 uppercase tracking-wide">
                Securities{fallbackCount > 0 && <span className="ml-1 text-amber-500">*</span>}
              </div>
              <div className="text-lg font-bold text-blue-900">{fmtCAD(totalSecurities)}</div>
            </div>
            <div>
              <div className="text-[11px] text-blue-500 uppercase tracking-wide">Cash</div>
              <div className={`text-lg font-bold ${totalCash < 0 ? 'text-red-600' : 'text-blue-900'}`}>{fmtCAD(totalCash)}</div>
            </div>
            {hasPrices && (
              <div>
                <div className="text-[11px] text-blue-500 uppercase tracking-wide">Unrealized P&L</div>
                <div className={`text-lg font-bold ${pnlClass(totalPnl)}`}>{(totalPnl >= 0 ? '+' : '') + fmtCAD(totalPnl)}</div>
              </div>
            )}
            {hasDayGain && (
              <div>
                <div className="text-[11px] text-blue-500 uppercase tracking-wide">Day Gain</div>
                <div className={`text-lg font-bold ${pnlClass(totalDayGain)}`}>{(totalDayGain >= 0 ? '+' : '') + fmtCAD(totalDayGain)}</div>
              </div>
            )}
            {(summaryMetrics as SummaryMetrics | undefined) && (summaryMetrics as SummaryMetrics).ytd_gain_cad !== undefined && (
              <div>
                <div className="text-[11px] text-blue-500 uppercase tracking-wide">YTD P&L</div>
                <div className={`text-lg font-bold ${pnlClass((summaryMetrics as SummaryMetrics).ytd_gain_cad)}`}>
                  {((summaryMetrics as SummaryMetrics).ytd_gain_cad >= 0 ? '+' : '') + fmtCAD((summaryMetrics as SummaryMetrics).ytd_gain_cad)}
                </div>
              </div>
            )}
            {(summaryMetrics as SummaryMetrics | undefined) && (summaryMetrics as SummaryMetrics).one_year_gain_cad !== undefined && (
              <div>
                <div className="text-[11px] text-blue-500 uppercase tracking-wide">1Y P&L</div>
                <div className={`text-lg font-bold ${pnlClass((summaryMetrics as SummaryMetrics).one_year_gain_cad)}`}>
                  {((summaryMetrics as SummaryMetrics).one_year_gain_cad >= 0 ? '+' : '') + fmtCAD((summaryMetrics as SummaryMetrics).one_year_gain_cad)}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Desktop: flex-wrap metrics row ── */}
        <div className="hidden md:flex md:flex-wrap md:items-center md:gap-x-10 md:gap-y-3">
          <div>
            <div className="text-xs text-blue-500 uppercase tracking-wide">Book Value</div>
            <div className="text-xl md:text-2xl font-bold text-blue-900">{fmtCAD(totalBookValue)}</div>
          </div>
          <div>
            <div className="text-xs text-blue-500 uppercase tracking-wide">
              Securities
              {fallbackCount > 0 && <span className="ml-1 text-amber-500" title={`${fallbackCount} position(s) valued at cost`}>*</span>}
            </div>
            <div className="text-xl md:text-2xl font-bold text-blue-900">{fmtCAD(totalSecurities)}</div>
          </div>
          <div>
            <div className="text-xs text-blue-500 uppercase tracking-wide">Cash</div>
            <div className={`text-xl md:text-2xl font-bold ${totalCash < 0 ? 'text-red-600' : 'text-blue-900'}`}>{fmtCAD(totalCash)}</div>
          </div>
          <div className="md:border-l md:border-blue-200 md:pl-10">
            <div className="text-xs text-blue-500 uppercase tracking-wide">Total Value</div>
            <div className="text-2xl md:text-3xl font-bold text-blue-900">{fmtCAD(totalValue)}</div>
          </div>
          {hasPrices && (
            <div>
              <div className="text-xs text-blue-500 uppercase tracking-wide">Unrealized P&L</div>
              <div className={`text-xl md:text-2xl font-bold flex items-center gap-1 ${pnlClass(totalPnl)}`}>
                {totalPnl >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                {fmtCAD(totalPnl)}
              </div>
            </div>
          )}
          {hasDayGain && (
            <div>
              <div className="text-xs text-blue-500 uppercase tracking-wide">Day Gain</div>
              <div className={`text-xl md:text-2xl font-bold flex items-center gap-1 ${pnlClass(totalDayGain)}`}>
                {totalDayGain >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                {fmtCAD(totalDayGain)}
              </div>
            </div>
          )}
          {(summaryMetrics as SummaryMetrics | undefined) && (summaryMetrics as SummaryMetrics).ytd_gain_cad !== undefined && (
            <div>
              <div className="text-xs text-blue-500 uppercase tracking-wide">
                {toDate && new Date(toDate).getFullYear() !== new Date().getFullYear()
                  ? `YTD ${new Date(toDate).getFullYear()} P&L`
                  : 'YTD P&L'}
              </div>
              <div className={`text-xl md:text-2xl font-bold flex items-center gap-1 ${pnlClass((summaryMetrics as SummaryMetrics).ytd_gain_cad)}`}>
                {(summaryMetrics as SummaryMetrics).ytd_gain_cad >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                {fmtCAD((summaryMetrics as SummaryMetrics).ytd_gain_cad)}
              </div>
              {(summaryMetrics as SummaryMetrics).ytd_gain_pct != null && (
                <div className={`text-sm font-medium ${pnlClass((summaryMetrics as SummaryMetrics).ytd_gain_pct!)}`}>
                  {(summaryMetrics as SummaryMetrics).ytd_gain_pct! >= 0 ? '+' : ''}{(summaryMetrics as SummaryMetrics).ytd_gain_pct!.toFixed(2)}%
                </div>
              )}
            </div>
          )}
          {(summaryMetrics as SummaryMetrics | undefined) && (summaryMetrics as SummaryMetrics).one_year_gain_cad !== undefined && (
            <div>
              <div className="text-xs text-blue-500 uppercase tracking-wide">
                {toDate && new Date(toDate).getFullYear() !== new Date().getFullYear()
                  ? `1Y P&L (to ${toDate})`
                  : '1Y P&L'}
              </div>
              <div className={`text-xl md:text-2xl font-bold flex items-center gap-1 ${pnlClass((summaryMetrics as SummaryMetrics).one_year_gain_cad)}`}>
                {(summaryMetrics as SummaryMetrics).one_year_gain_cad >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                {fmtCAD((summaryMetrics as SummaryMetrics).one_year_gain_cad)}
              </div>
              {(summaryMetrics as SummaryMetrics).one_year_gain_pct != null && (
                <div className={`text-sm font-medium ${pnlClass((summaryMetrics as SummaryMetrics).one_year_gain_pct!)}`}>
                  {(summaryMetrics as SummaryMetrics).one_year_gain_pct! >= 0 ? '+' : ''}{(summaryMetrics as SummaryMetrics).one_year_gain_pct!.toFixed(2)}%
                </div>
              )}
            </div>
          )}
          <div className="ml-auto text-right">
            <div className="text-xs text-blue-400">{filteredPositions.length} positions</div>
            <div className="text-xs text-blue-400">{allAcctIds.length} accounts</div>
          </div>
        </div>
        {fallbackCount > 0 && (
          <p className="mt-2 text-xs text-amber-600">
            * {fallbackCount} position{fallbackCount !== 1 ? 's' : ''} valued at cost — no market price available
          </p>
        )}
      </div>

      {/* ── Brokerage breakdown ── */}
      <div>
        <h2 className="font-semibold text-gray-800 mb-3">By Brokerage</h2>
        <BrokerageSummary data={brokerageSummary} usdCadRate={usdCadRate} />
      </div>

      {/* ── Allocation ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
        <h2 className="font-semibold text-gray-800 mb-4">Allocation by Account Type</h2>
        {allocationByType.length === 0 ? (
          <p className="text-gray-400 text-sm">No allocation data</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={allocationByType} dataKey="pct" nameKey="account_type" cx="50%" cy="50%" outerRadius={85}
                label={({ account_type, pct }) => `${account_type} ${pct.toFixed(0)}%`} labelLine={false}>
                {allocationByType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: number, _: string, entry: { payload?: { total_cad?: number } }) => [
                `${v.toFixed(1)}% · ${fmtCAD(entry?.payload?.total_cad)}`,
              ]} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
