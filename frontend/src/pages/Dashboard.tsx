import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { TrendingUp, TrendingDown, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import {
  getCashBalances, getImports, getAccounts, getPositions, getPersonalAssets,
  getFxRateLookup, getMarketIndicators, getReturnsDetail, getMarketNews, getTopStories, getPortfolioNews,
  getPortfolioTimeline, PERSONAL_ASSET_CLASSES,
} from '../api/client'
import type { Position, CashBalance, Account, MarketIndicator, PersonalAsset, PersonalAssetClass } from '../api/client'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'
import { useFilterContext } from '../context/FilterContext'
import type { TimeRange } from '../context/FilterContext'
import NewsList from '../components/NewsList'
import Sparkline from '../components/Sparkline'
import { getPref, usePreference } from '../hooks/usePreference'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCAD(val: string | number | null | undefined) {
  if (val === null || val === undefined) return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  if (getPref('hideValues')) return '••••••'
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n)
}

function pnlClass(n: number) {
  return n > 0 ? 'text-emerald-600 dark:text-emerald-400' : n < 0 ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground'
}

function fmtPct(n: number) {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

const TIME_RANGE_LABEL: Record<TimeRange, string> = { YTD: 'YTD', '1Y': '1Y', '3Y': '3Y', '5Y': '5Y', ALL: 'All', CUSTOM: 'Custom' }

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
  if (getPref('hideValues')) return '••••••'
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(val)
}

// ─── Asset Group Summary (Crypto / Real Estate / Insurance / Other) ───────────
// A simpler sibling to BrokerageSummary — a flat list of items (no account nesting).
// A linked liability renders as an indented, red, negative row beneath its asset.
interface AssetGroupItem { security_id: number; name: string; value: number; isLiability: boolean }

