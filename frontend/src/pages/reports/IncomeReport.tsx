import { useState, useMemo, Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList,
  Treemap, Cell, ResponsiveContainer, Pie, PieChart,
} from 'recharts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { getInvestmentIncome, getProjectedIncome, getAccounts } from '../../api/client'
import type { Account, IncomeItem, ProjectedIncomeRow } from '../../api/client'
import DatePicker from '../../components/DatePicker'
import TickerLink from '../../components/TickerLink'
import { getPref } from '../../hooks/usePreference'
import { fmtCAD, fmtCAD0, useSortState, SortTh, sortRows, COLORS, AccountTypeBadge } from './shared'

// ── Investment Income ─────────────────────────────────────────────────────────

type IncomeTreeTx   = IncomeItem
type IncomeTreeSec  = { key: string; ticker: string; security_id: number | null; total: number; transactions: IncomeTreeTx[] }
type IncomeTreeAcct = { key: string; account: string; account_type: string | null; brokerage: string; total: number; securities: IncomeTreeSec[] }
type IncomeTreeBrok = { key: string; brokerage: string; total: number; accounts: IncomeTreeAcct[] }

export default function IncomeReport() {
  const currentYear = new Date().getFullYear()
  const [accountId, setAccountId]             = useState('')
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [year, setYear]                       = useState(String(currentYear))
  const [reportMode, setReportMode] = useState<'historical' | 'projected'>('historical')

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const allAccts = accounts as Account[]
  const years = Array.from({ length: 8 }, (_, i) => currentYear - i)

  // Default account_ids to all user accounts so non-admin users are always scoped
  const defaultAccountIds = useMemo(
    () => allAccts.map(a => String(a.id)).join(',') || undefined,
    [allAccts],
  )

  const { data: income = [], isLoading } = useQuery({
    queryKey: ['income', accountId, year, defaultAccountIds],
    queryFn: () => getInvestmentIncome({
      account_ids: accountId ? String(accountId) : defaultAccountIds,
      year: year ? Number(year) : undefined,
    }),
    enabled: reportMode === 'historical' && defaultAccountIds !== undefined,
  })
  const { data: projectedIncome = [], isLoading: projectedLoading } = useQuery({
    queryKey: ['projected-income', accountId, defaultAccountIds],
    queryFn: () => getProjectedIncome({
      account_ids: accountId ? String(accountId) : defaultAccountIds,
    }),
    // Always fetched (not just in Projected mode) — it's also the source of current
    // portfolio value used for the Historical tab's Overall Yield calculation below.
    enabled: defaultAccountIds !== undefined,
  })
  const { sort, toggle } = useSortState('date', 'desc')
  const [tickerFilter, setTickerFilter] = useState('')
  const [typeFilter, setTypeFilter]     = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [viewMode, setViewMode] = useState<'account' | 'security'>('account')

  // Expand state — collapsed to brokerage level by default
  const [expandedBrokerages, setExpandedBrokerages] = useState<Set<string>>(new Set())
  const [expandedAccounts,   setExpandedAccounts]   = useState<Set<string>>(new Set())
  const [expandedSecurities, setExpandedSecurities] = useState<Set<string>>(new Set())

  const toggleBrokerage = (key: string) => setExpandedBrokerages(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const toggleAccount   = (key: string) => setExpandedAccounts(s =>   { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const toggleSecurity  = (key: string) => setExpandedSecurities(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })

  const rows = income as IncomeItem[]

  const brokerages     = useMemo(() => [...new Set(rows.map(r => r.brokerage_name).filter(Boolean))].sort(), [rows])
  const availableTypes = useMemo(() => [...new Set(rows.map(r => r.transaction_type))].sort(), [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (brokerageFilter && r.brokerage_name !== brokerageFilter) return false
    if (tickerFilter && !r.ticker.toLowerCase().includes(tickerFilter.toLowerCase())) return false
    if (typeFilter && r.transaction_type !== typeFilter) return false
    if (dateFrom && r.date < dateFrom) return false
    if (dateTo && r.date > dateTo) return false
    return true
  }), [rows, brokerageFilter, tickerFilter, typeFilter, dateFrom, dateTo])

  // Build hierarchical tree: Brokerage → Account → Security → Transactions
  const tree = useMemo((): IncomeTreeBrok[] => {
    const brokMap = new Map<string, IncomeTreeBrok>()
    for (const item of filtered) {
      const bKey = item.brokerage_name
      if (!brokMap.has(bKey)) brokMap.set(bKey, { key: bKey, brokerage: bKey, total: 0, accounts: [] })
      const brok = brokMap.get(bKey)!

      const aKey = `${bKey}|${item.account_name}`
      let acct = brok.accounts.find(a => a.key === aKey)
      if (!acct) { acct = { key: aKey, account: item.account_name, account_type: item.account_type, brokerage: bKey, total: 0, securities: [] }; brok.accounts.push(acct) }

      const sKey = `${aKey}|${item.ticker || '(none)'}`
      let sec = acct.securities.find(s => s.key === sKey)
      if (!sec) { sec = { key: sKey, ticker: item.ticker || '(none)', security_id: item.security_id, total: 0, transactions: [] }; acct.securities.push(sec) }

      const amt = parseFloat(item.amount_cad)
      brok.total += amt
      acct.total += amt
      sec.total  += amt
      sec.transactions.push(item)
    }
    return [...brokMap.values()]
      .sort((a, b) => b.total - a.total)
      .map(b => ({
        ...b,
        accounts: b.accounts.sort((a, c) => c.total - a.total).map(a => ({
          ...a,
          securities: a.securities.sort((x, y) => y.total - x.total).map(s => ({
            ...s,
            transactions: sortRows(s.transactions, sort.col, sort.dir),
          })),
        })),
      }))
  }, [filtered, sort])

  // Bar chart data — income by year & type, with _total for labels
  const { byYear, incomeTypes } = useMemo(() => {
    const m: Record<number, Record<string, number>> = {}
    for (const item of filtered) {
      if (!m[item.year]) m[item.year] = {}
      m[item.year][item.transaction_type] = (m[item.year][item.transaction_type] || 0) + parseFloat(item.amount_cad)
    }
    const allTypes = [...new Set(filtered.map(i => i.transaction_type))]
    const data = Object.entries(m).sort((a, b) => Number(a[0]) - Number(b[0])).map(([yr, v]) => ({
      year: yr,
      ...Object.fromEntries(allTypes.map(t => [t, +((v[t] || 0).toFixed(2))])),
      _total: +allTypes.reduce((s, t) => s + (v[t] || 0), 0).toFixed(2),
    }))
    return { byYear: data, incomeTypes: allTypes }
  }, [filtered])

  // Treemap data — income by security (positive only, top 20)
  const treemapData = useMemo(() => {
    const m: Record<string, number> = {}
    for (const item of filtered) {
      const k = item.ticker || '(none)'
      m[k] = (m[k] || 0) + parseFloat(item.amount_cad)
    }
    return Object.entries(m)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, size], i) => ({ name, size: +size.toFixed(2), fill: COLORS[i % COLORS.length] }))
  }, [filtered])

  // Subtotal by account type (tax-impact view — RRSP/TFSA income has no immediate tax,
  // NON_REG income is taxable now), sorted by dollar size (largest first).
  const historicalByAccountType = useMemo(() => {
    const m = new Map<string, number>()
    for (const item of filtered) {
      const t = item.account_type || 'UNKNOWN'
      m.set(t, (m.get(t) || 0) + parseFloat(item.amount_cad))
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [filtered])
  const historicalAccountTypePieData = useMemo(
    () => historicalByAccountType
      .filter(([, v]) => v > 0)
      .map(([type, value], i) => ({ name: type, value: +value.toFixed(2), fill: COLORS[i % COLORS.length] })),
    [historicalByAccountType],
  )

  // Security view groups
  // Two-level: Security → Account. A security held across multiple accounts (e.g. DE in
  // both TFSA and RRSP) gets one subtotal per account rather than a single blended figure.
  const incomeSecurityGroups = useMemo(() => {
    type AcctGroup = { key: string; account: string; rows: IncomeItem[]; total: number }
    type SecGroup = { key: string; ticker: string; security_id: number | null; total: number; accounts: AcctGroup[] }
    const secMap = new Map<string, SecGroup>()
    for (const item of filtered) {
      const sKey = item.ticker || '(none)'
      if (!secMap.has(sKey)) secMap.set(sKey, { key: sKey, ticker: sKey, security_id: item.security_id, total: 0, accounts: [] })
      const sec = secMap.get(sKey)!

      const aKey = item.account_name
      let acct = sec.accounts.find(a => a.key === aKey)
      if (!acct) { acct = { key: aKey, account: aKey, rows: [], total: 0 }; sec.accounts.push(acct) }

      const amt = parseFloat(item.amount_cad)
      sec.total += amt
      acct.total += amt
      acct.rows.push(item)
    }
    return [...secMap.values()]
      .sort((a, b) => b.total - a.total)
      .map(sec => ({
        ...sec,
        accounts: sec.accounts
          .sort((a, b) => b.total - a.total)
          .map(a => ({ ...a, rows: sortRows(a.rows, sort.col, sort.dir) })),
      }))
  }, [filtered, sort])

  const totalAll      = rows.reduce((s, i)     => s + parseFloat(i.amount_cad), 0)
  const totalFiltered = filtered.reduce((s, i) => s + parseFloat(i.amount_cad), 0)

  // ── Projected Income (current holdings × dividend yield / interest rate) ──────
  const projectedRows = projectedIncome as ProjectedIncomeRow[]
  const projectedFiltered = useMemo(
    () => projectedRows.filter(r =>
      (!brokerageFilter || r.brokerage_name === brokerageFilter) &&
      parseFloat(r.projected_annual_income_cad || '0') > 0),
    [projectedRows, brokerageFilter],
  )
  const { sort: projSort, toggle: projToggle } = useSortState('projected_annual_income_cad', 'desc')
  const projectedSorted = useMemo(
    () => sortRows(projectedFiltered, projSort.col, projSort.dir),
    [projectedFiltered, projSort],
  )
  const isDividendType = (t: string | null) => t === 'DIVIDEND' || t === 'DIVIDEND_EST'
  const isInterestType = (t: string | null) => t === 'INTEREST' || t === 'INTEREST_EST'

  const projectedSubtotals = useMemo(() => {
    let dividend = 0, interest = 0
    for (const r of projectedFiltered) {
      const income = parseFloat(r.projected_annual_income_cad || '0')
      if (isDividendType(r.rate_type)) dividend += income
      else if (isInterestType(r.rate_type)) interest += income
    }
    return { dividend, interest, total: dividend + interest }
  }, [projectedFiltered])

  // Overall portfolio yield — same denominator for both Historical and Projected: the
  // CURRENT total market value of every currently-held non-option security in the current
  // Brokerage/Account scope (not just the income-producing ones — a growth stock still
  // counts as capital that could have earned income, so it correctly dilutes the yield).
  const totalPortfolioValueCad = useMemo(
    () => projectedRows
      .filter(r => !brokerageFilter || r.brokerage_name === brokerageFilter)
      .reduce((s, r) => s + parseFloat(r.market_value_cad || '0'), 0),
    [projectedRows, brokerageFilter],
  )
  const historicalOverallYieldPct = totalPortfolioValueCad > 0 ? (totalAll / totalPortfolioValueCad) * 100 : null
  const projectedOverallYieldPct = totalPortfolioValueCad > 0 ? (projectedSubtotals.total / totalPortfolioValueCad) * 100 : null
  // Grouped BY SECURITY (summed across account-type splits — a security held in both RRSP
  // and TFSA should appear as one bar, not two) — always "top 15 + Other by income",
  // independent of whatever column the TABLE is currently sorted by (alphabetically,
  // "DIVIDEND" sorts before "INTEREST", so a Type-ascending table sort would otherwise push
  // every interest row out of a naive slice).
  const projectedChartData = useMemo(() => {
    const m = new Map<string, { ticker: string; DIVIDEND: number; INTEREST: number }>()
    for (const r of projectedFiltered) {
      const income = parseFloat(r.projected_annual_income_cad || '0')
      const entry = m.get(r.ticker) || { ticker: r.ticker, DIVIDEND: 0, INTEREST: 0 }
      if (isDividendType(r.rate_type)) entry.DIVIDEND += income
      else if (isInterestType(r.rate_type)) entry.INTEREST += income
      m.set(r.ticker, entry)
    }
    const bySecurity = [...m.values()].sort((a, b) => (b.DIVIDEND + b.INTEREST) - (a.DIVIDEND + a.INTEREST))
    const top = bySecurity.slice(0, 15).map(r => ({ ticker: r.ticker, DIVIDEND: +r.DIVIDEND.toFixed(2), INTEREST: +r.INTEREST.toFixed(2) }))
    const rest = bySecurity.slice(15)
    if (rest.length > 0) {
      top.push({
        ticker: `Other (${rest.length})`,
        DIVIDEND: +rest.reduce((s, r) => s + r.DIVIDEND, 0).toFixed(2),
        INTEREST: +rest.reduce((s, r) => s + r.INTEREST, 0).toFixed(2),
      })
    }
    return top
  }, [projectedFiltered])
  const projectedPieData = useMemo(
    () => [
      { name: 'Dividend', value: +projectedSubtotals.dividend.toFixed(2), fill: COLORS[0] },
      { name: 'Interest', value: +projectedSubtotals.interest.toFixed(2), fill: COLORS[1] },
    ].filter(d => d.value > 0),
    [projectedSubtotals],
  )

  // Subtotal by account type (tax-impact view — RRSP/TFSA income has no immediate tax,
  // NON_REG income is taxable now), sorted by dollar size (largest first).
  const projectedByAccountType = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of projectedFiltered) {
      const t = r.account_type || 'UNKNOWN'
      m.set(t, (m.get(t) || 0) + parseFloat(r.projected_annual_income_cad || '0'))
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [projectedFiltered])
  const projectedAccountTypePieData = useMemo(
    () => projectedByAccountType.map(([type, value], i) => ({ name: type, value: +value.toFixed(2), fill: COLORS[i % COLORS.length] })),
    [projectedByAccountType],
  )

  // Subtotal by security class (EQUITY/ETF/FUND/STRUCTURED_NOTE/MORTGAGE/etc.)
  const projectedByClass = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of projectedFiltered) {
      m.set(r.asset_class, (m.get(r.asset_class) || 0) + parseFloat(r.projected_annual_income_cad || '0'))
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [projectedFiltered])
  const projectedClassPieData = useMemo(
    () => projectedByClass.map(([cls, value], i) => ({ name: cls, value: +value.toFixed(2), fill: COLORS[i % COLORS.length] })),
    [projectedByClass],
  )

  // Pie slice labels as currency, no decimals (e.g. "$3,498") — recharts calls this with
  // the raw datum, not the formatted `value` prop, so the currency formatting has to happen
  // inside the label renderer itself.
  const pieCurrencyLabel = (props: Record<string, unknown>) => fmtCAD0(props.value as number)

  // Custom Treemap cell renderer
  const renderTreemapCell = (props: Record<string, unknown>) => {
    const x = props.x as number, y = props.y as number
    const width = props.width as number, height = props.height as number
    const name = props.name as string, size = props.size as number
    const fill = props.fill as string
    if (width < 5 || height < 5) return null
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#fff" strokeWidth={2} rx={3} />
        {width > 40 && height > 22 && (
          <text x={x + width / 2} y={y + height / 2 - (height > 38 ? 7 : 0)}
            textAnchor="middle" fontSize={Math.min(11, width / 5)} fill="#fff" fontWeight={600}>
            {name}
          </text>
        )}
        {width > 40 && height > 38 && (
          <text x={x + width / 2} y={y + height / 2 + 9}
            textAnchor="middle" fontSize={Math.min(9, width / 6)} fill="rgba(255,255,255,0.85)">
            {fmtCAD(size)}
          </text>
        )}
      </g>
    )
  }

  // Stacked bar total label — rendered on the last bar in the stack
  const renderBarTotal = (props: Record<string, unknown>) => {
    const x = props.x as number, y = props.y as number
    const width = props.width as number
    const total = props._total as number
    if (!total || total <= 0 || width < 20) return null
    return (
      <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={9} fill="#374151" fontWeight={600}>
        ${(total / 1000).toFixed(1)}k
      </text>
    )
  }

  const COLS = 7  // chevron, name, account type, date, type, native, cad

  return (
    <div className="space-y-6">
      {/* Mode toggle */}
      <div className="flex gap-1">
        {(['historical', 'projected'] as const).map(m => (
          <button key={m} onClick={() => setReportMode(m)}
            className={`px-3 py-1.5 text-sm rounded-lg border capitalize ${reportMode === m ? 'bg-primary text-white border-primary' : 'border-border text-muted-foreground hover:bg-muted/50'}`}>
            {m === 'historical' ? 'Historical' : 'Projected'}
          </button>
        ))}
      </div>

      {/* Parameters */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Brokerage</label>
          <select className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm" value={brokerageFilter} onChange={e => setBrokerageFilter(e.target.value)}>
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Account</label>
          <select className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm" value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {allAccts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {reportMode === 'historical' && (
          <>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Year</label>
              <select className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm" value={year} onChange={e => setYear(e.target.value)}>
                <option value="">All years</option>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">From Date</label>
              <DatePicker value={dateFrom || ''} onChange={setDateFrom} max={new Date().toISOString().slice(0, 10)} placeholder="From" highlight={!!dateFrom} className="w-36" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">To Date</label>
              <DatePicker value={dateTo || ''} onChange={setDateTo} max={new Date().toISOString().slice(0, 10)} placeholder="To" highlight={!!dateTo} className="w-36" />
            </div>
          </>
        )}
      </div>

      {reportMode === 'historical' && (isLoading
        ? <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary" /></div>
        : (
          <div className="space-y-6">
            <div className="bg-primary/10 border border-primary/20 rounded-lg px-5 py-3 flex flex-wrap gap-x-6 gap-y-1">
              <span className="text-sm font-medium text-foreground">
                {rows.length} income transactions · Total: <span className="font-bold text-base text-primary">{fmtCAD(totalAll)}</span>
              </span>
              {historicalOverallYieldPct != null && (
                <span className="text-sm text-muted-foreground">
                  Overall Yield: <span className="font-semibold text-primary">{historicalOverallYieldPct.toFixed(2)}%</span>
                  <span className="text-xs text-muted-foreground ml-1">(vs. current portfolio value)</span>
                </span>
              )}
            </div>

            {byYear.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Bar chart — income by year & type, with total labels */}
                <div className="bg-card rounded-xl border border-border p-4">
                  <h3 className="font-semibold text-foreground mb-3 text-sm">Income by Year &amp; Type</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={byYear} margin={{ top: 20, right: 8, bottom: 4, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: number) => fmtCAD(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {incomeTypes.map((type, i) => {
                        const isLast = i === incomeTypes.length - 1
                        return (
                          <Bar key={type} dataKey={type} stackId="a" fill={COLORS[i % COLORS.length]}>
                            {isLast && (
                              <LabelList dataKey="_total" content={renderBarTotal as unknown as React.ReactElement} />
                            )}
                          </Bar>
                        )
                      })}
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Treemap — income by security */}
                <div className="bg-card rounded-xl border border-border p-4">
                  <h3 className="font-semibold text-foreground mb-3 text-sm">Income by Security (top 20)</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <Treemap
                      data={treemapData}
                      dataKey="size"
                      aspectRatio={4 / 3}
                      content={renderTreemapCell as unknown as React.ReactElement}
                    >
                      <Tooltip formatter={(v: number) => fmtCAD(v)} />
                    </Treemap>
                  </ResponsiveContainer>
                </div>

                {/* Pie — income by account type (tax impact) */}
                <div className="bg-card rounded-xl border border-border p-4">
                  <h3 className="font-semibold text-foreground mb-3 text-sm">By Account Type <span className="font-normal text-muted-foreground">(tax impact)</span></h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={historicalAccountTypePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={pieCurrencyLabel as never}>
                        {historicalAccountTypePieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                      </Pie>
                      <Tooltip formatter={(v: number) => fmtCAD(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-3 items-center">
              <input className="bg-background text-foreground border rounded px-3 py-1.5 text-sm w-36" placeholder="Filter ticker…"
                value={tickerFilter} onChange={e => setTickerFilter(e.target.value)} />
              <select className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                <option value="">All types</option>
                {availableTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {(tickerFilter || typeFilter || brokerageFilter) && (
                <span className="text-xs text-muted-foreground">{filtered.length} of {rows.length} rows</span>
              )}
              <div className="flex gap-1 ml-auto">
                {(['account', 'security'] as const).map(v => (
                  <button key={v} onClick={() => setViewMode(v)}
                    className={`px-3 py-1.5 text-xs rounded border capitalize ${viewMode === v ? 'bg-primary text-white border-primary' : 'border-border text-muted-foreground hover:bg-muted/50'}`}>
                    By {v}
                  </button>
                ))}
              </div>
              {viewMode === 'account' && (
                <div className="flex gap-2 text-xs text-muted-foreground">
                  <button
                    onClick={() => { setExpandedBrokerages(new Set(tree.map(b => b.key))); setExpandedAccounts(new Set()); setExpandedSecurities(new Set()) }}
                    className="px-2 py-1 rounded border border-border hover:bg-muted/50"
                  >Expand all brokerages</button>
                  <button
                    onClick={() => { setExpandedBrokerages(new Set()); setExpandedAccounts(new Set()); setExpandedSecurities(new Set()) }}
                    className="px-2 py-1 rounded border border-border hover:bg-muted/50"
                  >Collapse all</button>
                </div>
              )}
            </div>

            {/* Hierarchical table */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm divide-y divide-border">
                  <thead className="bg-muted/50">
                    <tr className="text-xs text-muted-foreground uppercase">
                      <th className="w-10 px-2 py-2.5" />
                      <th className="px-3 py-2.5 text-left font-semibold">Name / Description</th>
                      <SortTh label="Account Type"  col="account_type"     sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                      <SortTh label="Date"          col="date"             sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                      <SortTh label="Type"          col="transaction_type" sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                      <SortTh label="Native"        col="amount_native"    sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                      <SortTh label="CAD"           col="amount_cad"       sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {viewMode === 'security' ? (
                      <>
                        {incomeSecurityGroups.length === 0 && (
                          <tr><td colSpan={COLS} className="px-4 py-8 text-center text-muted-foreground">No income transactions found.</td></tr>
                        )}
                        {incomeSecurityGroups.map(sec => (
                          <Fragment key={sec.key}>
                            {/* Security header */}
                            <tr className="bg-accent">
                              <td className="px-3 py-2" />
                              <td className="px-3 py-2 font-mono font-semibold text-foreground text-sm" colSpan={5}>
                                <TickerLink securityId={sec.security_id} ticker={sec.ticker} />
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  {sec.accounts.length} account{sec.accounts.length !== 1 ? 's' : ''}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right font-bold text-primary">{fmtCAD(sec.total)}</td>
                            </tr>

                            {sec.accounts.map(acct => (
                              <Fragment key={acct.key}>
                                {acct.rows.map((item, i) => (
                                  <tr key={i} className="hover:bg-muted/50">
                                    <td className="px-3 py-1.5 text-muted-foreground text-xs">—</td>
                                    <td className="px-3 py-1.5 font-mono text-xs font-medium whitespace-nowrap">
                                      <TickerLink securityId={item.security_id} ticker={item.ticker} className="text-primary" />
                                    </td>
                                    <td className="px-3 py-1.5"><AccountTypeBadge type={item.account_type} /></td>
                                    <td className="px-3 py-1.5 text-xs text-muted-foreground whitespace-nowrap">{item.date}</td>
                                    <td className="px-3 py-1.5">
                                      <span className="px-1.5 py-0.5 bg-green-50 text-green-600 dark:text-green-400 rounded text-xs whitespace-nowrap">{item.transaction_type}</span>
                                    </td>
                                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground whitespace-nowrap font-mono">{item.currency} {getPref('hideValues') ? '••••••' : parseFloat(item.amount_native).toFixed(2)}</td>
                                    <td className="px-3 py-1.5 text-right text-xs font-semibold text-emerald-600 dark:text-emerald-400">{fmtCAD(item.amount_cad)}</td>
                                  </tr>
                                ))}
                                <tr className="bg-primary/10 border-t border-primary/20 text-xs font-semibold">
                                  <td className="px-3 py-1.5 text-primary" colSpan={1}>{acct.rows.length} txns</td>
                                  <td className="px-3 py-1.5 text-primary" colSpan={5}>{acct.account} subtotal</td>
                                  <td className="px-3 py-1.5 text-right text-primary">{fmtCAD(acct.total)}</td>
                                </tr>
                              </Fragment>
                            ))}
                          </Fragment>
                        ))}
                      </>
                    ) : (
                    <>
                    {tree.length === 0 && (
                      <tr><td colSpan={COLS} className="px-4 py-8 text-center text-muted-foreground">No income transactions found.</td></tr>
                    )}
                    {tree.map(brok => (
                      <Fragment key={brok.key}>
                        {/* Brokerage row */}
                        <tr
                          className="bg-accent hover:bg-accent cursor-pointer select-none"
                          onClick={() => toggleBrokerage(brok.key)}
                        >
                          <td className="px-3 py-2 text-muted-foreground">
                            {expandedBrokerages.has(brok.key)
                              ? <ChevronDown className="h-4 w-4" />
                              : <ChevronRight className="h-4 w-4" />}
                          </td>
                          <td className="px-3 py-2 font-semibold text-foreground" colSpan={5}>
                            {brok.brokerage}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {brok.accounts.length} account{brok.accounts.length !== 1 ? 's' : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-primary">{fmtCAD(brok.total)}</td>
                        </tr>

                        {expandedBrokerages.has(brok.key) && brok.accounts.map(acct => (
                          <Fragment key={acct.key}>
                            {/* Account row */}
                            <tr
                              className="bg-primary/10 hover:bg-primary/15 cursor-pointer select-none"
                              onClick={() => toggleAccount(acct.key)}
                            >
                              <td className="pl-6 pr-2 py-1.5 text-primary/60">
                                {expandedAccounts.has(acct.key)
                                  ? <ChevronDown className="h-3.5 w-3.5" />
                                  : <ChevronRight className="h-3.5 w-3.5" />}
                              </td>
                              <td className="pr-3 py-1.5 text-primary text-sm" colSpan={5}>
                                {acct.account}
                                <span className="ml-2"><AccountTypeBadge type={acct.account_type} /></span>
                                <span className="ml-2 text-xs font-normal text-primary/60">
                                  {acct.securities.length} securit{acct.securities.length !== 1 ? 'ies' : 'y'}
                                </span>
                              </td>
                              <td className="pr-3 py-1.5 text-right font-semibold text-primary text-sm">{fmtCAD(acct.total)}</td>
                            </tr>

                            {expandedAccounts.has(acct.key) && acct.securities.map(sec => (
                              <Fragment key={sec.key}>
                                {/* Security row */}
                                <tr
                                  className="hover:bg-muted/50 cursor-pointer select-none"
                                  onClick={() => toggleSecurity(sec.key)}
                                >
                                  <td className="pl-10 pr-2 py-1.5 text-muted-foreground">
                                    {expandedSecurities.has(sec.key)
                                      ? <ChevronDown className="h-3 w-3" />
                                      : <ChevronRight className="h-3 w-3" />}
                                  </td>
                                  <td className="pr-3 py-1.5 font-mono font-semibold text-primary text-sm">
                                    <TickerLink securityId={sec.security_id} ticker={sec.ticker} />
                                  </td>
                                  <td className="pr-3 py-1.5 text-xs text-muted-foreground">
                                    {sec.transactions.length} txn{sec.transactions.length !== 1 ? 's' : ''}
                                  </td>
                                  <td className="pr-3 py-1.5 text-xs text-muted-foreground" colSpan={3} />
                                  <td className="pr-3 py-1.5 text-right text-sm text-emerald-600 dark:text-emerald-400 font-medium">{fmtCAD(sec.total)}</td>
                                </tr>

                                {expandedSecurities.has(sec.key) && sec.transactions.map((item, i) => (
                                  <tr key={i} className="bg-card hover:bg-muted/50">
                                    <td className="pl-14 pr-2 py-1 text-muted-foreground/50 text-xs">—</td>
                                    <td className="pr-3 py-1 text-xs text-muted-foreground whitespace-nowrap">
                                      {item.account_name}
                                    </td>
                                    <td className="pr-3 py-1"><AccountTypeBadge type={item.account_type} /></td>
                                    <td className="pr-3 py-1 text-xs text-muted-foreground whitespace-nowrap">{item.date}</td>
                                    <td className="pr-3 py-1">
                                      <span className="px-1.5 py-0.5 bg-green-50 text-green-600 dark:text-green-400 rounded text-xs whitespace-nowrap">
                                        {item.transaction_type}
                                      </span>
                                    </td>
                                    <td className="pr-3 py-1 text-right text-xs text-muted-foreground whitespace-nowrap font-mono">
                                      {item.currency} {getPref('hideValues') ? '••••••' : parseFloat(item.amount_native).toFixed(2)}
                                    </td>
                                    <td className="pr-3 py-1 text-right text-xs font-semibold text-emerald-600 dark:text-emerald-400">{fmtCAD(item.amount_cad)}</td>
                                  </tr>
                                ))}
                              </Fragment>
                            ))}
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                    </>
                    )}
                  </tbody>
                  {filtered.length > 0 && (
                    <tfoot className="bg-muted/50 border-t-2 border-border font-semibold text-sm">
                      <tr>
                        <td className="px-4 py-2.5 text-muted-foreground" colSpan={COLS - 1}>{filtered.length} transactions total</td>
                        <td className="px-4 py-2.5 text-right text-primary">{fmtCAD(totalFiltered)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        ))}

      {reportMode === 'projected' && (
        projectedLoading
          ? <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary" /></div>
          : (
            <div className="space-y-6">
              <div className="bg-primary/10 border border-primary/20 rounded-lg px-5 py-3 flex flex-wrap gap-x-6 gap-y-1">
                <span className="text-sm font-medium text-foreground">
                  Projected Annual Income: <span className="font-bold text-base text-primary">{fmtCAD(projectedSubtotals.total)}</span>
                </span>
                <span className="text-sm text-muted-foreground">
                  Dividend: <span className="font-semibold text-emerald-600 dark:text-emerald-400">{fmtCAD(projectedSubtotals.dividend)}</span>
                </span>
                <span className="text-sm text-muted-foreground">
                  Interest: <span className="font-semibold text-primary">{fmtCAD(projectedSubtotals.interest)}</span>
                </span>
                {projectedOverallYieldPct != null && (
                  <span className="text-sm text-muted-foreground">
                    Overall Yield: <span className="font-semibold text-primary">{projectedOverallYieldPct.toFixed(2)}%</span>
                    <span className="text-xs text-muted-foreground ml-1">(of current portfolio value)</span>
                  </span>
                )}
              </div>

              {projectedChartData.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-card rounded-xl border border-border p-4">
                    <h3 className="font-semibold text-foreground mb-3 text-sm">Projected Income by Security (top 15 + Other)</h3>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={projectedChartData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="ticker" tick={{ fontSize: 10 }} interval={0} angle={-40} textAnchor="end" height={60} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} />
                        <Tooltip formatter={(v: number) => fmtCAD(v)} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="DIVIDEND" name="Dividend" stackId="a" fill={COLORS[0]} />
                        <Bar dataKey="INTEREST" name="Interest" stackId="a" fill={COLORS[1]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="bg-card rounded-xl border border-border p-4">
                    <h3 className="font-semibold text-foreground mb-3 text-sm">Dividend vs. Interest</h3>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={projectedPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={pieCurrencyLabel as never}>
                          {projectedPieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                        </Pie>
                        <Tooltip formatter={(v: number) => fmtCAD(v)} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="bg-card rounded-xl border border-border p-4">
                    <h3 className="font-semibold text-foreground mb-3 text-sm">By Account Type <span className="font-normal text-muted-foreground">(tax impact)</span></h3>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={projectedAccountTypePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={pieCurrencyLabel as never}>
                          {projectedAccountTypePieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                        </Pie>
                        <Tooltip formatter={(v: number) => fmtCAD(v)} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="bg-card rounded-xl border border-border p-4">
                    <h3 className="font-semibold text-foreground mb-3 text-sm">By Security Class</h3>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={projectedClassPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={pieCurrencyLabel as never}>
                          {projectedClassPieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                        </Pie>
                        <Tooltip formatter={(v: number) => fmtCAD(v)} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm divide-y divide-border">
                    <thead className="bg-muted/50">
                      <tr className="text-xs text-muted-foreground uppercase">
                        <SortTh label="Symbol" col="ticker" sort={projSort} toggle={projToggle} className="px-3 py-2.5 text-left" />
                        <SortTh label="Name" col="security_name" sort={projSort} toggle={projToggle} className="px-3 py-2.5 text-left" />
                        <SortTh label="Qty Held" col="quantity" sort={projSort} toggle={projToggle} className="px-3 py-2.5 text-right" />
                        <SortTh label="Account Type" col="account_type" sort={projSort} toggle={projToggle} className="px-3 py-2.5 text-left" />
                        <SortTh label="Type" col="rate_type" sort={projSort} toggle={projToggle} className="px-3 py-2.5 text-left" />
                        <SortTh label="Rate" col="rate_pct" sort={projSort} toggle={projToggle} className="px-3 py-2.5 text-right" />
                        <SortTh label="Projected Annual Income (CAD)" col="projected_annual_income_cad" sort={projSort} toggle={projToggle} className="px-3 py-2.5 text-right" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {projectedSorted.length === 0 && (
                        <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No current holdings found.</td></tr>
                      )}
                      {projectedSorted.map((r, i) => (
                        <tr key={`${r.security_id}-${r.account_type}-${i}`} className="hover:bg-muted/50">
                          <td className="px-3 py-2 font-mono font-semibold">
                            <TickerLink securityId={r.security_id} ticker={r.ticker} className="text-primary" />
                          </td>
                          <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{r.security_name || '—'}</td>
                          <td className="px-3 py-2 text-right text-foreground">{parseFloat(r.quantity).toLocaleString('en-CA', { maximumFractionDigits: 4 })}</td>
                          <td className="px-3 py-2"><AccountTypeBadge type={r.account_type} /></td>
                          <td className="px-3 py-2">
                            {r.rate_type && (() => {
                              const estimated = r.rate_type.endsWith('_EST')
                              const dividend = isDividendType(r.rate_type)
                              return (
                                <span
                                  className={`px-1.5 py-0.5 rounded text-xs whitespace-nowrap ${
                                    estimated
                                      ? 'bg-amber-50 text-amber-700 border border-dashed border-amber-300'
                                      : dividend ? 'bg-green-50 text-green-600 dark:text-green-400' : 'bg-primary/10 text-primary'
                                  }`}
                                  title={estimated ? 'No live yield or manual rate on file — estimated from actual trailing-12-month payments instead' : undefined}
                                >
                                  {dividend ? 'Dividend' : 'Interest'}{estimated ? ' (Est.)' : ''}
                                </span>
                              )
                            })()}
                          </td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{r.rate_pct ? `${parseFloat(r.rate_pct).toFixed(2)}%` : '—'}</td>
                          <td className="px-3 py-2 text-right font-semibold text-emerald-600 dark:text-emerald-400">{r.projected_annual_income_cad ? fmtCAD(r.projected_annual_income_cad) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    {projectedSorted.length > 0 && (
                      <tfoot className="bg-muted/50 border-t-2 border-border font-semibold text-sm">
                        <tr>
                          <td className="px-4 py-2.5 text-muted-foreground" colSpan={4}>Dividend Subtotal</td>
                          <td className="px-4 py-2.5" colSpan={2} />
                          <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400">{fmtCAD(projectedSubtotals.dividend)}</td>
                        </tr>
                        <tr>
                          <td className="px-4 py-2.5 text-muted-foreground" colSpan={4}>Interest Subtotal</td>
                          <td className="px-4 py-2.5" colSpan={2} />
                          <td className="px-4 py-2.5 text-right text-primary">{fmtCAD(projectedSubtotals.interest)}</td>
                        </tr>
                        {projectedByAccountType.map(([type, value]) => (
                          <tr key={type} className="border-t border-border">
                            <td className="px-4 py-2 text-muted-foreground font-normal" colSpan={3}>
                              <AccountTypeBadge type={type} /> <span className="ml-1">Subtotal</span>
                            </td>
                            <td className="px-4 py-2" colSpan={3} />
                            <td className="px-4 py-2 text-right text-foreground">{fmtCAD(value)}</td>
                          </tr>
                        ))}
                        <tr className="border-t border-border">
                          <td className="px-4 py-2.5 text-foreground" colSpan={4}>Grand Total</td>
                          <td className="px-4 py-2.5" colSpan={2} />
                          <td className="px-4 py-2.5 text-right text-primary">{fmtCAD(projectedSubtotals.total)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </div>
          )
      )}

    </div>
  )
}
