import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, TrendingUp, TrendingDown, ChevronDown, ChevronRight } from 'lucide-react'
import api from '../api/client'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Holding {
  ticker: string
  name: string
  sector: string
  asset_class: string
  currency: string
  start_value: number
  end_value: number
  weight: number       // % of portfolio at start
  price_return: number // %
  contribution: number // pct-pts of portfolio return
}

interface RollupRow {
  sector?: string
  asset_class?: string
  weight: number
  contribution: number
}

interface AttributionData {
  from_date: string
  to_date: string
  start_value: number
  end_value: number
  portfolio_return: number | null
  cash_weight: number
  cash_return: number
  cash_contribution: number
  total_contribution: number
  holdings: Holding[]
  sectors: RollupRow[]
  asset_classes: RollupRow[]
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const fmtPct = (n: number | null | undefined, decimals = 2) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`

const fmtCAD = (n: number | null | undefined) => {
  if (n == null) return '—'
  const abs = Math.abs(n)
  const fmt = abs >= 1e6 ? `$${(n / 1e6).toFixed(2)}M`
    : abs >= 1e3 ? `$${(n / 1e3).toFixed(0)}K`
    : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 0 }).format(n)
  return fmt
}

const pctColor = (n: number | null | undefined) =>
  n == null ? 'text-muted-foreground'
  : n > 0.05 ? 'text-emerald-600 dark:text-emerald-400'
  : n < -0.05 ? 'text-red-500 dark:text-red-400'
  : 'text-muted-foreground'

// Mini contribution bar (positive = green, negative = red)
function ContribBar({ value, max }: { value: number; max: number }) {
  if (max <= 0) return null
  const pct = Math.min(Math.abs(value) / max * 100, 100)
  return (
    <div className="flex items-center gap-1 min-w-[60px]">
      {value < 0 && <div className="h-2 rounded-sm bg-red-400 dark:bg-red-600" style={{ width: `${pct}%`, maxWidth: 60 }} />}
      {value >= 0 && <div className="h-2 rounded-sm bg-emerald-400 dark:bg-emerald-600" style={{ width: `${pct}%`, maxWidth: 60 }} />}
    </div>
  )
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

interface Props {
  accountName: string
  accountIds: number[]
  fromDate: string   // YYYY-MM-DD
  toDate: string     // YYYY-MM-DD
  onClose: () => void
}

type View = 'holdings' | 'sectors' | 'asset_classes'

export default function AttributionPanel({ accountName, accountIds, fromDate, toDate, onClose }: Props) {
  const [view, setView] = useState<View>('holdings')
  const [expandedSectors, setExpandedSectors] = useState<Set<string>>(new Set())
  const [sortCol, setSortCol] = useState<'weight' | 'price_return' | 'contribution'>('contribution')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const q = useQuery({
    queryKey: ['attribution', accountIds.join(','), fromDate, toDate],
    queryFn: () => api.get<AttributionData>('/portfolio/performance/attribution', {
      params: { from_date: fromDate, to_date: toDate, account_ids: accountIds.join(',') },
    }).then(r => r.data),
    staleTime: 5 * 60_000,
  })

  const data = q.data

  const maxContrib = useMemo(() => {
    if (!data) return 1
    return Math.max(...data.holdings.map(h => Math.abs(h.contribution)), 0.01)
  }, [data])

  const sortedHoldings = useMemo(() => {
    if (!data) return []
    const copy = [...data.holdings]
    copy.sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol]
      return sortDir === 'desc' ? bv - av : av - bv
    })
    return copy
  }, [data, sortCol, sortDir])

  const onSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const toggleSector = (s: string) => setExpandedSectors(prev => {
    const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n
  })

  // Group holdings by sector for the drill-in view
  const bySector = useMemo(() => {
    if (!data) return {}
    const g: Record<string, Holding[]> = {}
    for (const h of sortedHoldings) {
      ;(g[h.sector] ??= []).push(h)
    }
    return g
  }, [data, sortedHoldings])

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={e => e.target === e.currentTarget && onClose()}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-3xl bg-background border-l border-border shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border bg-muted/30">
          <div>
            <h2 className="font-semibold text-foreground">{accountName} — Attribution</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {fromDate} → {toDate}
              {data && (
                <span className={`ml-2 font-semibold ${pctColor(data.portfolio_return)}`}>
                  {fmtPct(data.portfolio_return)} total return
                </span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Summary strip */}
        {data && (
          <div className="grid grid-cols-3 gap-px bg-border border-b border-border">
            {[
              { label: 'Start Value', value: fmtCAD(data.start_value) },
              { label: 'End Value', value: fmtCAD(data.end_value) },
              { label: 'Cash Weight', value: fmtPct(data.cash_weight, 1) },
            ].map(c => (
              <div key={c.label} className="bg-card px-4 py-2.5 text-center">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{c.label}</div>
                <div className="font-semibold text-sm text-foreground mt-0.5">{c.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* View tabs */}
        <div className="flex gap-1 px-4 pt-3 pb-0 border-b border-border">
          {(['holdings', 'sectors', 'asset_classes'] as View[]).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-md border-b-2 transition-colors ${
                view === v ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}>
              {v === 'asset_classes' ? 'Asset Classes' : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {q.isLoading && (
            <div className="p-8 text-center text-muted-foreground text-sm">Computing attribution…</div>
          )}
          {q.isError && (
            <div className="p-8 text-center text-red-500 text-sm">Failed to load attribution data.</div>
          )}

          {data && view === 'holdings' && (
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm z-10">
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 text-left">Holding</th>
                  <th className="px-3 py-2.5 text-right cursor-pointer hover:text-foreground" onClick={() => onSort('weight')}>
                    Weight{sortCol === 'weight' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                  <th className="px-3 py-2.5 text-right cursor-pointer hover:text-foreground" onClick={() => onSort('price_return')}>
                    Return{sortCol === 'price_return' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                  <th className="px-3 py-2.5 text-right cursor-pointer hover:text-foreground" onClick={() => onSort('contribution')}>
                    Contribution{sortCol === 'contribution' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                  <th className="px-4 py-2.5 text-left w-20">Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {sortedHoldings.map(h => (
                  <tr key={h.ticker} className="hover:bg-accent/30">
                    <td className="px-4 py-2">
                      <div className="font-medium text-foreground">{h.ticker}</div>
                      <div className="text-[10px] text-muted-foreground truncate max-w-[200px]">{h.name}</div>
                      <div className="text-[9px] text-muted-foreground/70">{h.sector}</div>
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{fmtPct(h.weight, 1)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${pctColor(h.price_return)}`}>{fmtPct(h.price_return)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${pctColor(h.contribution)}`}>{fmtPct(h.contribution)}</td>
                    <td className="px-4 py-2"><ContribBar value={h.contribution} max={maxContrib} /></td>
                  </tr>
                ))}
                {/* Cash row */}
                {data.cash_weight > 0.1 && (
                  <tr className="hover:bg-accent/30 bg-muted/20">
                    <td className="px-4 py-2">
                      <div className="font-medium text-foreground">Cash & equivalents</div>
                      <div className="text-[10px] text-muted-foreground">Cash drag</div>
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{fmtPct(data.cash_weight, 1)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${pctColor(data.cash_return)}`}>{fmtPct(data.cash_return)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${pctColor(data.cash_contribution)}`}>{fmtPct(data.cash_contribution)}</td>
                    <td className="px-4 py-2"><ContribBar value={data.cash_contribution} max={maxContrib} /></td>
                  </tr>
                )}
              </tbody>
              <tfoot className="sticky bottom-0 bg-card border-t-2 border-border">
                <tr className="text-xs font-bold">
                  <td className="px-4 py-2.5 text-muted-foreground">Total explained</td>
                  <td />
                  <td />
                  <td className={`px-3 py-2.5 text-right ${pctColor(data.total_contribution)}`}>{fmtPct(data.total_contribution)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}

          {data && view === 'sectors' && (
            <div className="divide-y divide-border">
              {data.sectors.map(s => {
                const label = s.sector || 'Other'
                const isOpen = expandedSectors.has(label)
                const holdings = bySector[label] ?? []
                return (
                  <div key={label}>
                    <div
                      className="flex items-center px-4 py-3 hover:bg-accent/30 cursor-pointer"
                      onClick={() => toggleSector(label)}
                    >
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mr-2 flex-shrink-0" />
                               : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground mr-2 flex-shrink-0" />}
                      <span className="flex-1 font-medium text-sm text-foreground">{label}</span>
                      <span className="text-xs text-muted-foreground mr-6">{fmtPct(s.weight, 1)} weight</span>
                      <span className={`text-sm font-semibold w-24 text-right ${pctColor(s.contribution)}`}>{fmtPct(s.contribution)}</span>
                      <div className="ml-3"><ContribBar value={s.contribution} max={maxContrib} /></div>
                    </div>
                    {isOpen && holdings.length > 0 && (
                      <div className="bg-muted/20 divide-y divide-border/40">
                        {holdings.sort((a,b) => Math.abs(b.contribution) - Math.abs(a.contribution)).map(h => (
                          <div key={h.ticker} className="flex items-center px-10 py-2 text-xs">
                            <span className="font-medium text-foreground w-16">{h.ticker}</span>
                            <span className="flex-1 text-muted-foreground truncate">{h.name}</span>
                            <span className="text-muted-foreground mr-6">{fmtPct(h.weight, 1)}</span>
                            <span className={`${pctColor(h.price_return)} mr-4 w-16 text-right`}>{fmtPct(h.price_return)}</span>
                            <span className={`font-semibold w-20 text-right ${pctColor(h.contribution)}`}>{fmtPct(h.contribution)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {data && view === 'asset_classes' && (
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm">
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 text-left">Asset Class</th>
                  <th className="px-3 py-2.5 text-right">Weight</th>
                  <th className="px-3 py-2.5 text-right">Contribution</th>
                  <th className="px-4 py-2.5 text-left w-20">Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.asset_classes.map(a => (
                  <tr key={a.asset_class} className="hover:bg-accent/30">
                    <td className="px-4 py-2.5 font-medium text-foreground">{a.asset_class}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">{fmtPct(a.weight, 1)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${pctColor(a.contribution)}`}>{fmtPct(a.contribution)}</td>
                    <td className="px-4 py-2.5"><ContribBar value={a.contribution} max={maxContrib} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Legend */}
        {data && (
          <div className="px-5 py-3 border-t border-border bg-muted/30 text-[10px] text-muted-foreground">
            Contribution = start weight × price return. Options excluded. Cash contribution reflects interest/dividends only.
            Unexplained gap vs total return = dividend income, option premium, fees not yet attributed.
          </div>
        )}
      </div>
    </div>
  )
}
