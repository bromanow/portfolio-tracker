import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { getAccounts, getReturnsDetail } from '../../api/client'
import type { Account, ReturnDetailRow } from '../../api/client'
import DatePicker from '../../components/DatePicker'
import { fmtCAD0, fmtCAD0Signed, useSortState, SortTh } from './shared'

// ── Return Calculation Detail Report ──────────────────────────────────────────

type ReturnDetailPreset = 'YTD' | '1Y' | '3Y' | 'custom'

export default function ReturnDetailReport() {
  const today     = new Date().toISOString().slice(0, 10)
  const yearStart = `${new Date().getFullYear()}-01-01`
  const [preset,          setPreset]          = useState<ReturnDetailPreset>('YTD')
  const [fromDate,        setFromDate]        = useState(yearStart)
  const [toDate,          setToDate]          = useState(today)
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [typeFilter,      setTypeFilter]      = useState('')
  const [nameFilter,      setNameFilter]      = useState('')
  const [showFormula,     setShowFormula]     = useState(false)
  const { sort, toggle } = useSortState('account_name', 'asc')

  function applyPreset(p: ReturnDetailPreset) {
    setPreset(p)
    const t = new Date()
    const todayStr = t.toISOString().slice(0, 10)
    setToDate(todayStr)
    if (p === 'YTD') {
      setFromDate(`${t.getFullYear()}-01-01`)
    } else if (p === '1Y') {
      const d = new Date(t); d.setFullYear(d.getFullYear() - 1)
      setFromDate(d.toISOString().slice(0, 10))
    } else if (p === '3Y') {
      const d = new Date(t); d.setFullYear(d.getFullYear() - 3)
      setFromDate(d.toISOString().slice(0, 10))
    }
  }

  const { data: accountsData = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const allAccts = accountsData as Account[]
  const defaultAccountIds = useMemo(
    () => allAccts.map(a => String(a.id)).join(',') || undefined,
    [allAccts],
  )

  const { data: rawRows = [], isLoading } = useQuery({
    queryKey: ['returns-detail', fromDate, toDate, defaultAccountIds],
    queryFn:  () => getReturnsDetail({ from_date: fromDate, to_date: toDate, account_ids: defaultAccountIds }),
    enabled:  !!fromDate && !!toDate && defaultAccountIds !== undefined,
  })
  const rows = rawRows as ReturnDetailRow[]

  const brokerages = useMemo(() => [...new Set(rows.map(r => r.brokerage))].sort(), [rows])
  const types      = useMemo(() => [...new Set(rows.map(r => r.account_type))].sort(), [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (brokerageFilter && r.brokerage !== brokerageFilter) return false
    if (typeFilter      && r.account_type !== typeFilter)   return false
    if (nameFilter      && !r.account_name.toLowerCase().includes(nameFilter.toLowerCase())) return false
    return true
  }), [rows, brokerageFilter, typeFilter, nameFilter])

  const sorted = useMemo(() => {
    const col = sort.col as keyof ReturnDetailRow
    return [...filtered].sort((a, b) => {
      const va = a[col], vb = b[col]
      if (typeof va === 'number' && typeof vb === 'number')
        return sort.dir === 'asc' ? va - vb : vb - va
      return sort.dir === 'asc'
        ? String(va ?? '').localeCompare(String(vb ?? ''))
        : String(vb ?? '').localeCompare(String(va ?? ''))
    })
  }, [filtered, sort])

  // Derived: performance value change = (end - start) minus net capital flows
  function perfValueChange(r: ReturnDetailRow) {
    return (r.end_market_value - r.start_market_value) - r.net_flows
  }

  function rPctCls(v: number | null | undefined) {
    if (v === null || v === undefined) return 'text-muted-foreground'
    if (v >= 10) return 'text-emerald-700 font-bold'
    if (v >= 0)  return 'text-emerald-600 dark:text-emerald-400 font-semibold'
    if (v >= -10) return 'text-red-500 dark:text-red-400 font-semibold'
    return 'text-red-600 dark:text-red-400 font-bold'
  }

  // Annualized return from a period return % and date range
  function annualizedPct(r: ReturnDetailRow): number | null {
    const days = (new Date(r.to_date).getTime() - new Date(r.from_date).getTime()) / 86400000
    if (days <= 0 || r.return_pct <= -100) return null
    return (Math.pow(1 + r.return_pct / 100, 365 / days) - 1) * 100
  }

  // Portfolio-level aggregate (sum of Modified Dietz components)
  const totals = useMemo(() => ({
    start:          sorted.reduce((s, r) => s + r.start_market_value, 0),
    end:            sorted.reduce((s, r) => s + r.end_market_value,   0),
    net_flows:      sorted.reduce((s, r) => s + r.net_flows,          0),
    period_income:  sorted.reduce((s, r) => s + r.period_income,      0),
    total_gain:     sorted.reduce((s, r) => s + r.total_gain,         0),
    md_denominator: sorted.reduce((s, r) => s + (r.md_denominator ?? r.start_market_value), 0),
  }), [sorted])
  // Correct aggregate return: sum(numerators) / sum(MD denominators)
  const totalReturnPct = totals.md_denominator > 0 ? (totals.total_gain / totals.md_denominator) * 100 : null
  // Annualized aggregate — use the common from/to dates from the first row (all rows share the same period)
  const totalAnnualizedPct = useMemo(() => {
    if (sorted.length === 0 || totalReturnPct === null) return null
    const days = (new Date(sorted[0].to_date).getTime() - new Date(sorted[0].from_date).getTime()) / 86400000
    if (days <= 0 || totalReturnPct <= -100) return null
    return (Math.pow(1 + totalReturnPct / 100, 365 / days) - 1) * 100
  }, [sorted, totalReturnPct])

  // Mini waterfall bar — shows composition of Modified Dietz total_gain as % of start MV
  function WaterfallBar({ row }: { row: ReturnDetailRow }) {
    const base = Math.abs(row.start_market_value) || 1
    const pvc  = (perfValueChange(row)  / base) * 100   // perf value change (ex net flows)
    const pi   = (row.period_income     / base) * 100   // income
    const nf   = (Math.abs(row.net_flows) / base) * 100 // net flows magnitude (context bar)
    const scale = Math.max(Math.abs(pvc) + pi + nf * 0.3, 0.01)
    const w = (v: number) => `${Math.min(Math.abs(v) / scale * 48, 48).toFixed(1)}px`
    return (
      <div className="flex items-center gap-0.5 h-3 ml-1">
        {Math.abs(pvc) > 0.1 && <div title={`Perf. value Δ: ${pvc >= 0 ? '+' : ''}${pvc.toFixed(1)}%`}
          style={{ width: w(pvc) }} className={`h-2 rounded-sm ${pvc >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`} />}
        {pi > 0.1 && <div title={`Income: +${pi.toFixed(1)}%`}
          style={{ width: w(pi) }} className="h-2 bg-blue-400 rounded-sm" />}
        {nf > 0.1 && <div title={`Net flows: ${row.net_flows >= 0 ? '+' : ''}${(row.net_flows / base * 100).toFixed(1)}% (context)`}
          style={{ width: w(nf * 0.3) }} className={`h-2 rounded-sm opacity-40 ${row.net_flows >= 0 ? 'bg-orange-300' : 'bg-purple-300'}`} />}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Period</label>
          <div className="flex gap-1">
            {(['YTD', '1Y', '3Y'] as ReturnDetailPreset[]).map(p => (
              <button key={p} onClick={() => applyPreset(p)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${preset === p ? 'bg-primary text-white' : 'bg-accent text-muted-foreground hover:bg-accent'}`}>
                {p}
              </button>
            ))}
            <button onClick={() => setPreset('custom')}
              className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${preset === 'custom' ? 'bg-primary text-white' : 'bg-accent text-muted-foreground hover:bg-accent'}`}>
              Custom
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">From</label>
          <DatePicker value={fromDate || ''} onChange={v => { setFromDate(v); setPreset('custom') }}
            max={new Date().toISOString().slice(0, 10)} placeholder="From" highlight={!!fromDate} className="w-36" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">To</label>
          <DatePicker value={toDate || ''} onChange={v => { setToDate(v); setPreset('custom') }}
            max={new Date().toISOString().slice(0, 10)} placeholder="To" highlight={!!toDate} className="w-36" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Brokerage</label>
          <select className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm" value={brokerageFilter} onChange={e => setBrokerageFilter(e.target.value)}>
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Type</label>
          <select className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Search</label>
          <input type="text" placeholder="Account name…" value={nameFilter} onChange={e => setNameFilter(e.target.value)}
            className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm w-36" />
        </div>
      </div>

      {/* Formula toggle */}
      <div>
        <button onClick={() => setShowFormula(v => !v)}
          className="text-xs text-primary hover:text-primary flex items-center gap-1">
          {showFormula ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          How is total return calculated?
        </button>
        {showFormula && (
          <div className="mt-2 bg-primary/10 border border-primary/10 rounded-lg p-4 text-xs text-foreground space-y-2">
            <p className="font-semibold text-primary">Modified Dietz Return (industry standard)</p>
            <div className="font-mono bg-card border border-primary/10 rounded p-3 text-foreground leading-relaxed text-xs">
              <p className="font-semibold text-muted-foreground mb-1">Numerator (Total Gain):</p>
              <p>  (End Value − Start Value) − Net Flows + Period Income</p>
              <p className="mt-2 font-semibold text-muted-foreground">Denominator (Effective Capital):</p>
              <p>  Start Value + Σ (weight_i × flow_i)</p>
              <p className="text-muted-foreground text-xs">  where weight_i = days remaining in period / total period days</p>
              <p className="mt-2 border-t border-border pt-2 font-semibold">Return %  =  Total Gain ÷ Effective Capital × 100</p>
            </div>
            <p className="text-muted-foreground text-xs">
              Net Flows = total contributions minus withdrawals during the period.
              By weighting flows by how long they were invested, the return correctly reflects
              performance per dollar regardless of when money was added or withdrawn.
            </p>
            <div className="flex flex-wrap gap-4">
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-emerald-400" /> Perf. value Δ (ex-flows)</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-blue-400" /> Period income</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-orange-300" /> Net flows (context only)</span>
            </div>
          </div>
        )}
      </div>

      {isLoading
        ? <div className="flex justify-center py-16"><div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary" /></div>
        : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm divide-y divide-border">
                <thead className="bg-muted/50">
                  <tr className="text-xs text-muted-foreground uppercase">
                    <SortTh label="Account"          col="account_name"       sort={sort} toggle={toggle} className="px-4 py-2.5 text-left" />
                    <SortTh label="Brokerage"        col="brokerage"          sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                    <SortTh label="Type"             col="account_type"       sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                    <SortTh label="Start Value"      col="start_market_value" sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="End Value"        col="end_market_value"   sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Net Flows"        col="net_flows"          sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Income"           col="period_income"      sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Gain (MD)"        col="total_gain"         sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Return %"         col="return_pct"         sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <th className="px-3 py-2.5 text-right text-xs text-muted-foreground uppercase font-medium whitespace-nowrap" title="Annualized return (only shown for periods ≥ 1 year)">Ann. %</th>
                    <th className="px-3 py-2.5 text-left text-xs text-muted-foreground font-normal whitespace-nowrap">Composition</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.length === 0 && (
                    <tr><td colSpan={12} className="px-4 py-8 text-center text-muted-foreground">No data for selected period.</td></tr>
                  )}
                  {sorted.map(r => (
                    <tr key={r.account_ids.join('-')} className="hover:bg-muted/50">
                      <td className="px-4 py-2 font-medium text-foreground whitespace-nowrap">{r.account_name}</td>
                      <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{r.brokerage}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="px-1.5 py-0.5 rounded bg-accent text-muted-foreground text-xs">{r.account_type}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{fmtCAD0(r.start_market_value)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{fmtCAD0(r.end_market_value)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-sm">
                        {Math.abs(r.net_flows) > 1
                          ? <span className={r.net_flows >= 0 ? 'text-orange-500' : 'text-purple-500'}
                              title={r.net_flows >= 0 ? 'Net contributions (new money in)' : 'Net withdrawals (money out)'}>
                              {fmtCAD0Signed(r.net_flows)}
                            </span>
                          : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-primary tabular-nums text-sm">
                        {r.period_income > 0 ? fmtCAD0(r.period_income) : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${r.total_gain >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                        {fmtCAD0Signed(r.total_gain)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${rPctCls(r.return_pct)}`}>
                        {`${r.return_pct >= 0 ? '+' : ''}${r.return_pct.toFixed(1)}%`}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${rPctCls(annualizedPct(r))}`}>
                        {annualizedPct(r) !== null
                          ? `${annualizedPct(r)! >= 0 ? '+' : ''}${annualizedPct(r)!.toFixed(1)}%`
                          : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <WaterfallBar row={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                {sorted.length > 0 && (
                  <tfoot className="bg-muted/50 border-t-2 border-border font-semibold text-sm">
                    <tr>
                      <td className="px-4 py-2.5 text-muted-foreground" colSpan={3}>
                        {sorted.length} account{sorted.length !== 1 ? 's' : ''}
                        {(brokerageFilter || typeFilter || nameFilter) && ` (filtered from ${rows.length})`}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtCAD0(totals.start)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtCAD0(totals.end)}</td>
                      <td className="px-3 py-2.5 text-right text-orange-500 tabular-nums">
                        {Math.abs(totals.net_flows) > 1 ? fmtCAD0Signed(totals.net_flows) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-primary tabular-nums">{fmtCAD0(totals.period_income)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${totals.total_gain >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                        {fmtCAD0Signed(totals.total_gain)}
                      </td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${rPctCls(totalReturnPct)}`}>
                        {totalReturnPct !== null ? `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(1)}%` : '—'}
                      </td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${rPctCls(totalAnnualizedPct)}`}>
                        {totalAnnualizedPct !== null ? `${totalAnnualizedPct >= 0 ? '+' : ''}${totalAnnualizedPct.toFixed(1)}%` : '—'}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}
    </div>
  )
}
