import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getScreenerStatus, seedScreenerUniverse, refreshScreenerUniverse, getScreenerResults,
  getScreenerSectors, getPriceJob, syncScreenerIndex,
} from '../api/client'
import type { ScreenerResult, IndexSyncResult } from '../api/client'
import { RefreshCw, Database, ChevronUp, ChevronDown, ChevronsUpDown, AlertTriangle, ListChecks } from 'lucide-react'
import TickerLink from './TickerLink'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

/** n is a ratio (0.0536 → "5.36%") */
function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return (n * 100).toFixed(decimals) + '%'
}

/** n is already a percentage (5.36 → "5.4%") */
function fmtPctRaw(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toFixed(decimals) + '%'
}

function fmtLarge(n: number | null | undefined): string {
  if (n == null) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T'
  if (abs >= 1e9)  return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  return n.toLocaleString()
}

function growthColor(n: number | null | undefined): string {
  if (n == null) return 'text-muted-foreground'
  return n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
}

// Display exchange for a row. After a fundamentals refresh this is a real, normalized code
// (NYSE, NASDAQ, TSX, TSX-V, AMEX…); for names not yet refreshed the exchange is null, so
// fall back to a currency-derived region so every row still reads as CA vs US.
function exchangeLabel(r: ScreenerResult): string {
  if (r.exchange) return r.exchange
  if (r.currency === 'CAD') return 'CA'
  if (r.currency === 'USD') return 'US'
  return '—'
}
// Canadian exchange codes (+ the CA fallback) → maple-leaf tint; everything else reads as US.
const _CA_EXCHANGES = new Set(['TSX', 'TSX-V', 'TSXV', 'CSE', 'NEO', 'CA'])
function isCanadian(r: ScreenerResult): boolean {
  return r.currency === 'CAD' || _CA_EXCHANGES.has((r.exchange ?? '').toUpperCase())
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc'
type SortCol = keyof ScreenerResult

function sortRows(rows: ScreenerResult[], col: SortCol, dir: SortDir): ScreenerResult[] {
  return [...rows].sort((a, b) => {
    const rawA = a[col]
    const rawB = b[col]
    if (rawA == null && rawB == null) return 0
    if (rawA == null) return 1
    if (rawB == null) return -1
    if (typeof rawA === 'number' && typeof rawB === 'number') {
      return dir === 'asc' ? rawA - rawB : rawB - rawA
    }
    const cmp = String(rawA).localeCompare(String(rawB), undefined, { sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

function SortTh({ label, col, sortCol, sortDir, onSort }: {
  label: string; col: SortCol; sortCol: SortCol; sortDir: SortDir; onSort: (c: SortCol) => void
}) {
  const active = sortCol === col
  return (
    <th
      onClick={() => onSort(col)}
      className="px-3 py-2.5 text-right cursor-pointer select-none hover:bg-accent whitespace-nowrap"
    >
      <span className="inline-flex items-center gap-1 justify-end w-full">
        {label}
        {active
          ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3 text-primary" /> : <ChevronDown className="h-3 w-3 text-primary" />)
          : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

interface Filters {
  sector: string
  exchange: string
  minPe: string; maxPe: string
  minDebtEquity: string; maxDebtEquity: string
  minRoe: string; maxRoe: string
  minRevGrowth: string; maxRevGrowth: string
  minDivYield: string; maxDivYield: string
  minMarketCapB: string
}

const EMPTY_FILTERS: Filters = {
  sector: '', exchange: '', minPe: '', maxPe: '', minDebtEquity: '', maxDebtEquity: '',
  minRoe: '', maxRoe: '', minRevGrowth: '', maxRevGrowth: '',
  minDivYield: '', maxDivYield: '', minMarketCapB: '',
}

function NumField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-background text-foreground w-full border border-border rounded px-2 py-1.5 text-sm"
      />
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FundamentalScreener() {
  const qc = useQueryClient()
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [sortCol, setSortCol] = useState<SortCol>('composite_score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [jobId, setJobId] = useState<string | null>(null)

  const { data: status } = useQuery({ queryKey: ['screener-status'], queryFn: getScreenerStatus, refetchInterval: 15_000 })
  const { data: sectors = [] } = useQuery({ queryKey: ['screener-sectors'], queryFn: getScreenerSectors })

  const { data: jobStatus } = useQuery({
    queryKey: ['screener-job', jobId],
    queryFn: () => getPriceJob(jobId!),
    enabled: !!jobId,
    refetchInterval: q => (q.state.data?.status === 'running' ? 3000 : false),
  })
  useEffect(() => {
    if (!jobStatus) return
    if (jobStatus.status === 'done' || jobStatus.status === 'error') {
      qc.invalidateQueries({ queryKey: ['screener-status'] })
      qc.invalidateQueries({ queryKey: ['screener-results'] })
      qc.invalidateQueries({ queryKey: ['screener-sectors'] })
      setJobId(null)
    }
  }, [jobStatus?.status])

  const seedMut = useMutation({
    mutationFn: seedScreenerUniverse,
    onSuccess: d => {
      qc.invalidateQueries({ queryKey: ['screener-status'] })
      if (d.job_id) setJobId(d.job_id)
    },
  })
  const refreshMut = useMutation({
    mutationFn: refreshScreenerUniverse,
    onSuccess: d => { if (d.job_id) setJobId(d.job_id) },
  })
  const [indexSync, setIndexSync] = useState<IndexSyncResult | null>(null)
  const syncMut = useMutation({
    mutationFn: syncScreenerIndex,
    onSuccess: d => { setIndexSync(d); qc.invalidateQueries({ queryKey: ['screener-status'] }) },
  })
  const isRefreshing = status?.refreshing || jobStatus?.status === 'running'

  const queryParams = useMemo(() => ({
    sector: filters.sector || undefined,
    min_pe: filters.minPe ? Number(filters.minPe) : undefined,
    max_pe: filters.maxPe ? Number(filters.maxPe) : undefined,
    min_debt_to_equity: filters.minDebtEquity ? Number(filters.minDebtEquity) : undefined,
    max_debt_to_equity: filters.maxDebtEquity ? Number(filters.maxDebtEquity) : undefined,
    min_roe_pct: filters.minRoe ? Number(filters.minRoe) : undefined,
    max_roe_pct: filters.maxRoe ? Number(filters.maxRoe) : undefined,
    min_revenue_growth_pct: filters.minRevGrowth ? Number(filters.minRevGrowth) : undefined,
    max_revenue_growth_pct: filters.maxRevGrowth ? Number(filters.maxRevGrowth) : undefined,
    min_dividend_yield_pct: filters.minDivYield ? Number(filters.minDivYield) : undefined,
    max_dividend_yield_pct: filters.maxDivYield ? Number(filters.maxDivYield) : undefined,
    min_market_cap: filters.minMarketCapB ? Number(filters.minMarketCapB) * 1e9 : undefined,
  }), [filters])

  const { data: rawResults = [], isLoading } = useQuery({
    queryKey: ['screener-results', queryParams],
    queryFn: () => getScreenerResults(queryParams),
    enabled: (status?.with_fundamentals ?? 0) > 0,
  })

  // Distinct exchange labels present, for the filter dropdown (client-side — results are all
  // loaded, so this is instant and needs no backend param).
  const exchangeOptions = useMemo(
    () => Array.from(new Set(rawResults.map(exchangeLabel))).filter(e => e !== '—').sort(),
    [rawResults],
  )
  const results = useMemo(() => {
    const filtered = filters.exchange
      ? rawResults.filter(r => exchangeLabel(r) === filters.exchange)
      : rawResults
    return sortRows(filtered, sortCol, sortDir)
  }, [rawResults, filters.exchange, sortCol, sortDir])

  const handleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortCol(col); setSortDir('desc') }
  }

  const lastFetched = status?.last_fetched_at ? new Date(status.last_fetched_at + 'Z').toLocaleString() : null
  const noUniverseYet = (status?.universe_size ?? 0) === 0
  const noDataYet = !noUniverseYet && (status?.with_fundamentals ?? 0) === 0

  return (
    <div className="space-y-5">
      {/* Status bar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="text-xs text-muted-foreground">
          {status
            ? <>
                <span className="font-medium text-muted-foreground">{status.universe_size.toLocaleString()}</span> stocks in universe
                {' · '}<span className="font-medium text-muted-foreground">{status.with_fundamentals.toLocaleString()}</span> with data
                {lastFetched && <> · updated {lastFetched}</>}
              </>
            : 'Loading…'}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {noUniverseYet && (
            <button
              onClick={() => seedMut.mutate()}
              disabled={seedMut.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-60 shadow-sm"
            >
              <Database className="h-4 w-4" />
              {seedMut.isPending ? 'Setting up…' : 'Set Up Screener Universe'}
            </button>
          )}
          {!noUniverseYet && (
            <>
              <button
                onClick={() => syncMut.mutate()}
                disabled={syncMut.isPending}
                title="Refresh S&P 500 / TSX 60 membership from the index lists — adds new constituents, drops departed ones (also runs automatically every quarter)"
                className="flex items-center gap-2 px-4 py-2 bg-card border border-border text-foreground text-sm font-medium rounded-lg hover:bg-muted/50 disabled:opacity-60 shadow-sm"
              >
                <ListChecks className={`h-4 w-4 ${syncMut.isPending ? 'animate-pulse' : ''}`} />
                {syncMut.isPending ? 'Syncing index…' : 'Sync Index'}
              </button>
              <button
                onClick={() => refreshMut.mutate()}
                disabled={isRefreshing || refreshMut.isPending}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-60 shadow-sm"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                {isRefreshing ? 'Refreshing…' : 'Refresh Data'}
              </button>
            </>
          )}
        </div>
      </div>

      {syncMut.isError && (
        <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>Index sync failed — the universe was left unchanged. {(syncMut.error as any)?.response?.data?.detail ?? 'Try again shortly.'}</div>
        </div>
      )}
      {indexSync && !syncMut.isPending && (
        <div className="flex items-start gap-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-lg px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
          <ListChecks className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            Index synced: <strong>{indexSync.us_constituents}</strong> S&amp;P 500 + <strong>{indexSync.ca_constituents}</strong> TSX 60.{' '}
            {indexSync.added_count === 0 && indexSync.dropped_count === 0
              ? 'No membership changes.'
              : <>
                  {indexSync.added_count > 0 && <>Added {indexSync.added_count}{indexSync.added.length ? ` (${indexSync.added.slice(0, 12).join(', ')}${indexSync.added.length > 12 ? '…' : ''})` : ''}. </>}
                  {indexSync.dropped_count > 0 && <>Dropped {indexSync.dropped_count}{indexSync.dropped.length ? ` (${indexSync.dropped.slice(0, 12).join(', ')}${indexSync.dropped.length > 12 ? '…' : ''})` : ''}.</>}
                </>}
            {' '}New names get their fundamentals on the next <strong>Refresh Data</strong>.
          </div>
        </div>
      )}

      {isRefreshing && (
        <div className="flex items-center gap-2 bg-primary/10 border border-primary/20 rounded-lg px-4 py-2.5 text-sm text-primary">
          <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
          Fetching data across the universe — this can take several minutes for {status?.universe_size ?? 'the full'} tickers…
        </div>
      )}

      {noUniverseYet && !seedMut.isPending && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground space-y-3">
          <Database className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium">Screener universe not set up yet</p>
          <p className="text-xs max-w-md text-center">
            Click <strong>Set Up Screener Universe</strong> to load a curated list of S&amp;P 500 + TSX 60
            tickers, then <strong>Refresh Data</strong> to fetch fundamentals for all of them.
          </p>
        </div>
      )}

      {noDataYet && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            Universe is set up but no fundamentals fetched yet. Click <strong>Refresh Data</strong> above to fetch them.
          </div>
        </div>
      )}

      {/* Filters */}
      {!noUniverseYet && (
        <div className="bg-card rounded-xl border border-border shadow-sm p-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Sector</label>
              <select
                value={filters.sector}
                onChange={e => setFilters(f => ({ ...f, sector: e.target.value }))}
                className="bg-background text-foreground w-full border border-border rounded px-2 py-1.5 text-sm"
              >
                <option value="">All sectors</option>
                {sectors.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Exchange</label>
              <select
                value={filters.exchange}
                onChange={e => setFilters(f => ({ ...f, exchange: e.target.value }))}
                className="bg-background text-foreground w-full border border-border rounded px-2 py-1.5 text-sm"
              >
                <option value="">All exchanges</option>
                {exchangeOptions.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
            <NumField label="Min P/E" value={filters.minPe} onChange={v => setFilters(f => ({ ...f, minPe: v }))} />
            <NumField label="Max P/E" value={filters.maxPe} onChange={v => setFilters(f => ({ ...f, maxPe: v }))} />
            <NumField label="Min Debt/Equity" value={filters.minDebtEquity} onChange={v => setFilters(f => ({ ...f, minDebtEquity: v }))} />
            <NumField label="Max Debt/Equity" value={filters.maxDebtEquity} onChange={v => setFilters(f => ({ ...f, maxDebtEquity: v }))} />
            <NumField label="Min ROE %" value={filters.minRoe} onChange={v => setFilters(f => ({ ...f, minRoe: v }))} />
            <NumField label="Min Revenue Growth %" value={filters.minRevGrowth} onChange={v => setFilters(f => ({ ...f, minRevGrowth: v }))} />
            <NumField label="Min Dividend Yield %" value={filters.minDivYield} onChange={v => setFilters(f => ({ ...f, minDivYield: v }))} />
            <NumField label="Min Market Cap ($B)" value={filters.minMarketCapB} onChange={v => setFilters(f => ({ ...f, minMarketCapB: v }))} />
            <div className="flex items-end">
              <button
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="text-xs text-muted-foreground hover:text-muted-foreground py-1.5"
              >
                Clear filters
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {!noUniverseYet && !noDataYet && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing <strong className="text-muted-foreground">{results.length.toLocaleString()}</strong> stocks</span>
            <span className="text-muted-foreground/50">Click any column to sort</span>
          </div>
          {isLoading
            ? <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" /></div>
            : (
              <div className="bg-card border border-border rounded-xl overflow-x-auto shadow-sm">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground uppercase tracking-wide">
                      <SortTh label="Score" col="composite_score" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="Ticker" col="ticker" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <th className="px-3 py-2.5 text-left">Exch</th>
                      <th className="px-3 py-2.5 text-left">Name</th>
                      <th className="px-3 py-2.5 text-left">Sector</th>
                      <SortTh label="Mkt Cap" col="market_cap" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="P/E" col="pe_ratio" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="D/E" col="debt_to_equity" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="ROE" col="return_on_equity" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="Rev Growth" col="revenue_growth" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="Div Yield" col="dividend_yield" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {results.map(r => (
                      <tr key={r.security_id} className="hover:bg-muted/50">
                        <td className="px-3 py-2 text-right">
                          {r.composite_score != null ? (
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold tabular-nums ${
                                r.composite_score >= 70 ? 'bg-emerald-100 text-emerald-700' :
                                r.composite_score >= 40 ? 'bg-primary/15 text-primary' :
                                                           'bg-accent text-muted-foreground'
                              }`}
                              title="Percentile-ranked composite of valuation (P/E, debt/equity), quality (ROE), growth (revenue growth), and dividend yield — 100 is best-in-universe on these metrics, 0 is worst. Missing metrics are excluded and remaining weights renormalized."
                            >
                              {r.composite_score.toFixed(0)}
                            </span>
                          ) : <span className="text-muted-foreground/50">—</span>}
                        </td>
                        <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">
                          <TickerLink securityId={r.security_id} ticker={r.ticker} className="text-foreground" />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            title={isCanadian(r) ? 'Canadian listing' : 'US listing'}
                            className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                              isCanadian(r)
                                ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                                : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                            }`}
                          >
                            {exchangeLabel(r)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground max-w-[220px] truncate" title={r.name ?? ''}>{r.name ?? '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.sector ?? '—'}</td>
                        <td className="px-3 py-2 text-right font-mono text-foreground">${fmtLarge(r.market_cap)}</td>
                        <td className="px-3 py-2 text-right font-mono text-foreground">{fmt(r.pe_ratio, 1)}</td>
                        <td className="px-3 py-2 text-right font-mono text-foreground">{fmt(r.debt_to_equity, 2)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${growthColor(r.return_on_equity)}`}>{fmtPct(r.return_on_equity)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${growthColor(r.revenue_growth)}`}>{fmtPct(r.revenue_growth)}</td>
                        <td className="px-3 py-2 text-right font-mono text-foreground">{fmtPctRaw(r.dividend_yield, 2)}</td>
                      </tr>
                    ))}
                    {results.length === 0 && (
                      <tr><td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">No stocks match these filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}
    </div>
  )
}
