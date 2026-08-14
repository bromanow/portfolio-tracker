import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import api, { getAccounts } from '../api/client'
import type { Account } from '../api/client'
import MultiSelectDropdown from '../components/MultiSelectDropdown'
import { getPref, usePreference } from '../hooks/usePreference'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ManagerRow {
  manager: string
  account_ids: number[]
  aum: number
  inception_date: string | null
  returns: Record<string, number | null>
  ann_returns: Record<string, number | null>
  volatility: number | null
  max_drawdown: number | null
  sharpe: number | null
  sortino: number | null
  calmar: number | null
  turnover: number | null
  commissions: number
  position_count: number
  asset_class_mix: Record<string, number>
  sector_mix: Record<string, number>
  country_mix: Record<string, number>
  currency_mix: Record<string, number>
  herfindahl_asset: number
  herfindahl_sector: number
}

type Period = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | 'inception'
type SortDir = 'asc' | 'desc'

// ─── Formatters ───────────────────────────────────────────────────────────────

const fmtCAD = (n: number | null | undefined) => {
  if (n == null) return '—'
  if (getPref('hideValues')) return '••••••'
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 0 }).format(n)
}
const fmtPct = (n: number | null | undefined, decimals = 2) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`
const fmtNum = (n: number | null | undefined, decimals = 2) =>
  n == null ? '—' : n.toFixed(decimals)

const pctColor = (n: number | null | undefined) =>
  n == null ? 'text-muted-foreground' : n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'

const ratioColor = (n: number | null | undefined) =>
  n == null ? 'text-muted-foreground' : n >= 1 ? 'text-emerald-600 dark:text-emerald-400' : n >= 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-500 dark:text-red-400'

// ─── Mini bar chart for mix breakdowns ────────────────────────────────────────

const MIX_COLORS = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#be185d','#65a30d']

function MixBar({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).slice(0, 6)
  if (!entries.length) return <span className="text-muted-foreground text-[10px]">—</span>
  return (
    <div className="space-y-0.5 min-w-[120px]">
      {entries.map(([label, pct], i) => (
        <div key={label} className="flex items-center gap-1.5">
          <div className="h-1.5 rounded-full" style={{ width: `${Math.max(pct, 2)}%`, maxWidth: '60px', background: MIX_COLORS[i % MIX_COLORS.length] }} />
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">{label} {pct.toFixed(0)}%</span>
        </div>
      ))}
    </div>
  )
}

// ─── Concentration badge ──────────────────────────────────────────────────────

function ConcentrationBadge({ hhi }: { hhi: number }) {
  const label = hhi >= 0.25 ? 'Concentrated' : hhi >= 0.15 ? 'Moderate' : 'Diversified'
  const cls = hhi >= 0.25
    ? 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400'
    : hhi >= 0.15
    ? 'bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400'
    : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{label}</span>
}

// ─── Trend icon ───────────────────────────────────────────────────────────────

function Trend({ v }: { v: number | null | undefined }) {
  if (v == null) return <Minus className="h-3 w-3 text-muted-foreground" />
  if (v >= 0) return <TrendingUp className="h-3 w-3 text-emerald-500" />
  return <TrendingDown className="h-3 w-3 text-red-500" />
}

// ─── Sortable header ──────────────────────────────────────────────────────────

function Th({ label, col, sortCol, sortDir, onSort, right = false, tooltip }: {
  label: string; col: string; sortCol: string; sortDir: SortDir
  onSort: (c: string) => void; right?: boolean; tooltip?: string
}) {
  const active = sortCol === col
  return (
    <th
      title={tooltip}
      onClick={() => onSort(col)}
      className={`px-3 py-2.5 text-xs font-semibold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:bg-accent/50 transition-colors ${right ? 'text-right' : 'text-left'} ${active ? 'text-primary' : 'text-muted-foreground'}`}
    >
      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
}

// ─── Detail panel (expanded row) ─────────────────────────────────────────────

function ManagerDetail({ row, period }: { row: ManagerRow; period: Period }) {
  const retVal = row.returns[period]
  const annVal = row.ann_returns[period]

  return (
    <tr>
      <td colSpan={99} className="px-4 pb-4 pt-0 bg-accent/30">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3">

          {/* Returns detail */}
          <div className="bg-card rounded-lg border border-border p-3 space-y-1.5">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Period Returns</div>
            {(['1M','3M','6M','YTD','1Y','3Y','inception'] as Period[]).map(p => (
              <div key={p} className="flex justify-between text-xs">
                <span className="text-muted-foreground">{p}</span>
                <span className="flex gap-3">
                  <span className={`font-medium ${pctColor(row.returns[p])}`}>{fmtPct(row.returns[p])}</span>
                  {row.ann_returns[p] != null && row.ann_returns[p] !== row.returns[p] && (
                    <span className={`text-[10px] ${pctColor(row.ann_returns[p])}`}>{fmtPct(row.ann_returns[p])} ann.</span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* Risk metrics */}
          <div className="bg-card rounded-lg border border-border p-3 space-y-1.5">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Risk Metrics</div>
            {[
              { label: 'Volatility (ann.)', val: row.volatility != null ? fmtPct(row.volatility, 1) : '—', note: 'Annualised std dev of daily returns' },
              { label: 'Max Drawdown', val: row.max_drawdown != null ? `-${row.max_drawdown.toFixed(1)}%` : '—', note: 'Worst peak-to-trough loss' },
              { label: 'Sharpe Ratio', val: fmtNum(row.sharpe), note: 'Ann. excess return / volatility (rf=4.5%)' },
              { label: 'Sortino Ratio', val: fmtNum(row.sortino), note: 'Ann. excess return / downside volatility' },
              { label: 'Calmar Ratio', val: fmtNum(row.calmar), note: 'Ann. return / max drawdown' },
            ].map(({ label, val, note }) => (
              <div key={label} className="flex justify-between text-xs" title={note}>
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium text-foreground">{val}</span>
              </div>
            ))}
          </div>

          {/* Portfolio composition */}
          <div className="bg-card rounded-lg border border-border p-3 space-y-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Portfolio Composition</div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Asset Class</span>
                <ConcentrationBadge hhi={row.herfindahl_asset} />
              </div>
              <MixBar data={row.asset_class_mix} />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Sector</span>
                <ConcentrationBadge hhi={row.herfindahl_sector} />
              </div>
              <MixBar data={row.sector_mix} />
            </div>
            <div className="flex gap-6">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Geography</div>
                <MixBar data={row.country_mix} />
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Currency</div>
                <MixBar data={row.currency_mix} />
              </div>
            </div>
          </div>
        </div>

        {/* Activity strip */}
        <div className="mt-3 flex flex-wrap gap-6 text-xs border-t border-border pt-3">
          <div><span className="text-muted-foreground">Positions: </span><span className="font-medium">{row.position_count}</span></div>
          <div><span className="text-muted-foreground">Turnover: </span><span className="font-medium">{row.turnover != null ? fmtPct(row.turnover, 1) : '—'}</span></div>
          <div><span className="text-muted-foreground">Total Commissions: </span><span className="font-medium">{fmtCAD(row.commissions)}</span></div>
          <div><span className="text-muted-foreground">Inception: </span><span className="font-medium">{row.inception_date ?? '—'}</span></div>
          <div><span className="text-muted-foreground">Managed Accounts: </span><span className="font-medium">{row.account_ids.length}</span></div>
        </div>
      </td>
    </tr>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ManagersTab() {
  usePreference('hideValues')

  const [period, setPeriod]   = useState<Period>('1Y')
  const [sortCol, setSortCol] = useState('aum')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Filters
  const [filterBrokerages, setFilterBrokerages] = useState<string[]>([])
  const [filterAccounts, setFilterAccounts]     = useState<string[]>([])

  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts(), staleTime: 60_000 })
  const allAccounts: Account[] = accountsQ.data ?? []

  const brokerageOptions = useMemo(() =>
    [...new Set(allAccounts.map(a => a.brokerage_name).filter(Boolean))].sort().map(b => ({ value: b!, label: b! })),
  [allAccounts])

  const accountOptions = useMemo(() =>
    allAccounts
      .filter(a => filterBrokerages.length === 0 || filterBrokerages.includes(a.brokerage_name!))
      .map(a => ({ value: String(a.id), label: a.name })),
  [allAccounts, filterBrokerages])

  const chartAccountIds = useMemo(() => {
    const matching = allAccounts.filter(a => {
      if (filterBrokerages.length > 0 && !filterBrokerages.includes(a.brokerage_name!)) return false
      if (filterAccounts.length > 0 && !filterAccounts.includes(String(a.id))) return false
      return true
    })
    return matching.map(a => a.id).join(',') || undefined
  }, [allAccounts, filterBrokerages, filterAccounts])

  const managersQ = useQuery({
    queryKey: ['perf-managers', chartAccountIds],
    queryFn: () => api.get<ManagerRow[]>('/portfolio/performance/managers', {
      params: chartAccountIds ? { account_ids: chartAccountIds } : {},
    }).then(r => r.data),
    staleTime: 5 * 60_000,
  })

  const rows = managersQ.data ?? []

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      let av: number | null = null
      let bv: number | null = null
      if (sortCol === 'aum') { av = a.aum; bv = b.aum }
      else if (sortCol === 'return') { av = a.returns[period]; bv = b.returns[period] }
      else if (sortCol === 'ann_return') { av = a.ann_returns[period]; bv = b.ann_returns[period] }
      else if (sortCol === 'volatility') { av = a.volatility; bv = b.volatility }
      else if (sortCol === 'max_drawdown') { av = a.max_drawdown; bv = b.max_drawdown }
      else if (sortCol === 'sharpe') { av = a.sharpe; bv = b.sharpe }
      else if (sortCol === 'sortino') { av = a.sortino; bv = b.sortino }
      else if (sortCol === 'calmar') { av = a.calmar; bv = b.calmar }
      else if (sortCol === 'turnover') { av = a.turnover; bv = b.turnover }
      else if (sortCol === 'commissions') { av = a.commissions; bv = b.commissions }
      else if (sortCol === 'positions') { av = a.position_count; bv = b.position_count }
      else if (sortCol === 'name') { return sortDir === 'asc' ? a.manager.localeCompare(b.manager) : b.manager.localeCompare(a.manager) }
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sortDir === 'asc' ? av - bv : bv - av
    })
    return copy
  }, [rows, sortCol, sortDir, period])

  const onSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const toggleExpand = (mgr: string) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(mgr) ? next.delete(mgr) : next.add(mgr)
    return next
  })

  // Summary stats
  const totalAUM    = rows.reduce((s, r) => s + r.aum, 0)
  const bestReturn  = rows.length ? rows.reduce((a, b) => (a.returns[period] ?? -Infinity) > (b.returns[period] ?? -Infinity) ? a : b) : null
  const worstReturn = rows.length ? rows.reduce((a, b) => (a.returns[period] ?? Infinity) < (b.returns[period] ?? Infinity) ? a : b) : null

  const PERIODS: Period[] = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', 'inception']

  return (
    <div className="space-y-4">

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectDropdown placeholder="All Brokerages" options={brokerageOptions} selected={filterBrokerages}
          onChange={v => { setFilterBrokerages(v); setFilterAccounts([]) }} />
        <MultiSelectDropdown placeholder="All Accounts" options={accountOptions} selected={filterAccounts}
          onChange={setFilterAccounts} disabled={accountOptions.length === 0} />

        <div className="ml-auto flex items-center gap-1 bg-accent rounded-lg p-0.5">
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-2.5 py-1.5 text-xs rounded-md font-medium transition-colors ${period === p ? 'bg-card shadow text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
              {p === 'inception' ? 'All' : p}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Total AUM', value: fmtCAD(totalAUM) },
            { label: 'Managers', value: String(rows.length) },
            { label: `Best ${period} Return`, value: bestReturn ? fmtPct(bestReturn.returns[period]) : '—', name: bestReturn?.manager, positive: true },
            { label: `Worst ${period} Return`, value: worstReturn ? fmtPct(worstReturn.returns[period]) : '—', name: worstReturn?.manager, positive: false },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs text-muted-foreground mb-0.5">{c.label}</div>
              <div className={`text-xl font-bold ${c.positive === true ? 'text-emerald-600' : c.positive === false ? 'text-red-500' : 'text-foreground'}`}>{c.value}</div>
              {c.name && <div className="text-xs text-muted-foreground mt-0.5">{c.name}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        {managersQ.isLoading && (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading manager analytics…</div>
        )}
        {!managersQ.isLoading && rows.length === 0 && (
          <div className="p-8 text-center text-muted-foreground text-sm">
            No portfolio managers assigned. Set a Portfolio Manager on accounts in Admin → Accounts.
          </div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm divide-y divide-border">
              <thead className="bg-muted/50">
                <tr>
                  <th className="w-8 px-2" />
                  <Th label="Manager" col="name" sortCol={sortCol} sortDir={sortDir} onSort={onSort} />
                  <Th label="AUM" col="aum" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                  <Th label={`${period} Return`} col="return" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                  <Th label="Ann. Return" col="ann_return" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right tooltip="Annualized return for the selected period" />
                  <Th label="Volatility" col="volatility" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right tooltip="Annualised std dev of daily returns" />
                  <Th label="Max DD" col="max_drawdown" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right tooltip="Maximum peak-to-trough drawdown" />
                  <Th label="Sharpe" col="sharpe" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right tooltip="(Ann. return − 4.5%) / Volatility" />
                  <Th label="Sortino" col="sortino" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right tooltip="(Ann. return − 4.5%) / Downside volatility" />
                  <Th label="Calmar" col="calmar" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right tooltip="Ann. return / Max drawdown" />
                  <Th label="Turnover" col="turnover" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right tooltip="min(buys, sells) / avg AUM" />
                  <Th label="Commissions" col="commissions" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                  <Th label="Positions" col="positions" sortCol={sortCol} sortDir={sortDir} onSort={onSort} right />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map(row => {
                  const isOpen = expanded.has(row.manager)
                  const ret = row.returns[period]
                  const annRet = row.ann_returns[period]
                  return (
                    <>
                      <tr
                        key={row.manager}
                        className="hover:bg-accent/40 cursor-pointer transition-colors"
                        onClick={() => toggleExpand(row.manager)}
                      >
                        <td className="px-2 py-3 text-muted-foreground">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="px-3 py-3 font-medium text-foreground whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <Trend v={ret} />
                            {row.manager}
                          </div>
                          <div className="text-[10px] text-muted-foreground">{row.account_ids.length} account{row.account_ids.length !== 1 ? 's' : ''}</div>
                        </td>
                        <td className="px-3 py-3 text-right font-semibold">{fmtCAD(row.aum)}</td>
                        <td className={`px-3 py-3 text-right font-semibold ${pctColor(ret)}`}>{fmtPct(ret)}</td>
                        <td className={`px-3 py-3 text-right ${pctColor(annRet)}`}>{fmtPct(annRet)}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{row.volatility != null ? fmtPct(row.volatility, 1) : '—'}</td>
                        <td className="px-3 py-3 text-right text-red-500">{row.max_drawdown != null ? `-${row.max_drawdown.toFixed(1)}%` : '—'}</td>
                        <td className={`px-3 py-3 text-right ${ratioColor(row.sharpe)}`}>{fmtNum(row.sharpe)}</td>
                        <td className={`px-3 py-3 text-right ${ratioColor(row.sortino)}`}>{fmtNum(row.sortino)}</td>
                        <td className={`px-3 py-3 text-right ${ratioColor(row.calmar)}`}>{fmtNum(row.calmar)}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{row.turnover != null ? fmtPct(row.turnover, 1) : '—'}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{fmtCAD(row.commissions)}</td>
                        <td className="px-3 py-3 text-right text-muted-foreground">{row.position_count}</td>
                      </tr>
                      {isOpen && <ManagerDetail key={`${row.manager}-detail`} row={row} period={period} />}
                    </>
                  )
                })}
              </tbody>

              {/* Totals row */}
              {sorted.length > 1 && (
                <tfoot className="bg-muted/50 border-t-2 border-border">
                  <tr className="text-xs font-semibold">
                    <td />
                    <td className="px-3 py-2.5 text-muted-foreground">{sorted.length} managers</td>
                    <td className="px-3 py-2.5 text-right">{fmtCAD(totalAUM)}</td>
                    <td colSpan={99} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="text-[10px] text-muted-foreground space-y-0.5">
        <div>Sharpe / Sortino / Calmar use 1Y annualized return (falls back to inception). Risk-free rate: 4.5% CAD.</div>
        <div>Volatility requires ≥ 20 days of snapshot history. Turnover = min(buys, sells) / average AUM.</div>
        <div>Concentration: Diversified (HHI &lt; 0.15) · Moderate (0.15–0.25) · Concentrated (&gt; 0.25).</div>
      </div>
    </div>
  )
}