function AssetGroupSummary({ title, items, total }: { title: string; items: AssetGroupItem[]; total: number }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-1.5 flex items-center gap-1.5 text-left hover:bg-accent/60 transition-colors font-semibold text-foreground"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        {title}
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border/60">
          {items.map(item => (
            <div key={item.security_id} className={`px-4 py-1.5 flex items-center justify-between text-sm ${item.isLiability ? 'pl-8 bg-muted/50' : ''}`}>
              <span className="text-foreground truncate">{item.name}</span>
              <span className={`font-mono font-medium ${item.isLiability ? 'text-red-500 dark:text-red-400' : 'text-foreground'}`}>
                {item.isLiability ? '-' : ''}{fmtCAD(Math.abs(item.value))}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="px-4 py-2 flex items-center justify-between text-sm font-semibold border-t-2 border-border bg-muted/50">
        <span className="text-foreground">Total</span>
        <span className={total < 0 ? 'text-red-500 dark:text-red-400' : 'text-foreground'}>{fmtCAD(total)}</span>
      </div>
    </div>
  )
}

// ─── Real Estate table (book value / total value / gain, with liability subtotal) ─
interface RealEstateRow {
  key: string; kind: 'asset' | 'liability' | 'subtotal'
  name: string; bookValue: number | null; totalValue: number; gain: number | null
}

function RealEstateTable({ rows, total }: { rows: RealEstateRow[]; total: number }) {
  const [expanded, setExpanded] = useState(true)
  const assetRows = rows.filter(r => r.kind === 'asset')
  const bookValueTotal = assetRows.some(r => r.bookValue != null)
    ? assetRows.reduce((s, r) => s + (r.bookValue ?? 0), 0)
    : null
  const gainTotal = assetRows.some(r => r.gain != null)
    ? assetRows.reduce((s, r) => s + (r.gain ?? 0), 0)
    : null
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-1.5 flex items-center gap-1.5 text-left hover:bg-accent/60 transition-colors font-semibold text-foreground"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        Real Estate
      </button>
      {expanded && (
        <div className="border-t border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/50">
                <th className="px-4 py-1.5 text-left">Name</th>
                <th className="px-3 py-1.5 text-right">Book Value</th>
                <th className="px-3 py-1.5 text-right">Total Value</th>
                <th className="px-4 py-1.5 text-right">Gain</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map(r => (
                <tr key={r.key} className={r.kind === 'subtotal' ? 'bg-muted/70' : r.kind === 'liability' ? 'bg-muted/40' : ''}>
                  <td className={`px-4 py-1.5 text-foreground truncate ${r.kind !== 'asset' ? 'pl-8' : ''} ${r.kind === 'subtotal' ? 'font-semibold text-muted-foreground' : ''}`}>
                    {r.name}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                    {r.bookValue != null ? fmtCAD(r.bookValue) : '—'}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${r.kind === 'subtotal' ? 'font-semibold' : ''} ${
                    r.kind === 'liability' ? 'text-red-500 dark:text-red-400' : r.totalValue < 0 ? 'text-red-500 dark:text-red-400' : 'text-foreground'
                  }`}>
                    {r.kind === 'liability' ? '-' + fmtCAD(Math.abs(r.totalValue)) : fmtCAD(r.totalValue)}
                  </td>
                  <td className={`px-4 py-1.5 text-right font-mono ${r.gain != null ? pnlClass(r.gain) : 'text-muted-foreground/50'}`}>
                    {r.gain != null ? (r.gain >= 0 ? '+' : '') + fmtCAD(r.gain) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/50 font-semibold text-sm">
                <td className="px-4 py-2 text-foreground">Total</td>
                <td className="px-3 py-2 text-right font-mono text-foreground">
                  {bookValueTotal != null ? fmtCAD(bookValueTotal) : '—'}
                </td>
                <td className={`px-3 py-2 text-right font-mono ${total < 0 ? 'text-red-500 dark:text-red-400' : 'text-foreground'}`}>
                  {fmtCAD(total)}
                </td>
                <td className={`px-4 py-2 text-right font-mono ${gainTotal != null ? pnlClass(gainTotal) : 'text-muted-foreground/50'}`}>
                  {gainTotal != null ? (gainTotal >= 0 ? '+' : '') + fmtCAD(gainTotal) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {!expanded && (
        <div className="px-4 py-2 flex items-center justify-between text-sm font-semibold border-t-2 border-border bg-muted/50">
          <span className="text-foreground">Total</span>
          <span className={total < 0 ? 'text-red-500 dark:text-red-400' : 'text-foreground'}>{fmtCAD(total)}</span>
        </div>
      )}
    </div>
  )
}

function BrokerageSummary({
  data, usdCadRate, sparklines,
}: {
  data: BrokerageRow[]
  usdCadRate: number | null
  /** Per-brokerage value history (from the timeline endpoint, group_by=brokerage), keyed by brokerage name. */
  sparklines: Record<string, number[]>
}) {
  const [expanded, setExpanded]       = useState<Set<string>>(new Set())
  const [expandedGrp, setExpandedGrp] = useState<Set<string>>(new Set())
  const navigate = useNavigate()
  const { setFilterBrokerages, setFilterAccounts } = useFilterContext()

  const toggleBrok = (name: string) =>
    setExpanded(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })
  const toggleGrp = (key: string) =>
    setExpandedGrp(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })

  // Jump to Holdings pre-filtered to this brokerage / account (same SPA session, so the
  // shared FilterContext carries the filter across the navigation).
  const goToBrokerageHoldings = (name: string) => {
    setFilterBrokerages([name]); setFilterAccounts([])
    navigate('/holdings')
  }
  const goToAccountHoldings = (accountId: number) => {
    setFilterBrokerages([]); setFilterAccounts([String(accountId)])
    navigate('/holdings')
  }

  if (data.length === 0)
    return <p className="text-muted-foreground text-sm py-4">No positions found.</p>

  return (
    <>
    {/* ── Mobile: brokerage cards (the table is too dense for phones) ── */}
    <div className="md:hidden space-y-3">
      {data.map(brok => {
        const isOpen = expanded.has(brok.name)
        return (
          <div key={brok.name} className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <button
              onClick={() => toggleBrok(brok.name)}
              className="w-full px-4 py-1.5 flex items-center justify-between gap-3 text-left active:bg-accent/60"
            >
              <div className="min-w-0">
                <div className="font-semibold text-foreground flex items-center gap-1.5">
                  {isOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
                  {brok.name}
                  <span
                    onClick={e => { e.stopPropagation(); goToBrokerageHoldings(brok.name) }}
                    className="text-muted-foreground/50 hover:text-primary"
                    title="View in Holdings"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">
                  {brok.accounts.length} acct{brok.accounts.length !== 1 ? 's' : ''} · Cash {fmtCAD(brok.totalCash)}
                </div>
              </div>
              <div className="text-right flex-shrink-0 flex items-center gap-2">
                {sparklines[brok.name] && <Sparkline data={sparklines[brok.name]} width={48} height={20} />}
                <div>
                  <div className="font-bold text-primary">{fmtCAD(brok.total)}</div>
                  <div className={`text-xs font-medium ${brok.hasPrices ? pnlClass(brok.pnl) : 'text-muted-foreground'}`}>
                    {brok.hasPrices ? (brok.pnl >= 0 ? '+' : '') + fmtCAD(brok.pnl) + ' P&L' : '—'}
                  </div>
                </div>
              </div>
            </button>
            {isOpen && (
              <div className="border-t border-border divide-y divide-border/60 bg-muted/30">
                {brok.accounts.map(acct => (
                  <div key={acct.account_id} className="px-4 py-1.5 flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium whitespace-nowrap">{acct.account_type}</span>
                      <span className="text-foreground truncate">{acct.account_name}</span>
                      <span
                        onClick={() => goToAccountHoldings(acct.account_id)}
                        className="text-muted-foreground/50 hover:text-primary flex-shrink-0"
                        title="View in Holdings"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </span>
                    </span>
                    <span className="font-mono font-medium text-foreground flex-shrink-0">{fmtCAD(acct.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>

    {/* ── Desktop: full table ── */}
    <div className="hidden md:block bg-card border border-border rounded-xl overflow-hidden shadow-sm">
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
          <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground uppercase tracking-wide">
            <th className="px-4 py-2 text-left">Brokerages</th>
            <th className="px-3 py-2 text-right"></th>
            <th className="px-3 py-2 text-right">Book Value</th>
            <th className="px-3 py-2 text-right">Securities</th>
            <th className="px-3 py-2 text-right">Cash</th>
            <th className="px-3 py-2 text-right">Total Value</th>
            <th className="px-3 py-2 text-right">Day Gain ($)</th>
            <th className="px-3 py-2 text-right">Day Gain (%)</th>
            <th className="px-4 py-2 text-right">P&L</th>
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
                  className={`cursor-pointer hover:bg-primary/5 transition-colors ${bi > 0 ? 'border-t border-border' : ''} bg-muted/70`}
                >
                  <td className="px-4 py-1.5 font-semibold text-foreground">
                    <span className="inline-flex items-center gap-2">
                      {isOpen
                        ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                        : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
                      {brok.name}
                      <span
                        onClick={e => { e.stopPropagation(); goToBrokerageHoldings(brok.name) }}
                        className="text-muted-foreground/50 hover:text-primary"
                        title="View in Holdings"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </span>
                      {sparklines[brok.name] && <Sparkline data={sparklines[brok.name]} width={56} height={18} className="flex-shrink-0" />}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">
                    {brok.accounts.length} acct{brok.accounts.length !== 1 ? 's' : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground text-sm">{fmtCAD(brok.totalBook)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-foreground text-sm font-medium">
                    {fmtCAD(brok.totalSecurities)}
                    {brok.hasFallback && <span className="text-amber-500 dark:text-amber-400 ml-0.5" title="Some positions valued at cost">*</span>}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono text-sm ${brok.totalCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
                    {fmtCAD(brok.totalCash)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono font-bold text-primary text-sm">{fmtCAD(brok.total)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono text-sm font-medium ${brok.hasDayGain ? pnlClass(brok.dayGain) : 'text-muted-foreground/50'}`}>
                    {brok.hasDayGain ? (brok.dayGain >= 0 ? '+' : '') + fmtCAD(brok.dayGain) : '—'}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono text-sm font-medium ${brok.hasDayGain && brok.totalSecurities > 0 ? pnlClass(brok.dayGain) : 'text-muted-foreground/50'}`}>
                    {brok.hasDayGain && brok.totalSecurities > 0 ? fmtPct(brok.dayGain / brok.totalSecurities * 100) : '—'}
                  </td>
                  <td className={`px-4 py-1.5 text-right font-mono text-sm font-medium ${brok.hasPrices ? pnlClass(brok.pnl) : 'text-muted-foreground'}`}>
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
                        className={`border-t border-border bg-card ${isPaired ? 'cursor-pointer hover:bg-primary/5' : 'hover:bg-accent/60'}`}
                      >
                        <td className="px-4 py-2 pl-10 text-foreground">
                          <span className="inline-flex items-center gap-2">
                            {isPaired && (grpOpen
                              ? <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                              : <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />)}
                            <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium whitespace-nowrap">
                              {acct.account_type}
                            </span>
                            {acct.account_name}
                            {isPaired && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium">CAD+USD</span>
                            )}
                            <span
                              onClick={e => { e.stopPropagation(); goToAccountHoldings(acct.account_id) }}
                              className="text-muted-foreground/50 hover:text-primary"
                              title="View in Holdings"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </span>
                          </span>
                        </td>
                        <td></td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground text-xs">{fmtCAD(acct.book_value)}</td>
                        <td className="px-3 py-2 text-right font-mono text-foreground text-xs">
                          {acct.securities > 0 ? fmtCAD(acct.securities) : '—'}
                          {acct.hasFallback && <span className="text-amber-500 dark:text-amber-400 ml-0.5" title="Valued at cost">*</span>}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono text-xs ${acct.cash < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                          {fmtCAD(acct.cash)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-primary text-xs">{fmtCAD(acct.total)}</td>
                        <td className={`px-3 py-2 text-right font-mono text-xs font-medium ${acct.hasDayGain ? pnlClass(acct.dayGain) : 'text-muted-foreground/50'}`}>
                          {acct.hasDayGain ? (acct.dayGain >= 0 ? '+' : '') + fmtCAD(acct.dayGain) : '—'}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono text-xs font-medium ${acct.hasDayGain && acct.securities > 0 ? pnlClass(acct.dayGain) : 'text-muted-foreground/50'}`}>
                          {acct.hasDayGain && acct.securities > 0 ? fmtPct(acct.dayGain / acct.securities * 100) : '—'}
                        </td>
                        <td className={`px-4 py-2 text-right font-mono text-xs font-medium ${acct.hasPrices ? pnlClass(acct.pnl) : 'text-muted-foreground'}`}>
                          {acct.hasPrices ? (acct.pnl >= 0 ? '+' : '') + fmtCAD(acct.pnl) : '—'}
                        </td>
                      </tr>

                      {/* Sub-account rows (CAD + USD legs when group is expanded) */}
                      {isPaired && grpOpen && acct.subAccounts!.map(sub => {
                        const isUSD = sub.base_currency === 'USD'
                        const rate  = usdCadRate ?? 1
                        return (
                          <tr key={sub.account_id} className="border-t border-border/60 bg-card hover:bg-accent/60">
                            <td className="px-4 py-1.5 pl-16 text-muted-foreground text-xs">
                              <span className="inline-flex items-center gap-2">
                                <span className={`px-1.5 py-0.5 rounded font-medium ${isUSD ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-accent text-muted-foreground'}`}>
                                  {sub.base_currency}
                                </span>
                                {sub.account_name}
                              </span>
                            </td>
                            <td></td>
                            <td className="px-3 py-1.5 text-right font-mono text-muted-foreground text-xs">
                              {isUSD ? fmtUSD(sub.book_value / rate) : fmtCAD(sub.book_value)}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono text-xs text-foreground">
                              {sub.securities > 0
                                ? isUSD ? <>{fmtUSD(sub.securities / rate)}<span className="text-muted-foreground ml-1">= {fmtCAD(sub.securities)}</span></> : fmtCAD(sub.securities)
                                : '—'}
                              {sub.hasFallback && <span className="text-amber-500 dark:text-amber-400 ml-0.5">*</span>}
                            </td>
                            <td className={`px-3 py-1.5 text-right font-mono text-xs ${sub.cash < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                              {isUSD
                                ? <>{fmtUSD(sub.cash / rate)}<span className="text-muted-foreground ml-1">= {fmtCAD(sub.cash)}</span></>
                                : fmtCAD(sub.cash)}
                            </td>
                            <td className="px-3 py-1.5 text-right font-mono text-xs font-semibold text-primary">
                              {isUSD
                                ? <>{fmtUSD(sub.total / rate)}<span className="text-muted-foreground ml-1">= {fmtCAD(sub.total)}</span></>
                                : fmtCAD(sub.total)}
                            </td>
                            <td className={`px-3 py-1.5 text-right font-mono text-xs ${sub.hasDayGain ? pnlClass(sub.dayGain) : 'text-muted-foreground/50'}`}>
                              {sub.hasDayGain ? (sub.dayGain >= 0 ? '+' : '') + fmtCAD(sub.dayGain) : '—'}
                            </td>
                            <td className={`px-3 py-1.5 text-right font-mono text-xs ${sub.hasDayGain && sub.securities > 0 ? pnlClass(sub.dayGain) : 'text-muted-foreground/50'}`}>
                              {sub.hasDayGain && sub.securities > 0 ? fmtPct(sub.dayGain / sub.securities * 100) : '—'}
                            </td>
                            <td className={`px-4 py-1.5 text-right font-mono text-xs ${sub.hasPrices ? pnlClass(sub.pnl) : 'text-muted-foreground'}`}>
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
          <tr className="border-t-2 border-border bg-muted/50 font-semibold text-sm">
            <td className="px-4 py-1.5 text-foreground">Total</td>
            <td></td>
            <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">{fmtCAD(data.reduce((s, b) => s + b.totalBook, 0))}</td>
            <td className="px-3 py-1.5 text-right font-mono text-foreground">{fmtCAD(data.reduce((s, b) => s + b.totalSecurities, 0))}</td>
            <td className={`px-3 py-1.5 text-right font-mono ${data.reduce((s, b) => s + b.totalCash, 0) < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
              {fmtCAD(data.reduce((s, b) => s + b.totalCash, 0))}
            </td>
            <td className="px-3 py-1.5 text-right font-mono text-primary">{fmtCAD(data.reduce((s, b) => s + b.total, 0))}</td>
            {(() => {
              const totalDG = data.reduce((s, b) => s + b.dayGain, 0)
              const hasDG   = data.some(b => b.hasDayGain)
              const totSec  = data.reduce((s, b) => s + b.totalSecurities, 0)
              return (
                <>
                  <td className={`px-3 py-1.5 text-right font-mono ${hasDG ? pnlClass(totalDG) : 'text-muted-foreground/50'}`}>
                    {hasDG ? (totalDG >= 0 ? '+' : '') + fmtCAD(totalDG) : '—'}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${hasDG && totSec > 0 ? pnlClass(totalDG) : 'text-muted-foreground/50'}`}>
                    {hasDG && totSec > 0 ? fmtPct(totalDG / totSec * 100) : '—'}
                  </td>
                </>
              )
            })()}
            <td className={`px-4 py-1.5 text-right font-mono ${pnlClass(data.filter(b => b.hasPrices).reduce((s, b) => s + b.pnl, 0))}`}>
              {data.some(b => b.hasPrices)
                ? (() => { const p = data.filter(b => b.hasPrices).reduce((s, b) => s + b.pnl, 0); return (p >= 0 ? '+' : '') + fmtCAD(p) })()
                : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
      {data.some(b => b.hasFallback) && (
        <p className="px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border-t border-amber-500/20">
          * Valued at cost — no market price available for these positions
        </p>
      )}
      {usdCadRate && (
        <p className="px-4 py-1.5 text-xs text-muted-foreground bg-muted/50 border-t border-border">
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
  const { toDate, fromDate, timeRange } = useFilterContext()
  // Subscribed only so this component (and its children) re-render when the header's
  // eye-icon toggle flips — fmtCAD/fmtUSD read the pref directly via getPref().
  usePreference('hideValues')

  // Data queries
  const { data: rawAccounts = [], isLoading: accountsLoading } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const { data: positions    = [] } = useQuery({ queryKey: ['positions', toDate],       queryFn: () => getPositions({ as_of: toDate }) })
  const { data: cashBalances = [] } = useQuery({ queryKey: ['cash-balances', toDate],   queryFn: () => getCashBalances({ as_of: toDate }) })
  const { data: imports      = [] } = useQuery({ queryKey: ['imports'],                queryFn: getImports })
  const { data: personalAssets = [] } = useQuery({ queryKey: ['personal-assets'],       queryFn: getPersonalAssets })

  const accounts = rawAccounts as Account[]

  // Global account filter
  const { effectiveAccountIds, hasFilter } = usePortfolioFilters(accounts)

  const filteredPositions = useMemo(() => {
    if (accountsLoading) return []
    return effectiveAccountIds.size > 0
      ? (positions as Position[]).filter(p => effectiveAccountIds.has(p.account_id))
      : (positions as Position[])
  }, [positions, effectiveAccountIds, accountsLoading])

  // Personal assets/liabilities (real estate, life insurance, other, mortgages) share the
  // same Security/Position pipeline as everything else, but are kept out of the existing
  // "Total Value" investment figure — that number should keep meaning exactly what it always
  // has. They get their own Net Worth breakout below instead.
  const investmentPositions = useMemo(
    () => filteredPositions.filter(p => !PERSONAL_ASSET_CLASSES.has(p.asset_class)),
    [filteredPositions],
  )
  const personalAssetPositions = useMemo(
    () => filteredPositions.filter(p => PERSONAL_ASSET_CLASSES.has(p.asset_class)),
    [filteredPositions],
  )

  // Crypto is a normal investment position (held at a real exchange like Coinsquare), but
  // the Overview page shows it as its own group rather than nested under its brokerage —
  // pull it out of the brokerage/account table's input, not out of "Total"/net worth math.
  const traditionalInvestmentPositions = useMemo(
    () => investmentPositions.filter(p => p.asset_class !== 'CRYPTO'),
    [investmentPositions],
  )
  const cryptoPositions = useMemo(
    () => investmentPositions.filter(p => p.asset_class === 'CRYPTO'),
    [investmentPositions],
  )

  // ── Other Assets/Liabilities groups (Real Estate / Insurance / Other) ─────
  // A linked liability nets into its linked asset's group; an unlinked liability falls
  // into Other. Uses the /personal-assets list (not `positions`) since it already carries
  // linked_security_id/linked_name/current_value_cad in one place.
  interface AssetGroup { title: string; items: AssetGroupItem[]; total: number }

  const otherAssetsGroups = useMemo(() => {
    const byId = new Map(personalAssets.map(a => [a.security_id, a]))
    const claimedLiabilityIds = new Set<number>()
    const valueOf = (a: PersonalAsset) => a.current_value_cad ? parseFloat(a.current_value_cad) : 0

    // A linked liability may point AT this asset (liability.linked_security_id === asset.id)
    // or the asset may point AT the liability (asset.linked_security_id === liability.id) —
    // the create/edit form only ever sets the link on one side, so both directions must be
    // checked (mirrors the backend's _find_linked_name, which does the same both-ways check).
    const buildGroup = (title: string, assetClass: PersonalAssetClass): AssetGroup => {
      const items: AssetGroupItem[] = []
      for (const a of personalAssets) {
        if (a.asset_class !== assetClass) continue
        items.push({ security_id: a.security_id, name: a.name || a.ticker, value: valueOf(a), isLiability: false })

        let linked: PersonalAsset | undefined
        if (a.linked_security_id) {
          linked = byId.get(a.linked_security_id)
        }
        if (!linked || linked.asset_class !== 'LIABILITY') {
          linked = personalAssets.find(other => other.asset_class === 'LIABILITY' && other.linked_security_id === a.security_id)
        }
        if (linked && linked.asset_class === 'LIABILITY') {
          claimedLiabilityIds.add(linked.security_id)
          items.push({ security_id: linked.security_id, name: linked.name || linked.ticker, value: valueOf(linked), isLiability: true })
        }
      }
      return { title, items, total: items.reduce((s, i) => s + i.value, 0) }
    }

    const realEstate  = buildGroup('Real Estate', 'REAL_ESTATE')
    const insurance    = buildGroup('Insurance', 'LIFE_INSURANCE')
    const otherBase    = buildGroup('Other', 'OTHER_ASSET')
    const unclaimedLiabilities = personalAssets.filter(
      a => a.asset_class === 'LIABILITY' && !claimedLiabilityIds.has(a.security_id),
    )
    const other: AssetGroup = {
      title: 'Other',
      items: [
        ...otherBase.items,
        ...unclaimedLiabilities.map(a => ({ security_id: a.security_id, name: a.name || a.ticker, value: valueOf(a), isLiability: true })),
      ],
      total: otherBase.total + unclaimedLiabilities.reduce((s, a) => s + valueOf(a), 0),
    }

    return { realEstate, insurance, other }
  }, [personalAssets])

  // Real Estate gets its own book-value/total-value/gain table (rather than the generic
  // item list used by Crypto/Insurance/Other) — same asset+liability pairing as buildGroup
  // above, but carrying purchase_price through for the Gain column and inserting a
  // Subtotal row under a linked pair.
  const realEstateRows = useMemo(() => {
    const byId = new Map(personalAssets.map(a => [a.security_id, a]))
    const rows: RealEstateRow[] = []
    for (const a of personalAssets) {
      if (a.asset_class !== 'REAL_ESTATE') continue
      const totalValue = a.current_value_cad ? parseFloat(a.current_value_cad) : 0
      const bookValue  = a.purchase_price ? parseFloat(a.purchase_price) : null
      rows.push({
        key: `a${a.security_id}`, kind: 'asset', name: a.name || a.ticker,
        bookValue, totalValue, gain: bookValue != null ? totalValue - bookValue : null,
      })

      let linked: PersonalAsset | undefined
      if (a.linked_security_id) linked = byId.get(a.linked_security_id)
      if (!linked || linked.asset_class !== 'LIABILITY') {
        linked = personalAssets.find(o => o.asset_class === 'LIABILITY' && o.linked_security_id === a.security_id)
      }
      if (linked && linked.asset_class === 'LIABILITY') {
        const liabTotal = linked.current_value_cad ? parseFloat(linked.current_value_cad) : 0   // already negative
        rows.push({ key: `l${linked.security_id}`, kind: 'liability', name: linked.name || linked.ticker, bookValue: null, totalValue: liabTotal, gain: null })
        rows.push({ key: `s${a.security_id}`, kind: 'subtotal', name: 'Subtotal', bookValue: null, totalValue: totalValue + liabTotal, gain: null })
      }
    }
    return rows
  }, [personalAssets])

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

  const [indicatorCountry, setIndicatorCountry] = useState<'CA' | 'US'>('CA')
  const { data: indicators = [] } = useQuery({
    queryKey: ['market-indicators', indicatorCountry],
    queryFn: () => getMarketIndicators(indicatorCountry),
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

  // Return for the header's selected time range — aggregates the same Modified Dietz
  // numerator/denominator the Performance page uses, just parameterized by fromDate/toDate
  // instead of hardcoded YTD/1Y.
  const { data: returnsDetail = [] } = useQuery({
    queryKey: ['returns-detail', metricsAccountIds, fromDate, toDate],
    queryFn: () => getReturnsDetail({ from_date: fromDate, to_date: toDate, account_ids: metricsAccountIds ?? undefined }),
    enabled: metricsAccountIds !== null,   // wait until accounts have loaded
    staleTime: 5 * 60 * 1000,
  })

  // ── Sparklines (Net Worth headline + per-brokerage rows) ──────────────────
  // Reuses the same pre-computed snapshot timeline the Performance chart is built from —
  // group_by=total gives one "Total" series for the headline trend, group_by=brokerage
  // gives every brokerage's value history in a single call (no N+1 per row).
  const { data: netWorthTimeline } = useQuery({
    queryKey: ['portfolio-timeline-total', metricsAccountIds, fromDate, toDate],
    queryFn: () => getPortfolioTimeline({ group_by: 'total', from_date: fromDate, to_date: toDate, account_ids: metricsAccountIds ?? undefined }),
    enabled: metricsAccountIds !== null,
    staleTime: 5 * 60 * 1000,
  })
  const netWorthSpark = useMemo(
    () => netWorthTimeline?.points.map(p => Object.values(p.values).reduce((s, v) => s + v, 0)) ?? [],
    [netWorthTimeline],
  )

  const { data: brokerageTimeline } = useQuery({
    queryKey: ['portfolio-timeline-brokerage', metricsAccountIds, fromDate, toDate],
    queryFn: () => getPortfolioTimeline({ group_by: 'brokerage', from_date: fromDate, to_date: toDate, account_ids: metricsAccountIds ?? undefined }),
    enabled: metricsAccountIds !== null,
    staleTime: 5 * 60 * 1000,
  })
  const brokerageSparklines = useMemo(() => {
    const out: Record<string, number[]> = {}
    if (!brokerageTimeline) return out
    for (const label of brokerageTimeline.series_labels) {
      out[label] = brokerageTimeline.points.map(p => p.values[label] ?? 0)
    }
    return out
  }, [brokerageTimeline])

  const pendingImports = imports.filter((i: { status: string }) => i.status === 'PENDING')

  // ── Summary totals (with no-price fallback) ───────────────────────────────
  // Investment-only (excludes personal assets/liabilities) — "Total Value" keeps meaning
  // exactly what it always has; personal assets/liabilities get their own card below.
  const { totalSecurities, fallbackCount } = useMemo(() => {
    let securities = 0, fallback = 0
    for (const p of investmentPositions) {
      if (p.market_value_cad) { securities += parseFloat(p.market_value_cad) }
      else { securities += parseFloat(p.total_acb_cad || '0'); fallback++ }
    }
    return { totalSecurities: securities, fallbackCount: fallback }
  }, [investmentPositions])

  const totalCash  = filteredCash.reduce((s, c) => s + parseFloat(c.balance_cad || '0'), 0)
  const totalValue = totalSecurities + totalCash

  const { returnGain, returnPct, hasReturn } = useMemo(() => {
    if (!returnsDetail.length) return { returnGain: 0, returnPct: null as number | null, hasReturn: false }
    const gain  = returnsDetail.reduce((s, r) => s + r.total_gain, 0)
    const denom = returnsDetail.reduce((s, r) => s + r.md_denominator, 0)
    return { returnGain: gain, returnPct: denom > 0 ? (gain / denom) * 100 : null, hasReturn: true }
  }, [returnsDetail])

  // ── Net worth breakout (personal assets/liabilities) ──────────────────────
  const { totalPersonalAssets, totalLiabilities } = useMemo(() => {
    let assets = 0, liabilities = 0
    for (const p of personalAssetPositions) {
      const mv = parseFloat(p.market_value_cad || p.total_acb_cad || '0')
      if (p.asset_class === 'LIABILITY') liabilities += mv   // already negative
      else assets += mv
    }
    return { totalPersonalAssets: assets, totalLiabilities: liabilities }
  }, [personalAssetPositions])
  const netWorth = totalValue + totalPersonalAssets + totalLiabilities

  const cryptoTotal = useMemo(
    () => cryptoPositions.reduce((s, p) => s + parseFloat(p.market_value_cad || p.total_acb_cad || '0'), 0),
    [cryptoPositions],
  )

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

    for (const p of traditionalInvestmentPositions) {
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
  }, [traditionalInvestmentPositions, filteredCash, accounts])

  // General Market news follows the same country toggle as the ticker bar above, so
  // switching Canada/US changes both.
  const marketNewsQ = useQuery({
    queryKey: ['market-news', indicatorCountry],
    queryFn: () => getMarketNews(indicatorCountry),
    staleTime: 15 * 60 * 1000,
  })
  const topStoriesQ = useQuery({
    queryKey: ['top-stories'],
    queryFn: getTopStories,
    staleTime: 15 * 60 * 1000,
  })
  const portfolioNewsQ = useQuery({
    queryKey: ['portfolio-news'],
    queryFn: getPortfolioNews,
    staleTime: 15 * 60 * 1000,
  })

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Market Indicators bar ── */}
      <div className="bg-gray-900 rounded-xl overflow-x-auto">
        <div className="flex items-center gap-0 min-w-max px-2 py-1.5">
          {/* Canada / US Markets toggle — mirrors Yahoo Finance's country switch */}
          <div className="flex items-center gap-0.5 bg-gray-800 rounded-md p-0.5 mr-2 flex-shrink-0">
            {(['CA', 'US'] as const).map(c => (
              <button
                key={c}
                onClick={() => setIndicatorCountry(c)}
                className={`px-2 py-1 text-xs font-medium rounded whitespace-nowrap transition-colors ${
                  indicatorCountry === c ? 'bg-gray-600 text-white' : 'text-muted-foreground hover:text-muted-foreground/30'
                }`}
              >
                {c === 'CA' ? 'Canada' : 'US Markets'}
              </button>
            ))}
          </div>
          {(indicators as MarketIndicator[]).map(ind => {
            const isUp = ind.day_change_pct != null && ind.day_change_pct > 0
            const isDown = ind.day_change_pct != null && ind.day_change_pct < 0
            const pctStr = ind.day_change_pct != null
              ? (ind.day_change_pct > 0 ? '+' : '') + ind.day_change_pct.toFixed(2) + '%'
              : '—'
            const priceStr = ind.price != null
              ? ind.symbol === 'CADUSD=X'
                ? ind.price.toFixed(4)
                : ind.symbol.startsWith('BTC-')
                  ? ind.price.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : ind.price >= 1000
                    ? ind.price.toLocaleString('en', { maximumFractionDigits: 0 })
                    : ind.price.toFixed(2)
              : '—'
            return (
              <div key={ind.symbol} className="flex items-center gap-2 px-3 py-1 border-r border-border last:border-0">
                <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">{ind.label}</span>
                <span className="text-xs font-semibold text-white whitespace-nowrap">{priceStr}</span>
                <span className={`text-xs font-medium whitespace-nowrap ${isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-muted-foreground'}`}>
                  {pctStr}
                </span>
              </div>
            )
          })}
          {(indicators as MarketIndicator[]).length === 0 && (
            <span className="text-xs text-muted-foreground px-3 py-1">Loading market data…</span>
          )}
        </div>
      </div>

      {pendingImports.length > 0 && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 flex items-center gap-3">
          <span className="text-yellow-700 dark:text-yellow-400 font-medium">
            {pendingImports.length} import batch{pendingImports.length > 1 ? 'es' : ''} pending review
          </span>
          <a href="/import" className="text-sm text-yellow-700 dark:text-yellow-400 underline">Review now</a>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      <div className="lg:col-span-2 space-y-6">
      {/* ── Summary bar ── */}
      <div className="bg-primary/10 border border-primary/20 rounded-xl px-4 py-4 md:px-6 shadow-sm">
        {/* ── Mobile: Net Worth hero + 2-col grid ── */}
        <div className="md:hidden">
          <div className="text-center pb-3 mb-3 border-b border-primary/20">
            <div className="text-xs text-primary/70 uppercase tracking-wide">Net Worth</div>
            <div className="text-3xl font-bold text-foreground">{fmtCAD(netWorth)}</div>
            {netWorthSpark.length > 1 && (
              <div className="flex justify-center mt-1">
                <Sparkline data={netWorthSpark} width={120} height={28} />
              </div>
            )}
            <div className="text-[11px] text-primary/60 mt-0.5">{investmentPositions.length} positions · {allAcctIds.length} accounts</div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <div>
              <div className="text-[11px] text-primary/70 uppercase tracking-wide">
                Securities{fallbackCount > 0 && <span className="ml-1 text-amber-500 dark:text-amber-400">*</span>}
              </div>
              <div className="text-lg font-bold text-foreground">{fmtCAD(totalSecurities)}</div>
            </div>
            <div>
              <div className="text-[11px] text-primary/70 uppercase tracking-wide">Cash</div>
              <div className={`text-lg font-bold ${totalCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>{fmtCAD(totalCash)}</div>
            </div>
            <div>
              <div className="text-[11px] text-primary/70 uppercase tracking-wide">Other Assets</div>
              <div className="text-lg font-bold text-foreground">{fmtCAD(totalPersonalAssets)}</div>
            </div>
            <div>
              <div className="text-[11px] text-primary/70 uppercase tracking-wide">Liabilities</div>
              <div className={`text-lg font-bold ${totalLiabilities < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>{fmtCAD(totalLiabilities)}</div>
            </div>
            {hasReturn && (
              <div className="col-span-2">
                <div className="text-[11px] text-primary/70 uppercase tracking-wide">Return ({TIME_RANGE_LABEL[timeRange]})</div>
                <div className={`text-lg font-bold flex items-center gap-1 ${returnPct != null ? pnlClass(returnPct) : 'text-muted-foreground'}`}>
                  {returnPct != null && (returnPct >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />)}
                  {returnPct != null ? fmtPct(returnPct) : '—'}
                  <span className="text-sm font-medium text-primary/60">
                    ({(returnGain >= 0 ? '+' : '') + fmtCAD(returnGain)})
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Desktop: flex-wrap metrics row ── */}
        <div className="hidden md:flex md:flex-wrap md:items-center md:gap-x-6 md:gap-y-3">
          <div>
            <div className="text-xs text-primary/70 uppercase tracking-wide">
              Securities
              {fallbackCount > 0 && <span className="ml-1 text-amber-500 dark:text-amber-400" title={`${fallbackCount} position(s) valued at cost`}>*</span>}
            </div>
            <div className="text-lg md:text-xl font-bold text-foreground">{fmtCAD(totalSecurities)}</div>
          </div>
          <div>
            <div className="text-xs text-primary/70 uppercase tracking-wide">Cash</div>
            <div className={`text-lg md:text-xl font-bold ${totalCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>{fmtCAD(totalCash)}</div>
          </div>
          <div>
            <div className="text-xs text-primary/70 uppercase tracking-wide">Other Assets</div>
            <div className="text-lg md:text-xl font-bold text-foreground">{fmtCAD(totalPersonalAssets)}</div>
          </div>
          <div>
            <div className="text-xs text-primary/70 uppercase tracking-wide">Liabilities</div>
            <div className={`text-lg md:text-xl font-bold ${totalLiabilities < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>{fmtCAD(totalLiabilities)}</div>
          </div>
          <div className="md:border-l md:border-primary/20 md:pl-6 flex items-center gap-3">
            <div>
              <div className="text-xs text-primary/70 uppercase tracking-wide">Net Worth</div>
              <div className="text-xl md:text-2xl font-bold text-foreground">{fmtCAD(netWorth)}</div>
            </div>
            {netWorthSpark.length > 1 && <Sparkline data={netWorthSpark} width={90} height={30} />}
          </div>
          {hasReturn && (
            <div>
              <div className="text-xs text-primary/70 uppercase tracking-wide">Return ({TIME_RANGE_LABEL[timeRange]})</div>
              <div className={`text-lg md:text-xl font-bold flex items-center gap-1 ${returnPct != null ? pnlClass(returnPct) : 'text-muted-foreground'}`}>
                {returnPct != null && (returnPct >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />)}
                {returnPct != null ? fmtPct(returnPct) : '—'}
              </div>
              <div className="text-xs font-medium text-primary/60">
                {(returnGain >= 0 ? '+' : '') + fmtCAD(returnGain)}
              </div>
            </div>
          )}
          <div className="ml-auto text-right">
            <div className="text-xs text-primary/60">{investmentPositions.length} positions</div>
            <div className="text-xs text-primary/60">{allAcctIds.length} accounts</div>
          </div>
        </div>
        {fallbackCount > 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            * {fallbackCount} position{fallbackCount !== 1 ? 's' : ''} valued at cost — no market price available
          </p>
        )}
      </div>

      {/* ── Brokerages ── */}
      <BrokerageSummary data={brokerageSummary} usdCadRate={usdCadRate} sparklines={brokerageSparklines} />

      {/* ── Crypto ── */}
      {cryptoPositions.length > 0 && (
        <AssetGroupSummary
          title="Crypto"
          total={cryptoTotal}
          items={cryptoPositions.map(p => ({
            security_id: p.security_id,
            name: p.security_name || p.ticker,
            value: parseFloat(p.market_value_cad || p.total_acb_cad || '0'),
            isLiability: false,
          }))}
        />
      )}

      {/* ── Other Assets/Liabilities: Real Estate / Insurance / Other ── */}
      {realEstateRows.length > 0 && (
        <RealEstateTable rows={realEstateRows} total={otherAssetsGroups.realEstate.total} />
      )}
      {otherAssetsGroups.insurance.items.length > 0 && (
        <AssetGroupSummary title="Insurance" total={otherAssetsGroups.insurance.total} items={otherAssetsGroups.insurance.items} />
      )}
      {otherAssetsGroups.other.items.length > 0 && (
        <AssetGroupSummary title="Other Assets/Liabilities" total={otherAssetsGroups.other.total} items={otherAssetsGroups.other.items} />
      )}
      </div>

      {/* ── News ── */}
      <div className="bg-card rounded-xl border border-border p-5 shadow-sm space-y-6">
        <div>
          <h2 className="font-semibold text-foreground mb-4">
            General Market <span className="text-muted-foreground font-normal text-sm">· {indicatorCountry === 'CA' ? 'Canada' : 'US Markets'}</span>
          </h2>
          <NewsList
            items={marketNewsQ.data?.items}
            isLoading={marketNewsQ.isLoading}
            emptyMessage="No market news available."
            compact
            columns={1}
          />
        </div>

        <div className="pt-6 border-t border-border">
          <h2 className="font-semibold text-foreground mb-1">Top Stories</h2>
          <p className="text-xs text-muted-foreground mb-3">Covered by multiple outlets at once — the biggest stories moving markets right now.</p>
          <NewsList
            items={topStoriesQ.data?.items}
            isLoading={topStoriesQ.isLoading}
            emptyMessage="No standout stories right now."
            compact
            columns={1}
          />
        </div>

        <div className="pt-6 border-t border-border">
          <h2 className="font-semibold text-foreground mb-1">Your Portfolio</h2>
          <p className="text-xs text-muted-foreground mb-3">News for today's biggest movers among your holdings.</p>
          <NewsList
            items={portfolioNewsQ.data?.items}
            isLoading={portfolioNewsQ.isLoading}
            emptyMessage="No news for your current holdings."
            compact
            columns={1}
          />
        </div>
      </div>
      </div>
    </div>
  )
}
