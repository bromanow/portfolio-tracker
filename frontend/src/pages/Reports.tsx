import { useState, useMemo, Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList,
  Treemap, Cell, ResponsiveContainer, LineChart, Line,
} from 'recharts'
import {
  ChevronUp, ChevronDown, ChevronsUpDown, ChevronRight, ChevronLeft,
  TrendingUp, DollarSign, Landmark, RefreshCw, X, PanelLeftClose, PanelLeftOpen,
  Activity, Calculator, CalendarRange, FileSearch, Globe,
} from 'lucide-react'
import {
  getRealizedPnl, getInvestmentIncome, getAccounts, getCashStatement,
  getPortfolioHistory, getPortfolioContinuity,
  getMonthlyReturns, getReturnsDetail, getFxRates,
} from '../api/client'
import type { Account, IncomeItem, CashStatementRow, PortfolioHistoryPoint, ContinuityReport, MonthlyReturnRow, ReturnDetailRow, FXRate } from '../api/client'
import MultiSelectDropdown from '../components/MultiSelectDropdown'

// ── Shared helpers ────────────────────────────────────────────────────────────

function fmtCAD(val: number | string | null | undefined) {
  if (val === null || val === undefined || val === '') return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(n)
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#6b7280']

type SortDir = 'asc' | 'desc'

function useSortState(defaultCol: string, defaultDir: SortDir = 'asc') {
  const [sort, setSort] = useState({ col: defaultCol, dir: defaultDir })
  const toggle = (col: string) => setSort(s => ({ col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' }))
  return { sort, toggle }
}

function SortTh({ label, col, sort, toggle, className = '' }: {
  label: string; col: string; sort: { col: string; dir: SortDir }; toggle: (c: string) => void; className?: string
}) {
  const active = sort.col === col
  return (
    <th className={`cursor-pointer select-none hover:bg-gray-100 ${className}`} onClick={() => toggle(col)}>
      <div className="flex items-center gap-1">
        {label}
        {active
          ? sort.dir === 'asc' ? <ChevronUp className="h-3 w-3 text-blue-600" /> : <ChevronDown className="h-3 w-3 text-blue-600" />
          : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
      </div>
    </th>
  )
}

function sortRows<T>(rows: T[], col: string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const va = String((a as Record<string, unknown>)[col] ?? '')
    const vb = String((b as Record<string, unknown>)[col] ?? '')
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

// ── Pagination bar (shared) ───────────────────────────────────────────────────
interface PaginationBarProps {
  page: number
  totalPages: number
  pageSize: number
  totalRows: number
  setPage: React.Dispatch<React.SetStateAction<number>>
  setPageSize: (n: number) => void
}

function PaginationBar({ page, totalPages, pageSize, totalRows, setPage, setPageSize }: PaginationBarProps) {
  const start = totalRows === 0 ? 0 : (page - 1) * pageSize + 1
  const end   = Math.min(page * pageSize, totalRows)
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600 select-none">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Rows per page:</span>
        <select
          value={pageSize}
          onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
          className="border border-gray-300 rounded px-1.5 py-0.5 text-xs"
        >
          {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">
          {totalRows === 0 ? 'No rows' : `${start}–${end} of ${totalRows}`}
        </span>
        <div className="flex gap-1">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="p-1 rounded hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Realized Gains ────────────────────────────────────────────────────────────
type GainRow = {
  date: string; ticker: string; quantity: string
  proceeds_cad: string; acb_cad: string; gain_cad: string
  account_id: number; account_name: string; brokerage_name: string
}

function RealizedGainsReport() {
  const [accountId, setAccountId]       = useState('')
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [year, setYear]                 = useState('')
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: 8 }, (_, i) => currentYear - i)

  const { data: gains = [], isLoading } = useQuery({
    queryKey: ['pnl', accountId, year],
    queryFn: () => getRealizedPnl({
      account_id: accountId ? Number(accountId) : undefined,
      year: year ? Number(year) : undefined,
    }),
  })
  const { sort, toggle } = useSortState('date', 'desc')
  const [tickerFilter, setTickerFilter] = useState('')
  const [gainFilter, setGainFilter] = useState<'all' | 'gains' | 'losses'>('all')

  const rows = gains as GainRow[]

  // Unique brokerages from current data set
  const brokerages = useMemo(() =>
    [...new Set(rows.map(r => r.brokerage_name).filter(Boolean))].sort()
  , [rows])

  const filtered = useMemo(() => rows.filter(g => {
    if (brokerageFilter && g.brokerage_name !== brokerageFilter) return false
    if (tickerFilter && !g.ticker.toLowerCase().includes(tickerFilter.toLowerCase())) return false
    if (gainFilter === 'gains'  && parseFloat(g.gain_cad) <  0) return false
    if (gainFilter === 'losses' && parseFloat(g.gain_cad) >= 0) return false
    return true
  }), [rows, brokerageFilter, tickerFilter, gainFilter])

  // Group by account, then sort within each group
  const groupedRows = useMemo(() => {
    // Collect unique accounts in alphabetical order (brokerage + account name)
    const acctOrder = [...new Set(filtered.map(r => r.account_name))].sort((a, b) => {
      const ra = filtered.find(r => r.account_name === a)!
      const rb = filtered.find(r => r.account_name === b)!
      const brok = (ra.brokerage_name || '').localeCompare(rb.brokerage_name || '')
      return brok !== 0 ? brok : a.localeCompare(b)
    })
    return acctOrder.map(acctName => {
      const acctRows = filtered.filter(r => r.account_name === acctName)
      const sorted = sortRows(acctRows, sort.col, sort.dir)
      const brokerage = sorted[0]?.brokerage_name || ''
      const proceeds  = sorted.reduce((s, r) => s + parseFloat(r.proceeds_cad), 0)
      const acb       = sorted.reduce((s, r) => s + parseFloat(r.acb_cad), 0)
      const net       = sorted.reduce((s, r) => s + parseFloat(r.gain_cad), 0)
      return { acctName, brokerage, rows: sorted, proceeds, acb, net }
    })
  }, [filtered, sort])

  const byYear = useMemo(() => {
    const m: Record<number, { gain: number; loss: number; net: number }> = {}
    for (const g of rows) {
      const yr = new Date(g.date).getFullYear()
      if (!m[yr]) m[yr] = { gain: 0, loss: 0, net: 0 }
      const v = parseFloat(g.gain_cad)
      if (v >= 0) m[yr].gain += v; else m[yr].loss += v
      m[yr].net += v
    }
    return Object.entries(m).sort((a, b) => Number(a[0]) - Number(b[0])).map(([yr, v]) => ({
      year: yr, gain: +v.gain.toFixed(2), loss: +v.loss.toFixed(2), net: +v.net.toFixed(2),
    }))
  }, [rows])

  const byTicker = useMemo(() => {
    const m: Record<string, number> = {}
    for (const g of rows) m[g.ticker] = (m[g.ticker] || 0) + parseFloat(g.gain_cad)
    return Object.entries(m).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12)
      .map(([ticker, net]) => ({ ticker, net: +net.toFixed(2) }))
  }, [rows])

  const totalAll      = rows.reduce((s, g)     => s + parseFloat(g.gain_cad),    0)
  const totalFiltered = filtered.reduce((s, g) => s + parseFloat(g.gain_cad),    0)
  const totalProceeds = filtered.reduce((s, g) => s + parseFloat(g.proceeds_cad), 0)
  const totalAcb      = filtered.reduce((s, g) => s + parseFloat(g.acb_cad),     0)

  const COLS = 8  // total column count including brokerage + account

  return (
    <div className="space-y-6">
      {/* Parameters */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={brokerageFilter} onChange={e => setBrokerageFilter(e.target.value)}>
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Account</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {(accounts as Account[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Year</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={year} onChange={e => setYear(e.target.value)}>
            <option value="">All years</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {isLoading
        ? <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 rounded-full border-b-2 border-blue-600" /></div>
        : (
          <div className="space-y-6">
            <div className={`rounded-lg px-5 py-3 ${totalAll >= 0 ? 'bg-emerald-50 border border-emerald-200' : 'bg-red-50 border border-red-200'}`}>
              <span className="text-sm font-medium text-gray-700">{rows.length} taxable dispositions · Total net gain: </span>
              <span className={`font-bold text-base ${totalAll >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmtCAD(totalAll)}</span>
              <span className="text-xs text-gray-400 ml-2">(50% taxable inclusion = {fmtCAD(totalAll * 0.5)})</span>
            </div>

            {byYear.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-800 mb-3 text-sm">Net Gain/Loss by Year</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={byYear} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: number) => fmtCAD(v)} />
                      <Bar dataKey="gain" name="Gains" fill="#10b981" stackId="a" />
                      <Bar dataKey="loss" name="Losses" fill="#ef4444" stackId="a" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-800 mb-3 text-sm">Net Gain/Loss by Security (top 12)</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={byTicker} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 40 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                      <YAxis type="category" dataKey="ticker" tick={{ fontSize: 10 }} width={55} />
                      <Tooltip formatter={(v: number) => fmtCAD(v)} />
                      <Bar dataKey="net" name="Net" radius={[0, 3, 3, 0]}>
                        {byTicker.map((entry, idx) => <Cell key={idx} fill={entry.net >= 0 ? '#10b981' : '#ef4444'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-3 items-center">
              <input className="border rounded px-3 py-1.5 text-sm w-36" placeholder="Filter ticker…"
                value={tickerFilter} onChange={e => setTickerFilter(e.target.value)} />
              {(['all', 'gains', 'losses'] as const).map(f => (
                <button key={f} onClick={() => setGainFilter(f)}
                  className={`px-3 py-1.5 text-sm rounded border capitalize ${gainFilter === f ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                  {f}
                </button>
              ))}
              {(tickerFilter || gainFilter !== 'all' || brokerageFilter) && (
                <span className="text-xs text-gray-400">{filtered.length} of {rows.length} rows</span>
              )}
            </div>

            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm divide-y divide-gray-100">
                  <thead className="bg-gray-50">
                    <tr className="text-xs text-gray-500 uppercase">
                      <SortTh label="Brokerage"      col="brokerage_name" sort={sort} toggle={toggle} className="px-4 py-2.5 text-left" />
                      <SortTh label="Account"        col="account_name"   sort={sort} toggle={toggle} className="px-4 py-2.5 text-left" />
                      <SortTh label="Date"           col="date"           sort={sort} toggle={toggle} className="px-4 py-2.5 text-left" />
                      <SortTh label="Ticker"         col="ticker"         sort={sort} toggle={toggle} className="px-4 py-2.5 text-left" />
                      <SortTh label="Qty"            col="quantity"       sort={sort} toggle={toggle} className="px-4 py-2.5 text-right" />
                      <SortTh label="Proceeds (CAD)" col="proceeds_cad"   sort={sort} toggle={toggle} className="px-4 py-2.5 text-right" />
                      <SortTh label="ACB (CAD)"      col="acb_cad"        sort={sort} toggle={toggle} className="px-4 py-2.5 text-right" />
                      <SortTh label="Net Gain"       col="gain_cad"       sort={sort} toggle={toggle} className="px-4 py-2.5 text-right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {groupedRows.length === 0 && (
                      <tr><td colSpan={COLS} className="px-4 py-8 text-center text-gray-400">No realized gains/losses found.</td></tr>
                    )}
                    {groupedRows.map(({ acctName, brokerage, rows: acctRows, proceeds, acb, net }) => (
                      <Fragment key={acctName}>
                        {acctRows.map((g, i) => {
                          const gain = parseFloat(g.gain_cad)
                          return (
                            <tr key={`${acctName}-${i}`} className="hover:bg-gray-50">
                              <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{g.brokerage_name}</td>
                              <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap max-w-[10rem] truncate" title={acctName}>{acctName}</td>
                              <td className="px-4 py-2 text-gray-600 text-xs whitespace-nowrap">{g.date}</td>
                              <td className="px-4 py-2 font-mono font-semibold text-blue-700">{g.ticker}</td>
                              <td className="px-4 py-2 text-right text-gray-600">{parseFloat(g.quantity).toLocaleString('en-CA', { maximumFractionDigits: 4 })}</td>
                              <td className="px-4 py-2 text-right">{fmtCAD(g.proceeds_cad)}</td>
                              <td className="px-4 py-2 text-right text-gray-500">{fmtCAD(g.acb_cad)}</td>
                              <td className={`px-4 py-2 text-right font-semibold ${gain >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{fmtCAD(gain)}</td>
                            </tr>
                          )
                        })}
                        {/* Account subtotal row */}
                        <tr className="bg-blue-50 border-t border-blue-200 text-xs font-semibold">
                          <td className="px-4 py-1.5 text-blue-700 whitespace-nowrap">{brokerage}</td>
                          <td className="px-4 py-1.5 text-blue-800 whitespace-nowrap max-w-[10rem] truncate" title={acctName}>{acctName} subtotal</td>
                          <td className="px-4 py-1.5 text-blue-600 text-right" colSpan={3}>{acctRows.length} dispositions</td>
                          <td className="px-4 py-1.5 text-right text-blue-800">{fmtCAD(proceeds)}</td>
                          <td className="px-4 py-1.5 text-right text-blue-600">{fmtCAD(acb)}</td>
                          <td className={`px-4 py-1.5 text-right ${net >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmtCAD(net)}</td>
                        </tr>
                      </Fragment>
                    ))}
                  </tbody>
                  {filtered.length > 0 && (
                    <tfoot className="bg-gray-50 border-t-2 border-gray-300 font-semibold text-sm">
                      <tr>
                        <td className="px-4 py-2.5 text-gray-500" colSpan={4}>{filtered.length} dispositions total</td>
                        <td className="px-4 py-2.5 text-right text-gray-500">—</td>
                        <td className="px-4 py-2.5 text-right">{fmtCAD(totalProceeds)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-500">{fmtCAD(totalAcb)}</td>
                        <td className={`px-4 py-2.5 text-right ${totalFiltered >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmtCAD(totalFiltered)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}
    </div>
  )
}

// ── Investment Income ─────────────────────────────────────────────────────────

type IncomeTreeTx   = IncomeItem
type IncomeTreeSec  = { key: string; ticker: string; total: number; transactions: IncomeTreeTx[] }
type IncomeTreeAcct = { key: string; account: string; brokerage: string; total: number; securities: IncomeTreeSec[] }
type IncomeTreeBrok = { key: string; brokerage: string; total: number; accounts: IncomeTreeAcct[] }

function IncomeReport() {
  const [accountId, setAccountId]             = useState('')
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [year, setYear]                       = useState('')
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: 8 }, (_, i) => currentYear - i)

  const { data: income = [], isLoading } = useQuery({
    queryKey: ['income', accountId, year],
    queryFn: () => getInvestmentIncome({
      account_id: accountId ? Number(accountId) : undefined,
      year: year ? Number(year) : undefined,
    }),
  })
  const { sort, toggle } = useSortState('date', 'desc')
  const [tickerFilter, setTickerFilter] = useState('')
  const [typeFilter, setTypeFilter]     = useState('')

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
    return true
  }), [rows, brokerageFilter, tickerFilter, typeFilter])

  // Build hierarchical tree: Brokerage → Account → Security → Transactions
  const tree = useMemo((): IncomeTreeBrok[] => {
    const brokMap = new Map<string, IncomeTreeBrok>()
    for (const item of filtered) {
      const bKey = item.brokerage_name
      if (!brokMap.has(bKey)) brokMap.set(bKey, { key: bKey, brokerage: bKey, total: 0, accounts: [] })
      const brok = brokMap.get(bKey)!

      const aKey = `${bKey}|${item.account_name}`
      let acct = brok.accounts.find(a => a.key === aKey)
      if (!acct) { acct = { key: aKey, account: item.account_name, brokerage: bKey, total: 0, securities: [] }; brok.accounts.push(acct) }

      const sKey = `${aKey}|${item.ticker || '(none)'}`
      let sec = acct.securities.find(s => s.key === sKey)
      if (!sec) { sec = { key: sKey, ticker: item.ticker || '(none)', total: 0, transactions: [] }; acct.securities.push(sec) }

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
    for (const item of rows) {
      if (!m[item.year]) m[item.year] = {}
      m[item.year][item.transaction_type] = (m[item.year][item.transaction_type] || 0) + parseFloat(item.amount_cad)
    }
    const allTypes = [...new Set(rows.map(i => i.transaction_type))]
    const data = Object.entries(m).sort((a, b) => Number(a[0]) - Number(b[0])).map(([yr, v]) => ({
      year: yr,
      ...Object.fromEntries(allTypes.map(t => [t, +((v[t] || 0).toFixed(2))])),
      _total: +allTypes.reduce((s, t) => s + (v[t] || 0), 0).toFixed(2),
    }))
    return { byYear: data, incomeTypes: allTypes }
  }, [rows])

  // Treemap data — income by security (positive only, top 20)
  const treemapData = useMemo(() => {
    const m: Record<string, number> = {}
    for (const item of rows) {
      const k = item.ticker || '(none)'
      m[k] = (m[k] || 0) + parseFloat(item.amount_cad)
    }
    return Object.entries(m)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, size], i) => ({ name, size: +size.toFixed(2), fill: COLORS[i % COLORS.length] }))
  }, [rows])

  const totalAll      = rows.reduce((s, i)     => s + parseFloat(i.amount_cad), 0)
  const totalFiltered = filtered.reduce((s, i) => s + parseFloat(i.amount_cad), 0)

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

  const COLS = 6  // chevron, name, date, type, native, cad

  return (
    <div className="space-y-6">
      {/* Parameters */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={brokerageFilter} onChange={e => setBrokerageFilter(e.target.value)}>
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Account</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {(accounts as Account[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Year</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={year} onChange={e => setYear(e.target.value)}>
            <option value="">All years</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {isLoading
        ? <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 rounded-full border-b-2 border-blue-600" /></div>
        : (
          <div className="space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-5 py-3">
              <span className="text-sm font-medium text-gray-700">{rows.length} income transactions · Total: </span>
              <span className="font-bold text-base text-blue-700">{fmtCAD(totalAll)}</span>
            </div>

            {byYear.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Bar chart — income by year & type, with total labels */}
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-800 mb-3 text-sm">Income by Year &amp; Type</h3>
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
                <div className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="font-semibold text-gray-800 mb-3 text-sm">Income by Security (top 20)</h3>
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
              </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap gap-3 items-center">
              <input className="border rounded px-3 py-1.5 text-sm w-36" placeholder="Filter ticker…"
                value={tickerFilter} onChange={e => setTickerFilter(e.target.value)} />
              <select className="border rounded px-3 py-1.5 text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                <option value="">All types</option>
                {availableTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {(tickerFilter || typeFilter || brokerageFilter) && (
                <span className="text-xs text-gray-400">{filtered.length} of {rows.length} rows</span>
              )}
              <div className="ml-auto flex gap-2 text-xs text-gray-500">
                <button
                  onClick={() => { setExpandedBrokerages(new Set(tree.map(b => b.key))); setExpandedAccounts(new Set()); setExpandedSecurities(new Set()) }}
                  className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
                >Expand all brokerages</button>
                <button
                  onClick={() => { setExpandedBrokerages(new Set()); setExpandedAccounts(new Set()); setExpandedSecurities(new Set()) }}
                  className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
                >Collapse all</button>
              </div>
            </div>

            {/* Hierarchical table */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm divide-y divide-gray-100">
                  <thead className="bg-gray-50">
                    <tr className="text-xs text-gray-500 uppercase">
                      <th className="w-10 px-2 py-2.5" />
                      <th className="px-3 py-2.5 text-left font-semibold">Name / Description</th>
                      <SortTh label="Date"          col="date"             sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                      <SortTh label="Type"          col="transaction_type" sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                      <SortTh label="Native"        col="amount_native"    sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                      <SortTh label="CAD"           col="amount_cad"       sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {tree.length === 0 && (
                      <tr><td colSpan={COLS} className="px-4 py-8 text-center text-gray-400">No income transactions found.</td></tr>
                    )}
                    {tree.map(brok => (
                      <Fragment key={brok.key}>
                        {/* Brokerage row */}
                        <tr
                          className="bg-slate-100 hover:bg-slate-200 cursor-pointer select-none"
                          onClick={() => toggleBrokerage(brok.key)}
                        >
                          <td className="px-3 py-2 text-slate-500">
                            {expandedBrokerages.has(brok.key)
                              ? <ChevronDown className="h-4 w-4" />
                              : <ChevronRight className="h-4 w-4" />}
                          </td>
                          <td className="px-3 py-2 font-semibold text-slate-800" colSpan={4}>
                            {brok.brokerage}
                            <span className="ml-2 text-xs font-normal text-slate-500">
                              {brok.accounts.length} account{brok.accounts.length !== 1 ? 's' : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-blue-700">{fmtCAD(brok.total)}</td>
                        </tr>

                        {expandedBrokerages.has(brok.key) && brok.accounts.map(acct => (
                          <Fragment key={acct.key}>
                            {/* Account row */}
                            <tr
                              className="bg-blue-50 hover:bg-blue-100 cursor-pointer select-none"
                              onClick={() => toggleAccount(acct.key)}
                            >
                              <td className="pl-6 pr-2 py-1.5 text-blue-400">
                                {expandedAccounts.has(acct.key)
                                  ? <ChevronDown className="h-3.5 w-3.5" />
                                  : <ChevronRight className="h-3.5 w-3.5" />}
                              </td>
                              <td className="pr-3 py-1.5 text-blue-800 text-sm" colSpan={4}>
                                {acct.account}
                                <span className="ml-2 text-xs font-normal text-blue-400">
                                  {acct.securities.length} securit{acct.securities.length !== 1 ? 'ies' : 'y'}
                                </span>
                              </td>
                              <td className="pr-3 py-1.5 text-right font-semibold text-blue-700 text-sm">{fmtCAD(acct.total)}</td>
                            </tr>

                            {expandedAccounts.has(acct.key) && acct.securities.map(sec => (
                              <Fragment key={sec.key}>
                                {/* Security row */}
                                <tr
                                  className="hover:bg-gray-50 cursor-pointer select-none"
                                  onClick={() => toggleSecurity(sec.key)}
                                >
                                  <td className="pl-10 pr-2 py-1.5 text-gray-400">
                                    {expandedSecurities.has(sec.key)
                                      ? <ChevronDown className="h-3 w-3" />
                                      : <ChevronRight className="h-3 w-3" />}
                                  </td>
                                  <td className="pr-3 py-1.5 font-mono font-semibold text-blue-700 text-sm">
                                    {sec.ticker}
                                  </td>
                                  <td className="pr-3 py-1.5 text-xs text-gray-400">
                                    {sec.transactions.length} txn{sec.transactions.length !== 1 ? 's' : ''}
                                  </td>
                                  <td className="pr-3 py-1.5 text-xs text-gray-400" colSpan={2} />
                                  <td className="pr-3 py-1.5 text-right text-sm text-emerald-600 font-medium">{fmtCAD(sec.total)}</td>
                                </tr>

                                {expandedSecurities.has(sec.key) && sec.transactions.map((item, i) => (
                                  <tr key={i} className="bg-white hover:bg-gray-50">
                                    <td className="pl-14 pr-2 py-1 text-gray-300 text-xs">—</td>
                                    <td className="pr-3 py-1 text-xs text-gray-600 whitespace-nowrap">
                                      {item.account_name}
                                    </td>
                                    <td className="pr-3 py-1 text-xs text-gray-500 whitespace-nowrap">{item.date}</td>
                                    <td className="pr-3 py-1">
                                      <span className="px-1.5 py-0.5 bg-green-50 text-green-700 rounded text-xs whitespace-nowrap">
                                        {item.transaction_type}
                                      </span>
                                    </td>
                                    <td className="pr-3 py-1 text-right text-xs text-gray-500 whitespace-nowrap font-mono">
                                      {item.currency} {parseFloat(item.amount_native).toFixed(2)}
                                    </td>
                                    <td className="pr-3 py-1 text-right text-xs font-semibold text-emerald-600">{fmtCAD(item.amount_cad)}</td>
                                  </tr>
                                ))}
                              </Fragment>
                            ))}
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                  {filtered.length > 0 && (
                    <tfoot className="bg-gray-50 border-t-2 border-gray-300 font-semibold text-sm">
                      <tr>
                        <td className="px-4 py-2.5 text-gray-500" colSpan={COLS - 1}>{filtered.length} transactions total</td>
                        <td className="px-4 py-2.5 text-right text-blue-700">{fmtCAD(totalFiltered)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}
    </div>
  )
}

// ── Portfolio Value & Continuity helpers ──────────────────────────────────────

type PortfolioRange = 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL'

function computePortfolioRange(range: PortfolioRange): { fromDate: string | undefined; toDate: string } {
  const today = new Date()
  const toStr = today.toISOString().slice(0, 10)
  if (range === 'ALL') return { fromDate: undefined, toDate: toStr }
  if (range === 'YTD') return { fromDate: `${today.getFullYear()}-01-01`, toDate: toStr }
  const years = range === '1Y' ? 1 : range === '3Y' ? 3 : 5
  const d = new Date(today); d.setFullYear(d.getFullYear() - years)
  return { fromDate: d.toISOString().slice(0, 10), toDate: toStr }
}

function fmtCAD0(val: number | string | null | undefined) {
  if (val === null || val === undefined || val === '') return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n)
}

function fmtCAD0Signed(val: number | string | null | undefined) {
  if (val === null || val === undefined || val === '') return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  const abs = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(n))
  return n < 0 ? `(${abs})` : abs
}

function fmtCADAxis(val: number) {
  if (Math.abs(val) >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (Math.abs(val) >= 1_000)     return `$${(val / 1_000).toFixed(0)}K`
  return `$${val}`
}

function fmtAxisDate(dateStr: string, interval: 'daily' | 'weekly' | 'monthly'): string {
  const d = new Date(dateStr + 'T00:00:00')
  if (interval === 'monthly') return d.toLocaleDateString('en-CA', { month: 'short', year: '2-digit' })
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}

// Shared brokerage → account cascade used by portfolio reports
function useAccountCascade(accts: Account[]) {
  const [brokerageFilter, setBrokerageFilterRaw] = useState('')
  const [selectedAccountIds, setSelectedAccountIds]   = useState<string[]>([])

  const brokerages = useMemo(
    () => [...new Set(accts.map(a => a.brokerage_name))].sort(),
    [accts],
  )
  const accountOptions = useMemo(
    () => accts
      .filter(a => !brokerageFilter || a.brokerage_name === brokerageFilter)
      .map(a => ({ value: String(a.id), label: a.name })),
    [accts, brokerageFilter],
  )
  const setBrokerageFilter = (brok: string) => {
    setBrokerageFilterRaw(brok)
    if (brok) {
      const valid = new Set(accts.filter(a => a.brokerage_name === brok).map(a => String(a.id)))
      setSelectedAccountIds(prev => prev.filter(id => valid.has(id)))
    }
  }
  const accountIds = selectedAccountIds.length > 0 ? selectedAccountIds.join(',') : undefined

  return { brokerageFilter, setBrokerageFilter, brokerages, accountOptions, selectedAccountIds, setSelectedAccountIds, accountIds }
}

// Continuity table (shared between the Continuity report and any future use)
const CONT_ROWS: Array<{ key: keyof ContinuityReport; label: string; sign: 1 | -1 | 0; prefix?: string }> = [
  { key: 'contributions',           label: 'Contributions',               sign:  1, prefix: '+' },
  { key: 'withdrawals',             label: 'Withdrawals',                 sign: -1, prefix: '–' },
  { key: 'transfers',               label: 'Transfers (Net)',             sign:  0, prefix: '±' },
  { key: 'dividends_interest',      label: 'Dividends & Interest',        sign:  1, prefix: '+' },
  { key: 'realized_gains',          label: 'Realized Gains',              sign:  1, prefix: '+' },
  { key: 'fees',                    label: 'Fees & Withholding',          sign: -1, prefix: '–' },
  { key: 'unrealized_gains_change', label: 'Unrealized Gain/Loss Change', sign:  1, prefix: '±' },
]

function ContinuityTable({ data }: { data: ContinuityReport }) {
  const open  = parseFloat(data.opening_balance)
  const close = parseFloat(data.closing_balance)
  const netChange = close - open
  const maxAbs = Math.max(Math.abs(open), ...CONT_ROWS.map(r => Math.abs(parseFloat(data[r.key] as string) || 0)))

  function rowColor(val: number, sign: 1 | -1 | 0) {
    if (sign === 0) return val >= 0 ? 'text-emerald-600' : 'text-red-500'
    if (val > 0) return sign === 1 ? 'text-emerald-600' : 'text-red-500'
    if (val < 0) return sign === -1 ? 'text-emerald-600' : 'text-red-500'
    return 'text-gray-400'
  }
  function barWidth(val: number) {
    if (maxAbs === 0) return '0%'
    return `${Math.min(100, Math.abs(val) / maxAbs * 100).toFixed(1)}%`
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <tbody>
          <tr className="border-b border-gray-200">
            <td className="py-2.5 pr-4 text-gray-500 w-8 text-xs font-mono" />
            <td className="py-2.5 pr-4 font-semibold text-gray-800 w-56">Opening Balance</td>
            <td className="py-2.5 text-right font-bold text-gray-900 w-36 tabular-nums">{fmtCAD0(data.opening_balance)}</td>
            <td className="py-2.5 pl-4 w-48 hidden sm:table-cell"><div className="h-2 bg-blue-200 rounded" style={{ width: barWidth(open) }} /></td>
          </tr>
          {CONT_ROWS.map(({ key, label, sign, prefix }) => {
            const val = parseFloat(data[key] as string) || 0
            if (val === 0 && key === 'transfers') return null
            return (
              <tr key={key} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 pr-4 text-gray-400 text-xs font-mono w-8">{prefix}</td>
                <td className="py-2 pr-4 text-gray-700 w-56">{label}</td>
                <td className={`py-2 text-right font-medium w-36 tabular-nums ${rowColor(val, sign)}`}>{fmtCAD0Signed(val)}</td>
                <td className="py-2 pl-4 w-48 hidden sm:table-cell">
                  <div className={`h-2 rounded ${val >= 0 ? 'bg-emerald-200' : 'bg-red-200'}`} style={{ width: barWidth(val) }} />
                </td>
              </tr>
            )
          })}
          <tr className="border-t-2 border-gray-300">
            <td className="py-3 pr-4 text-gray-500 w-8 text-xs font-mono">=</td>
            <td className="py-3 pr-4 font-bold text-gray-900 w-56">Closing Balance</td>
            <td className="py-3 text-right w-36 tabular-nums">
              <span className="font-bold text-gray-900">{fmtCAD0(data.closing_balance)}</span>
              <span className={`ml-2 text-xs font-medium ${netChange >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                {netChange >= 0 ? '▲' : '▼'} {fmtCAD0(Math.abs(netChange))}
              </span>
            </td>
            <td className="py-3 pl-4 w-48 hidden sm:table-cell"><div className="h-2 bg-blue-400 rounded" style={{ width: barWidth(close) }} /></td>
          </tr>
        </tbody>
      </table>
      {data.period_start && (
        <p className="mt-3 text-xs text-gray-400">
          Period: {data.period_start} → {data.period_end}
        </p>
      )}
      {!data.has_market_prices && (
        <p className="mt-2 text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded">
          Note: Market prices not available for this period — balances reflect book value.
        </p>
      )}
    </div>
  )
}

// ── Portfolio Value Over Time ──────────────────────────────────────────────────

function PortfolioValueReport() {
  const [range, setRange]               = useState<PortfolioRange>('1Y')
  const [chartInterval, setChartInterval] = useState<'daily' | 'weekly' | 'monthly'>('weekly')

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const {
    brokerageFilter, setBrokerageFilter, brokerages,
    accountOptions, selectedAccountIds, setSelectedAccountIds, accountIds,
  } = useAccountCascade(accounts as Account[])

  const { fromDate, toDate } = useMemo(() => computePortfolioRange(range), [range])

  const { data: history = [], isLoading } = useQuery({
    queryKey: ['portfolio-history', fromDate, toDate, accountIds, chartInterval],
    queryFn: () => getPortfolioHistory({ from_date: fromDate, to_date: toDate, interval: chartInterval, account_ids: accountIds }),
  })

  const histPoints = history as PortfolioHistoryPoint[]
  const hasMarketPrices = histPoints.some(h => h.total_value_cad !== null)
  const chartData = histPoints.map(h => ({
    date: h.date,
    bookValue:  parseFloat(h.book_value_cad),
    totalValue: h.total_value_cad !== null ? parseFloat(h.total_value_cad) : null,
  }))
  const xTickInterval = chartData.length <= 24 ? 0
    : chartData.length <= 52 ? Math.floor(chartData.length / 12) - 1
    : Math.floor(chartData.length / 10) - 1

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select
            value={brokerageFilter}
            onChange={e => setBrokerageFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Account(s)</label>
          <MultiSelectDropdown
            placeholder="All accounts"
            options={accountOptions}
            selected={selectedAccountIds}
            onChange={ids => setSelectedAccountIds(ids)}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Range</label>
          <div className="flex gap-1">
            {(['YTD', '1Y', '3Y', '5Y', 'ALL'] as PortfolioRange[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${range === r ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Interval</label>
          <div className="flex gap-1">
            {(['daily', 'weekly', 'monthly'] as const).map(iv => (
              <button key={iv} onClick={() => setChartInterval(iv)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium capitalize transition-colors ${chartInterval === iv ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {iv[0].toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        {isLoading ? (
          <div className="h-72 flex items-center justify-center">
            <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-blue-600" />
          </div>
        ) : !hasMarketPrices ? (
          <div className="h-72 flex flex-col items-center justify-center gap-2 text-gray-400">
            <p className="text-sm">No historical price data for this period.</p>
            <p className="text-xs">Use <strong>Refresh Prices</strong> in the header to populate prices.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-4 mb-3 text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-8 h-0.5 bg-blue-500 rounded" /> Total Value
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-8 border-t-2 border-dashed border-gray-400" /> Book Value
              </span>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} interval={xTickInterval}
                  tickFormatter={v => fmtAxisDate(v, chartInterval)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtCADAxis} width={72} />
                <Tooltip
                  formatter={(value: number, name: string) => [fmtCAD0(value), name === 'totalValue' ? 'Total Value' : 'Book Value']}
                  labelFormatter={v => fmtAxisDate(v, chartInterval)}
                />
                <Line type="monotone" dataKey="bookValue"  stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls name="bookValue" />
                <Line type="monotone" dataKey="totalValue" stroke="#3b82f6" strokeWidth={2}   dot={false} connectNulls name="totalValue" />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  )
}

// ── Portfolio Continuity ──────────────────────────────────────────────────────

function PortfolioContinuityReport() {
  const [range, setRange] = useState<PortfolioRange>('ALL')

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const {
    brokerageFilter, setBrokerageFilter, brokerages,
    accountOptions, selectedAccountIds, setSelectedAccountIds, accountIds,
  } = useAccountCascade(accounts as Account[])

  const { fromDate, toDate } = useMemo(() => computePortfolioRange(range), [range])
  const fromDateStr = fromDate ?? '2000-01-01'

  const { data: continuity, isLoading } = useQuery({
    queryKey: ['portfolio-continuity', fromDateStr, toDate, accountIds],
    queryFn: () => getPortfolioContinuity({ from_date: fromDateStr, to_date: toDate, account_ids: accountIds }),
  })

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select
            value={brokerageFilter}
            onChange={e => setBrokerageFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Account(s)</label>
          <MultiSelectDropdown
            placeholder="All accounts"
            options={accountOptions}
            selected={selectedAccountIds}
            onChange={ids => setSelectedAccountIds(ids)}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Range</label>
          <div className="flex gap-1">
            {(['YTD', '1Y', '3Y', '5Y', 'ALL'] as PortfolioRange[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${range === r ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Continuity table */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-blue-600" />
        </div>
      ) : !continuity ? (
        <div className="text-center py-16 text-gray-400">No data for selected period.</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <ContinuityTable data={continuity} />
        </div>
      )}
    </div>
  )
}

// ── Cash Statement ────────────────────────────────────────────────────────────
const CASH_TYPE_LABELS: Record<string, string> = {
  CASH_OPENING: 'Opening Balance', BUY: 'Buy', SELL: 'Sell',
  DIVIDEND: 'Dividend', DRIP: 'DRIP', RETURN_OF_CAPITAL: 'Return of Capital',
  INTEREST: 'Interest', FEE: 'Fee', DEPOSIT: 'Deposit', WITHDRAWAL: 'Withdrawal',
  TRANSFER_IN: 'Transfer In', TRANSFER_OUT: 'Transfer Out',
  FX_CONVERSION: 'FX Conversion', FX_ADJUSTMENT: 'FX Adjustment',
  OPTION_BUY: 'Option Buy', OPTION_SELL: 'Option Sell',
  OPTION_EXPIRY: 'Option Expiry', OPTION_ASSIGNMENT: 'Option Assignment',
  OPTION_EXERCISE: 'Option Exercise', JOURNAL: 'Journal',
  ADJUSTMENT: 'Adjustment', OTHER: 'Other',
}

const CASH_TYPE_COLORS: Record<string, string> = {
  CASH_OPENING: 'bg-gray-100 text-gray-600',
  BUY: 'bg-blue-50 text-blue-700', OPTION_BUY: 'bg-blue-50 text-blue-700',
  SELL: 'bg-emerald-50 text-emerald-700', OPTION_SELL: 'bg-emerald-50 text-emerald-700',
  DIVIDEND: 'bg-purple-50 text-purple-700', DRIP: 'bg-purple-50 text-purple-700',
  INTEREST: 'bg-purple-50 text-purple-700', RETURN_OF_CAPITAL: 'bg-purple-50 text-purple-700',
  TRANSFER_IN: 'bg-teal-50 text-teal-700', DEPOSIT: 'bg-teal-50 text-teal-700',
  TRANSFER_OUT: 'bg-orange-50 text-orange-700', WITHDRAWAL: 'bg-orange-50 text-orange-700',
  FEE: 'bg-red-50 text-red-600',
  FX_CONVERSION: 'bg-yellow-50 text-yellow-700', FX_ADJUSTMENT: 'bg-yellow-50 text-yellow-700',
}

function fmtAmt(val: string, decimals = 2) {
  const n = parseFloat(val)
  if (isNaN(n)) return '—'
  return Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function ImpactCells({ row }: { row: CashStatementRow }) {
  const n = parseFloat(row.impact)
  if (row.transaction_type === 'CASH_OPENING') {
    return (
      <>
        <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
        <td className="px-4 py-2.5 text-right font-mono text-sm text-emerald-600">{fmtAmt(row.impact)}</td>
      </>
    )
  }
  if (n < 0) {
    return (
      <>
        <td className="px-4 py-2.5 text-right font-mono text-sm text-red-600">{fmtAmt(row.impact)}</td>
        <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
      </>
    )
  }
  return (
    <>
      <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
      <td className="px-4 py-2.5 text-right font-mono text-sm text-emerald-600">{fmtAmt(row.impact)}</td>
    </>
  )
}

function CashStatementReport() {
  const [brokerageFilter,    setBrokerageFilter]    = useState('')
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([])
  const [fromDate, setFromDate] = useState('')
  const [toDate,   setToDate]   = useState('')
  const [page,     setPage]     = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const accts = accounts as Account[]

  // Unique brokerages
  const brokerages = useMemo(
    () => [...new Set(accts.map(a => a.brokerage_name))].sort(),
    [accts],
  )

  // Accounts filtered by brokerage cascade
  const accountOptions = useMemo(
    () => accts
      .filter(a => !brokerageFilter || a.brokerage_name === brokerageFilter)
      .map(a => ({ value: String(a.id), label: a.name })),
    [accts, brokerageFilter],
  )

  // When brokerage filter changes, drop any selected accounts that no longer belong
  const handleBrokerageChange = (brok: string) => {
    setBrokerageFilter(brok)
    if (brok) {
      const validIds = new Set(accts.filter(a => a.brokerage_name === brok).map(a => String(a.id)))
      setSelectedAccountIds(prev => prev.filter(id => validIds.has(id)))
    }
    setPage(1)
  }

  const isSingle = selectedAccountIds.length === 1

  const { data: statement, isLoading, refetch } = useQuery({
    queryKey: ['cash-statement', selectedAccountIds, fromDate, toDate],
    queryFn: () => getCashStatement({
      account_ids: selectedAccountIds.join(','),
      from_date: fromDate || undefined,
      to_date:   toDate   || undefined,
    }),
    enabled: selectedAccountIds.length > 0,
  })

  const allRows: CashStatementRow[] = statement?.rows ?? []
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize))
  const pagedRows  = allRows.slice((page - 1) * pageSize, page * pageSize)

  const closingBalance = statement ? parseFloat(statement.closing_balance) : null

  const totalCredits = allRows.filter(r => parseFloat(r.impact) > 0).reduce((s, r) => s + parseFloat(r.impact), 0)
  const totalDebits  = allRows.filter(r => parseFloat(r.impact) < 0).reduce((s, r) => s + parseFloat(r.impact), 0)

  return (
    <div className="space-y-6">
      {/* Parameters */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select
            value={brokerageFilter}
            onChange={e => handleBrokerageChange(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Account(s)</label>
          <MultiSelectDropdown
            placeholder="— Select accounts —"
            options={accountOptions}
            selected={selectedAccountIds}
            onChange={ids => { setSelectedAccountIds(ids); setPage(1) }}
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={e => { setFromDate(e.target.value); setPage(1) }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={toDate}
            onChange={e => { setToDate(e.target.value); setPage(1) }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {(fromDate || toDate) && (
          <button
            onClick={() => { setFromDate(''); setToDate(''); setPage(1) }}
            className="self-end flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 pb-2"
          >
            <X className="h-3.5 w-3.5" /> Clear dates
          </button>
        )}

        <button
          onClick={() => refetch()}
          disabled={selectedAccountIds.length === 0 || isLoading}
          className="self-end flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {selectedAccountIds.length === 0 && (
        <div className="text-center py-20 text-gray-400">Select one or more accounts to view the cash statement.</div>
      )}

      {selectedAccountIds.length > 0 && isLoading && (
        <div className="text-center py-20 text-gray-400">Loading…</div>
      )}

      {statement && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Closing Balance</p>
              <p className={`text-xl font-bold font-mono ${closingBalance !== null && closingBalance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {closingBalance !== null
                  ? <>{closingBalance < 0 ? '−' : ''}{Math.abs(closingBalance).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                  : '—'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">{statement.currency}</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Total Credits</p>
              <p className="text-xl font-bold font-mono text-emerald-600">
                {totalCredits.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Total Debits</p>
              <p className="text-xl font-bold font-mono text-red-600">
                {Math.abs(totalDebits).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>

          {allRows.length === 0
            ? <div className="text-center py-20 text-gray-400">No cash transactions found for the selected account(s).</div>
            : (
              <div className="space-y-2">
                {/* Top pagination */}
                <PaginationBar
                  page={page} totalPages={totalPages} pageSize={pageSize}
                  totalRows={allRows.length} setPage={setPage} setPageSize={n => { setPageSize(n); setPage(1) }}
                />

                <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
                  <table className="w-full text-sm min-w-[640px]">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        <th className="px-4 py-3 text-left">Date</th>
                        {!isSingle && <th className="px-4 py-3 text-left">Account</th>}
                        <th className="px-4 py-3 text-left">Type</th>
                        <th className="px-4 py-3 text-left">Description</th>
                        <th className="px-4 py-3 text-right">Debit</th>
                        <th className="px-4 py-3 text-right">Credit</th>
                        {isSingle && <th className="px-4 py-3 text-right">Balance</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {pagedRows.map(row => {
                        const isOpening = row.transaction_type === 'CASH_OPENING'
                        const label = CASH_TYPE_LABELS[row.transaction_type] ?? row.transaction_type
                        const badgeColor = CASH_TYPE_COLORS[row.transaction_type] ?? 'bg-gray-100 text-gray-600'
                        const bal = parseFloat(row.balance ?? '0')
                        return (
                          <tr key={row.id} className={`hover:bg-gray-50 transition-colors ${isOpening ? 'bg-gray-50/60' : ''}`}>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <span className="text-gray-800 font-medium">{row.date}</span>
                              {row.settlement_date && row.settlement_date !== row.date && (
                                <span className="block text-xs text-gray-400">Settles {row.settlement_date}</span>
                              )}
                            </td>
                            {!isSingle && (
                              <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap max-w-[10rem] truncate" title={row.account_name ?? ''}>
                                {row.account_name}
                              </td>
                            )}
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${badgeColor}`}>{label}</span>
                            </td>
                            <td className="px-4 py-2.5 text-gray-600 max-w-xs truncate">
                              {row.ticker && <span className="font-mono font-medium text-gray-800 mr-1.5">{row.ticker}</span>}
                              {row.description}
                            </td>
                            <ImpactCells row={row} />
                            {isSingle && (
                              <td className="px-4 py-2.5 text-right">
                                <span className={`font-mono font-medium ${bal < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                                  {fmtAmt(row.balance ?? '0')}
                                </span>
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                        <td colSpan={isSingle ? 3 : 4} className="px-4 py-3 text-gray-700">Closing Balance</td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-red-600">
                          {totalDebits !== 0 ? Math.abs(totalDebits).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-emerald-600">
                          {totalCredits !== 0 ? totalCredits.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                        </td>
                        {isSingle && (
                          <td className="px-4 py-3 text-right">
                            <span className={`font-mono font-medium ${closingBalance !== null && closingBalance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                              {fmtAmt(statement.closing_balance)}
                            </span>
                          </td>
                        )}
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Bottom pagination */}
                <PaginationBar
                  page={page} totalPages={totalPages} pageSize={pageSize}
                  totalRows={allRows.length} setPage={setPage} setPageSize={n => { setPageSize(n); setPage(1) }}
                />
              </div>
            )}
        </>
      )}
    </div>
  )
}

// ── Monthly Returns Report ────────────────────────────────────────────────────

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function shortMonth(mk: string) {
  return SHORT_MONTHS[parseInt(mk.slice(5)) - 1] ?? mk
}

function pctCellCls(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'text-gray-300'
  if (v >=  5) return 'text-emerald-800 font-bold'
  if (v >=  2) return 'text-emerald-700 font-semibold'
  if (v >=  0) return 'text-emerald-600'
  if (v >= -2) return 'text-red-500'
  if (v >= -5) return 'text-red-600 font-semibold'
  return 'text-red-700 font-bold'
}

function pctCellBg(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'bg-gray-50'
  if (v >=  5) return 'bg-emerald-100'
  if (v >=  2) return 'bg-emerald-50'
  if (v >=  0) return ''
  if (v >= -2) return 'bg-red-50'
  if (v >= -5) return 'bg-red-100'
  return 'bg-red-200'
}

function fmtPct(v: number | null | undefined) {
  if (v === null || v === undefined) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

function MonthlyReturnsReport() {
  const currentYear = new Date().getFullYear()
  const [yearFrom, setYearFrom] = useState(currentYear - 1)
  const [yearTo,   setYearTo]   = useState(currentYear)
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [typeFilter,      setTypeFilter]      = useState('')
  const [nameFilter,      setNameFilter]      = useState('')
  const [groupBy, setGroupBy] = useState<'none' | 'brokerage' | 'account_type'>('brokerage')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const { data, isLoading } = useQuery({
    queryKey: ['monthly-returns', yearFrom, yearTo],
    queryFn:  () => getMonthlyReturns({ year_from: yearFrom, year_to: yearTo }),
  })

  const months  = data?.months ?? []
  const years   = data?.years  ?? []
  const allRows = data?.rows   ?? []

  // year → ordered months in that year that appear in the data
  const yearToMonths = useMemo(() =>
    years.reduce((acc, y) => {
      acc[y] = months.filter(m => m.startsWith(y))
      return acc
    }, {} as Record<string, string[]>)
  , [years, months])

  const brokerages = useMemo(() => [...new Set(allRows.map(r => r.brokerage))].sort(), [allRows])
  const types      = useMemo(() => [...new Set(allRows.map(r => r.account_type))].sort(), [allRows])

  const filteredRows = useMemo(() => allRows.filter(r => {
    if (brokerageFilter && r.brokerage !== brokerageFilter) return false
    if (typeFilter      && r.account_type !== typeFilter)   return false
    if (nameFilter      && !r.account_name.toLowerCase().includes(nameFilter.toLowerCase())) return false
    return true
  }), [allRows, brokerageFilter, typeFilter, nameFilter])

  // build visual groups
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '__all__', label: '', rows: filteredRows }]
    const m = new Map<string, MonthlyReturnRow[]>()
    for (const r of filteredRows) {
      const k = groupBy === 'brokerage' ? r.brokerage : r.account_type
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(r)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, rows]) => ({ key, label: key, rows }))
  }, [filteredRows, groupBy])

  function toggleGroup(key: string) {
    setCollapsed(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  const yearOptions = Array.from({ length: 10 }, (_, i) => currentYear - i)
  // total cols: 3 fixed + sum of (months per year + 1 annual per year)
  const totalCols = 3 + months.length + years.length

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">From year</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={yearFrom} onChange={e => setYearFrom(Number(e.target.value))}>
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">To year</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={yearTo} onChange={e => setYearTo(Number(e.target.value))}>
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={brokerageFilter} onChange={e => setBrokerageFilter(e.target.value)}>
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Type</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Search</label>
          <input type="text" placeholder="Account name…" value={nameFilter} onChange={e => setNameFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-36" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Group by</label>
          <div className="flex gap-1">
            {(['none', 'brokerage', 'account_type'] as const).map(g => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${groupBy === g ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {g === 'none' ? 'None' : g === 'brokerage' ? 'Brokerage' : 'Type'}
              </button>
            ))}
          </div>
        </div>
        {groupBy !== 'none' && (
          <div className="flex gap-1 self-end">
            <button onClick={() => setCollapsed(new Set())} className="px-2 py-1.5 text-xs rounded border border-gray-200 hover:bg-gray-50 text-gray-500">Expand all</button>
            <button onClick={() => setCollapsed(new Set(groups.map(g => g.key)))} className="px-2 py-1.5 text-xs rounded border border-gray-200 hover:bg-gray-50 text-gray-500">Collapse all</button>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 bg-gray-50 rounded-lg px-4 py-2 border border-gray-100">
        <span className="font-medium text-gray-600">Return scale:</span>
        {[['≥+5%', 'bg-emerald-100 text-emerald-800'], ['+2–5%', 'bg-emerald-50 text-emerald-700'], ['0–2%', 'text-emerald-600'], ['0 to −2%', 'bg-red-50 text-red-500'], ['−2 to −5%', 'bg-red-100 text-red-600'], ['≤−5%', 'bg-red-200 text-red-700']].map(([label, cls]) => (
          <span key={label} className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
        ))}
        <span className="ml-auto text-gray-400">— = return suppressed (large inflow or no data)</span>
      </div>

      {isLoading
        ? <div className="flex justify-center py-16"><div className="animate-spin h-8 w-8 rounded-full border-b-2 border-blue-600" /></div>
        : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="text-xs border-collapse">
                <thead className="bg-gray-50">
                  {/* Year spanning row */}
                  <tr>
                    <th className="sticky left-0 z-30 bg-gray-50 px-3 py-2 text-left font-semibold text-gray-600 whitespace-nowrap border-r border-gray-200 border-b border-gray-200 min-w-[168px]" rowSpan={2}>
                      Account
                    </th>
                    <th className="sticky left-[168px] z-30 bg-gray-50 px-2 py-2 text-left font-semibold text-gray-600 whitespace-nowrap border-r border-gray-200 border-b border-gray-200 min-w-[88px]" rowSpan={2}>
                      Brokerage
                    </th>
                    <th className="sticky left-[256px] z-30 bg-gray-50 px-2 py-2 text-left font-semibold text-gray-600 whitespace-nowrap border-r-2 border-gray-300 border-b border-gray-200 min-w-[60px]" rowSpan={2}>
                      Type
                    </th>
                    {years.map(y => (
                      <th key={y} colSpan={(yearToMonths[y]?.length ?? 0) + 1}
                        className="px-2 py-1.5 text-center font-bold text-gray-700 border-l-2 border-gray-300 border-b border-gray-200 bg-slate-50">
                        {y}
                      </th>
                    ))}
                  </tr>
                  {/* Month row */}
                  <tr className="border-b-2 border-gray-300">
                    {years.map(y => (
                      <Fragment key={y}>
                        {(yearToMonths[y] ?? []).map(mk => (
                          <th key={mk} className="px-0.5 py-1.5 text-center text-gray-500 font-medium border-l border-gray-100 min-w-[42px] whitespace-nowrap">
                            {shortMonth(mk)}
                          </th>
                        ))}
                        <th className="px-1 py-1.5 text-center text-gray-700 font-bold border-l-2 border-gray-300 min-w-[52px] bg-slate-100 whitespace-nowrap">
                          Ann.
                        </th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {groups.length === 0 && (
                    <tr><td colSpan={totalCols} className="px-4 py-8 text-center text-gray-400">No data found for selected filters.</td></tr>
                  )}
                  {groups.map(group => (
                    <Fragment key={group.key}>
                      {/* Group header */}
                      {groupBy !== 'none' && group.label && (
                        <tr className="bg-slate-100 hover:bg-slate-200 cursor-pointer select-none" onClick={() => toggleGroup(group.key)}>
                          <td className="sticky left-0 z-10 bg-slate-100 px-3 py-1.5 border-r border-gray-200">
                            <div className="flex items-center gap-1.5">
                              {collapsed.has(group.key)
                                ? <ChevronRight className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
                                : <ChevronDown  className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />}
                              <span className="font-semibold text-slate-700 whitespace-nowrap">{group.label}</span>
                              <span className="text-slate-400 font-normal">{group.rows.length} acct{group.rows.length !== 1 ? 's' : ''}</span>
                            </div>
                          </td>
                          <td className="sticky left-[168px] z-10 bg-slate-100 border-r border-gray-200" />
                          <td className="sticky left-[256px] z-10 bg-slate-100 border-r-2 border-gray-300" />
                          {years.map(y => (
                            <Fragment key={y}>
                              {(yearToMonths[y] ?? []).map(mk => <td key={mk} className="border-l border-gray-100" />)}
                              <td className="border-l-2 border-gray-300 bg-slate-100" />
                            </Fragment>
                          ))}
                        </tr>
                      )}
                      {/* Data rows */}
                      {!collapsed.has(group.key) && group.rows.map(row => (
                        <tr key={row.account_ids.join('-')} className="hover:bg-blue-50/30 group/row">
                          <td className="sticky left-0 z-10 bg-white group-hover/row:bg-blue-50/40 px-3 py-1.5 font-medium text-gray-800 whitespace-nowrap truncate border-r border-gray-200 max-w-[168px]" title={row.account_name}>
                            {row.account_name}
                          </td>
                          <td className="sticky left-[168px] z-10 bg-white group-hover/row:bg-blue-50/40 px-2 py-1.5 text-gray-400 whitespace-nowrap border-r border-gray-200 max-w-[88px] truncate" title={row.brokerage}>
                            {row.brokerage}
                          </td>
                          <td className="sticky left-[256px] z-10 bg-white group-hover/row:bg-blue-50/40 px-2 py-1.5 whitespace-nowrap border-r-2 border-gray-300">
                            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{row.account_type}</span>
                          </td>
                          {years.map(y => (
                            <Fragment key={y}>
                              {(yearToMonths[y] ?? []).map(mk => {
                                const v = row.monthly[mk]
                                return (
                                  <td key={mk}
                                    className={`px-0.5 py-1.5 text-center border-l border-gray-100 tabular-nums ${pctCellBg(v)} ${pctCellCls(v)}`}>
                                    {fmtPct(v)}
                                  </td>
                                )
                              })}
                              {(() => {
                                const v = row.annual[y]
                                return (
                                  <td className={`px-1 py-1.5 text-center border-l-2 border-gray-300 tabular-nums ${pctCellBg(v)} ${pctCellCls(v)} bg-opacity-70`}>
                                    {fmtPct(v)}
                                  </td>
                                )
                              })()}
                            </Fragment>
                          ))}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredRows.length > 0 && (
              <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400 bg-gray-50">
                {filteredRows.length} account{filteredRows.length !== 1 ? 's' : ''} · {months.length} months · {years.length} year{years.length !== 1 ? 's' : ''}
                {(brokerageFilter || typeFilter || nameFilter) && ` · filtered from ${allRows.length} total`}
              </div>
            )}
          </div>
        )}
    </div>
  )
}


// ── Return Calculation Detail Report ──────────────────────────────────────────

type ReturnDetailPreset = 'YTD' | '1Y' | '3Y' | 'custom'

function ReturnDetailReport() {
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

  const { data: rawRows = [], isLoading } = useQuery({
    queryKey: ['returns-detail', fromDate, toDate],
    queryFn:  () => getReturnsDetail({ from_date: fromDate, to_date: toDate }),
    enabled:  !!fromDate && !!toDate,
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
    if (v === null || v === undefined) return 'text-gray-400'
    if (v >= 10) return 'text-emerald-700 font-bold'
    if (v >= 0)  return 'text-emerald-600 font-semibold'
    if (v >= -10) return 'text-red-500 font-semibold'
    return 'text-red-600 font-bold'
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
          <label className="block text-xs text-gray-500 mb-1">Period</label>
          <div className="flex gap-1">
            {(['YTD', '1Y', '3Y'] as ReturnDetailPreset[]).map(p => (
              <button key={p} onClick={() => applyPreset(p)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${preset === p ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {p}
              </button>
            ))}
            <button onClick={() => setPreset('custom')}
              className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${preset === 'custom' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              Custom
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">From</label>
          <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPreset('custom') }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">To</label>
          <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPreset('custom') }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={brokerageFilter} onChange={e => setBrokerageFilter(e.target.value)}>
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Type</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Search</label>
          <input type="text" placeholder="Account name…" value={nameFilter} onChange={e => setNameFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-36" />
        </div>
      </div>

      {/* Formula toggle */}
      <div>
        <button onClick={() => setShowFormula(v => !v)}
          className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
          {showFormula ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          How is total return calculated?
        </button>
        {showFormula && (
          <div className="mt-2 bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-gray-700 space-y-2">
            <p className="font-semibold text-blue-800">Modified Dietz Return (industry standard)</p>
            <div className="font-mono bg-white border border-blue-100 rounded p-3 text-gray-800 leading-relaxed text-xs">
              <p className="font-semibold text-gray-500 mb-1">Numerator (Total Gain):</p>
              <p>  (End Value − Start Value) − Net Flows + Period Income</p>
              <p className="mt-2 font-semibold text-gray-500">Denominator (Effective Capital):</p>
              <p>  Start Value + Σ (weight_i × flow_i)</p>
              <p className="text-gray-400 text-xs">  where weight_i = days remaining in period / total period days</p>
              <p className="mt-2 border-t border-gray-100 pt-2 font-semibold">Return %  =  Total Gain ÷ Effective Capital × 100</p>
            </div>
            <p className="text-gray-500 text-xs">
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
        ? <div className="flex justify-center py-16"><div className="animate-spin h-8 w-8 rounded-full border-b-2 border-blue-600" /></div>
        : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm divide-y divide-gray-100">
                <thead className="bg-gray-50">
                  <tr className="text-xs text-gray-500 uppercase">
                    <SortTh label="Account"          col="account_name"       sort={sort} toggle={toggle} className="px-4 py-2.5 text-left" />
                    <SortTh label="Brokerage"        col="brokerage"          sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                    <SortTh label="Type"             col="account_type"       sort={sort} toggle={toggle} className="px-3 py-2.5 text-left" />
                    <SortTh label="Start Value"      col="start_market_value" sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="End Value"        col="end_market_value"   sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Net Flows"        col="net_flows"          sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Income"           col="period_income"      sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Gain (MD)"        col="total_gain"         sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <SortTh label="Return %"         col="return_pct"         sort={sort} toggle={toggle} className="px-3 py-2.5 text-right" />
                    <th className="px-3 py-2.5 text-right text-xs text-gray-500 uppercase font-medium whitespace-nowrap" title="Annualized return (only shown for periods ≥ 1 year)">Ann. %</th>
                    <th className="px-3 py-2.5 text-left text-xs text-gray-400 font-normal whitespace-nowrap">Composition</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sorted.length === 0 && (
                    <tr><td colSpan={12} className="px-4 py-8 text-center text-gray-400">No data for selected period.</td></tr>
                  )}
                  {sorted.map(r => (
                    <tr key={r.account_ids.join('-')} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-medium text-gray-800 whitespace-nowrap">{r.account_name}</td>
                      <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{r.brokerage}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">{r.account_type}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{fmtCAD0(r.start_market_value)}</td>
                      <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{fmtCAD0(r.end_market_value)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-sm">
                        {Math.abs(r.net_flows) > 1
                          ? <span className={r.net_flows >= 0 ? 'text-orange-500' : 'text-purple-500'}
                              title={r.net_flows >= 0 ? 'Net contributions (new money in)' : 'Net withdrawals (money out)'}>
                              {fmtCAD0Signed(r.net_flows)}
                            </span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-blue-600 tabular-nums text-sm">
                        {r.period_income > 0 ? fmtCAD0(r.period_income) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold tabular-nums ${r.total_gain >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {fmtCAD0Signed(r.total_gain)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${rPctCls(r.return_pct)}`}>
                        {`${r.return_pct >= 0 ? '+' : ''}${r.return_pct.toFixed(1)}%`}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${rPctCls(annualizedPct(r))}`}>
                        {annualizedPct(r) !== null
                          ? `${annualizedPct(r)! >= 0 ? '+' : ''}${annualizedPct(r)!.toFixed(1)}%`
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <WaterfallBar row={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                {sorted.length > 0 && (
                  <tfoot className="bg-gray-50 border-t-2 border-gray-300 font-semibold text-sm">
                    <tr>
                      <td className="px-4 py-2.5 text-gray-500" colSpan={3}>
                        {sorted.length} account{sorted.length !== 1 ? 's' : ''}
                        {(brokerageFilter || typeFilter || nameFilter) && ` (filtered from ${rows.length})`}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtCAD0(totals.start)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtCAD0(totals.end)}</td>
                      <td className="px-3 py-2.5 text-right text-orange-500 tabular-nums">
                        {Math.abs(totals.net_flows) > 1 ? fmtCAD0Signed(totals.net_flows) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right text-blue-600 tabular-nums">{fmtCAD0(totals.period_income)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${totals.total_gain >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
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


// ── Report registry ───────────────────────────────────────────────────────────
// ── FX Rates Report ───────────────────────────────────────────────────────────
function FxRatesReport() {
  const { data: rates = [], isLoading } = useQuery({
    queryKey: ['fx-rates'],
    queryFn: () => getFxRates(500),
    staleTime: 60_000,
  })

  const sorted = useMemo(() =>
    [...(rates as FXRate[])].sort((a, b) => b.rate_date.localeCompare(a.rate_date)),
    [rates],
  )

  // Group by currency pair
  const pairs = useMemo(() => {
    const seen = new Set<string>()
    return sorted.filter(r => {
      const key = `${r.from_currency}/${r.to_currency}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [sorted])

  if (isLoading) return <div className="text-sm text-gray-400 py-6 text-center">Loading…</div>

  return (
    <div className="space-y-6">
      {/* Latest rates summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {pairs.map(r => (
          <div key={`${r.from_currency}${r.to_currency}`} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500 mb-1">{r.from_currency} → {r.to_currency}</p>
            <p className="text-xl font-semibold text-gray-900">{Number(r.rate).toFixed(4)}</p>
            <p className="text-xs text-gray-400 mt-0.5">{r.rate_date}</p>
          </div>
        ))}
      </div>

      {/* Full rate history table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-700">Rate History</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Date</th>
                <th className="text-left px-4 py-2.5 font-medium">From</th>
                <th className="text-left px-4 py-2.5 font-medium">To</th>
                <th className="text-right px-4 py-2.5 font-medium">Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-700">{r.rate_date}</td>
                  <td className="px-4 py-2 text-gray-700">{r.from_currency}</td>
                  <td className="px-4 py-2 text-gray-700">{r.to_currency}</td>
                  <td className="px-4 py-2 text-right font-mono text-gray-900">{Number(r.rate).toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

type ReportId = 'realized-gains' | 'income' | 'cash-statement' | 'portfolio-value' | 'continuity' | 'monthly-returns' | 'return-detail' | 'fx-rates'

const REPORT_DEFS: {
  id: ReportId
  label: string
  description: string
  icon: React.ElementType
  component: React.ComponentType
}[] = [
  {
    id: 'portfolio-value',
    label: 'Portfolio Value Over Time',
    description: 'Historical NAV chart showing market vs. book value',
    icon: Activity,
    component: PortfolioValueReport,
  },
  {
    id: 'continuity',
    label: 'Portfolio Continuity',
    description: 'Reconcile portfolio changes: contributions, gains, income, fees',
    icon: Calculator,
    component: PortfolioContinuityReport,
  },
  {
    id: 'realized-gains',
    label: 'Realized Gains / Losses',
    description: 'Taxable dispositions and net capital gains by security and year',
    icon: TrendingUp,
    component: RealizedGainsReport,
  },
  {
    id: 'income',
    label: 'Investment Income',
    description: 'Dividends, interest, distributions, and other income',
    icon: DollarSign,
    component: IncomeReport,
  },
  {
    id: 'cash-statement',
    label: 'Cash Statement',
    description: 'Running cash balance with debits and credits by account',
    icon: Landmark,
    component: CashStatementReport,
  },
  {
    id: 'monthly-returns',
    label: 'Monthly / Annual Returns',
    description: 'Month-by-month return matrix per account, including closed accounts',
    icon: CalendarRange,
    component: MonthlyReturnsReport,
  },
  {
    id: 'return-detail',
    label: 'Return Calculation Detail',
    description: 'Numerator/denominator breakdown: price change, income, capital returned',
    icon: FileSearch,
    component: ReturnDetailReport,
  },
  {
    id: 'fx-rates',
    label: 'FX Rates',
    description: 'USD/CAD exchange rates used for portfolio calculations',
    icon: Globe,
    component: FxRatesReport,
  },
]

// ── Main Reports Page ─────────────────────────────────────────────────────────
export default function Reports() {
  const [activeId, setActiveId] = useState<ReportId | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)

  const active = REPORT_DEFS.find(r => r.id === activeId)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Reports</h1>

      <div className="flex gap-6 items-start">
        {/* Left panel — report list */}
        {panelOpen ? (
          <div className="w-64 flex-shrink-0 bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Available Reports</p>
              <button
                onClick={() => setPanelOpen(false)}
                title="Hide report list"
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            <nav className="divide-y divide-gray-50">
              {REPORT_DEFS.map(r => {
                const Icon = r.icon
                const isActive = r.id === activeId
                return (
                  <button
                    key={r.id}
                    onClick={() => setActiveId(r.id)}
                    className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors group ${
                      isActive
                        ? 'bg-blue-50 border-l-2 border-blue-600'
                        : 'hover:bg-gray-50 border-l-2 border-transparent'
                    }`}
                  >
                    <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${isActive ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'}`} />
                    <div className="min-w-0">
                      <p className={`text-sm font-medium leading-tight ${isActive ? 'text-blue-700' : 'text-gray-700'}`}>{r.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5 leading-snug">{r.description}</p>
                    </div>
                    {isActive && <ChevronRight className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5 ml-auto" />}
                  </button>
                )
              })}
            </nav>
          </div>
        ) : (
          /* Collapsed — thin strip with expand button */
          <div className="flex-shrink-0">
            <button
              onClick={() => setPanelOpen(true)}
              title="Show report list"
              className="flex items-center gap-1.5 px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
              Reports
            </button>
          </div>
        )}

        {/* Right panel — selected report */}
        <div className="flex-1 min-w-0">
          {!active ? (
            <div className="bg-white border border-gray-200 rounded-xl flex flex-col items-center justify-center py-24 text-center px-8">
              <BarChart2Icon className="h-10 w-10 text-gray-300 mb-3" />
              <p className="text-gray-500 font-medium">Select a report</p>
              <p className="text-sm text-gray-400 mt-1">
                {panelOpen
                  ? 'Choose a report from the list on the left to get started.'
                  : 'Click "Reports" on the left to choose a report.'}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                {!panelOpen && (
                  <button
                    onClick={() => setPanelOpen(true)}
                    title="Show report list"
                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </button>
                )}
                <active.icon className="h-5 w-5 text-blue-600" />
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 leading-tight">{active.label}</h2>
                  <p className="text-sm text-gray-500">{active.description}</p>
                </div>
              </div>
              <active.component />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// tiny shim so we can reference BarChart2 as a component in the empty state
function BarChart2Icon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.5V21M8.25 9.75V21M13.5 6V21M18.75 3V21" />
    </svg>
  )
}
