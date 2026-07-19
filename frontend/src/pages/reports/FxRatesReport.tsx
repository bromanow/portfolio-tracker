import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { ChevronRight } from 'lucide-react'
import { getFxRates } from '../../api/client'
import type { FXRate } from '../../api/client'
import DatePicker from '../../components/DatePicker'

// ── FX Rates Report ───────────────────────────────────────────────────────────
export default function FxRatesReport() {
  const [yearFilter, setYearFilter]   = useState('')
  const [dateFrom,   setDateFrom]     = useState('')
  const [dateTo,     setDateTo]       = useState('')
  const [expanded,   setExpanded]     = useState<Set<string>>(new Set())

  const { data: rates = [], isLoading } = useQuery({
    queryKey: ['fx-rates', yearFilter, dateFrom, dateTo],
    queryFn: () => getFxRates(10000),   // fetch all
    staleTime: 60_000,
  })

  const years = useMemo(() =>
    [...new Set((rates as FXRate[]).map(r => r.rate_date.slice(0, 4)))].sort().reverse(),
  [rates])

  const filtered = useMemo(() => {
    let r = [...(rates as FXRate[])]
    if (yearFilter) r = r.filter(x => x.rate_date.startsWith(yearFilter))
    if (dateFrom)   r = r.filter(x => x.rate_date >= dateFrom)
    if (dateTo)     r = r.filter(x => x.rate_date <= dateTo)
    return r.sort((a, b) => b.rate_date.localeCompare(a.rate_date))
  }, [rates, yearFilter, dateFrom, dateTo])

  // Group by currency pair, then by year, then by month
  const pairs = useMemo(() => {
    const seen = new Set<string>()
    return (rates as FXRate[]).filter(r => {
      const key = `${r.from_currency}/${r.to_currency}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [rates])

  // Group filtered rows by "YYYY-MM"
  const grouped = useMemo(() => {
    const m = new Map<string, { year: string; month: string; monthKey: string; rows: FXRate[] }>()
    for (const r of filtered) {
      const mk = r.rate_date.slice(0, 7)  // "YYYY-MM"
      if (!m.has(mk)) m.set(mk, {
        year: r.rate_date.slice(0, 4),
        month: r.rate_date.slice(5, 7),
        monthKey: mk,
        rows: [],
      })
      m.get(mk)!.rows.push(r)
    }
    return [...m.values()].sort((a, b) => b.monthKey.localeCompare(a.monthKey))
  }, [filtered])

  // Group months by year for year-level expand/collapse
  const byYear = useMemo(() => {
    const m = new Map<string, typeof grouped>()
    for (const g of grouped) {
      if (!m.has(g.year)) m.set(g.year, [])
      m.get(g.year)!.push(g)
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [grouped])

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const monthName = (mm: string) => MONTH_NAMES[parseInt(mm) - 1] ?? mm

  const toggleYear  = (y: string) => setExpanded(s => { const n = new Set(s); n.has(y) ? n.delete(y) : n.add(y); return n })
  const toggleMonth = (mk: string) => setExpanded(s => { const n = new Set(s); n.has(mk) ? n.delete(mk) : n.add(mk); return n })

  if (isLoading) return <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>

  return (
    <div className="space-y-6">
      {/* Latest rates summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {pairs.map(r => (
          <div key={`${r.from_currency}${r.to_currency}`} className="bg-card border border-border rounded-xl px-4 py-3">
            <p className="text-xs text-muted-foreground mb-1">{r.from_currency} → {r.to_currency}</p>
            <p className="text-xl font-semibold text-foreground">{Number(r.rate).toFixed(4)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{r.rate_date}</p>
          </div>
        ))}
      </div>

      {/* FX Rate Line Chart */}
      {(() => {
        // Build chart data: one entry per date, one key per currency pair
        const chartDates = [...new Set(filtered.map(r => r.rate_date))].sort()
        const chartPairs = [...new Set(filtered.map(r => `${r.from_currency}/${r.to_currency}`))]
        const rateMap: Record<string, Record<string, number>> = {}
        for (const r of filtered) {
          if (!rateMap[r.rate_date]) rateMap[r.rate_date] = {}
          rateMap[r.rate_date][`${r.from_currency}/${r.to_currency}`] = Number(r.rate)
        }
        const chartData = chartDates.map(d => ({ date: d, ...rateMap[d] }))
        const LINE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']
        if (chartData.length < 2) return null
        const xInterval = Math.max(0, Math.floor(chartData.length / 10) - 1)
        return (
          <div className="bg-card rounded-xl border border-border p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">Exchange Rate Over Time</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={xInterval}
                  tickFormatter={v => v.slice(0, 7)} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v.toFixed(4)} width={60} />
                <Tooltip
                  formatter={(v: number, name: string) => [v.toFixed(6), name]}
                  labelFormatter={v => String(v)}
                />
                <Legend iconType="line" wrapperStyle={{ fontSize: 11 }} />
                {chartPairs.map((pair, i) => (
                  <Line key={pair} type="monotone" dataKey={pair}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.5}
                    dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      })()}

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Year</label>
          <select className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm" value={yearFilter} onChange={e => { setYearFilter(e.target.value); setDateFrom(''); setDateTo('') }}>
            <option value="">All years</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">From Date</label>
          <DatePicker value={dateFrom || ''} onChange={v => { setDateFrom(v); setYearFilter('') }} max={new Date().toISOString().slice(0, 10)} placeholder="From" highlight={!!dateFrom} className="w-36" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">To Date</label>
          <DatePicker value={dateTo || ''} onChange={v => { setDateTo(v); setYearFilter('') }} max={new Date().toISOString().slice(0, 10)} placeholder="To" highlight={!!dateTo} className="w-36" />
        </div>
        {(yearFilter || dateFrom || dateTo) && (
          <button className="text-xs text-primary hover:underline" onClick={() => { setYearFilter(''); setDateFrom(''); setDateTo('') }}>Clear filters</button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{filtered.length} entries</span>
      </div>

      {/* Grouped rate history */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/50 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Rate History</h3>
          <div className="flex gap-2">
            <button className="text-xs text-primary hover:underline" onClick={() => {
              const allKeys = new Set<string>()
              byYear.forEach(([y, months]) => { allKeys.add(y); months.forEach(m => allKeys.add(m.monthKey)) })
              setExpanded(allKeys)
            }}>Expand all</button>
            <span className="text-muted-foreground/50">|</span>
            <button className="text-xs text-primary hover:underline" onClick={() => setExpanded(new Set())}>Collapse all</button>
          </div>
        </div>
        <div className="divide-y divide-border">
          {byYear.map(([year, months]) => (
            <div key={year}>
              {/* Year row */}
              <button
                onClick={() => toggleYear(year)}
                className="w-full flex items-center gap-2 px-4 py-2.5 bg-muted/50 hover:bg-accent text-left"
              >
                <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded.has(year) ? 'rotate-90' : ''}`} />
                <span className="font-semibold text-foreground text-sm">{year}</span>
                <span className="text-xs text-muted-foreground ml-1">({months.reduce((s, m) => s + m.rows.length, 0)} entries)</span>
              </button>

              {expanded.has(year) && months.map(({ monthKey, month, rows: mRows }) => (
                <div key={monthKey}>
                  {/* Month row */}
                  <button
                    onClick={() => toggleMonth(monthKey)}
                    className="w-full flex items-center gap-2 px-8 py-2 hover:bg-muted/50 text-left"
                  >
                    <ChevronRight className={`w-3 h-3 text-muted-foreground transition-transform ${expanded.has(monthKey) ? 'rotate-90' : ''}`} />
                    <span className="text-sm text-foreground">{monthName(month)} {year}</span>
                    <span className="text-xs text-muted-foreground ml-1">({mRows.length} entries)</span>
                  </button>

                  {expanded.has(monthKey) && (
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-border">
                        {mRows.map(r => (
                          <tr key={r.id} className="hover:bg-muted/50">
                            <td className="px-12 py-1.5 text-muted-foreground text-xs">{r.rate_date}</td>
                            <td className="px-4 py-1.5 text-muted-foreground text-xs">{r.from_currency} → {r.to_currency}</td>
                            <td className="px-4 py-1.5 text-right font-mono text-foreground text-xs">{Number(r.rate).toFixed(6)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          ))}
          {byYear.length === 0 && (
            <div className="px-4 py-8 text-center text-muted-foreground text-sm">No FX rates found.</div>
          )}
        </div>
      </div>
    </div>
  )
}
