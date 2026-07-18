import { useState, useMemo, Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer,
} from 'recharts'
import { getRealizedPnl, getAccounts } from '../../api/client'
import type { Account } from '../../api/client'
import DatePicker from '../../components/DatePicker'
import TickerLink from '../../components/TickerLink'
import { fmtCAD, useSortState, SortTh, sortRows } from './shared'

// ── Realized Gains ────────────────────────────────────────────────────────────
type GainRow = {
  date: string; ticker: string; security_id: number | null; quantity: string
  proceeds_cad: string; acb_cad: string; gain_cad: string
  account_id: number; account_name: string; brokerage_name: string
}

export default function RealizedGainsReport() {
  const [accountId, setAccountId]       = useState('')
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [year, setYear]                 = useState('')
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const allAccts = accounts as Account[]
  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: 8 }, (_, i) => currentYear - i)

  // Default account_ids to all user accounts so non-admin users are always scoped
  const defaultAccountIds = useMemo(
    () => allAccts.map(a => String(a.id)).join(',') || undefined,
    [allAccts],
  )

  const { data: gains = [], isLoading } = useQuery({
    queryKey: ['pnl', accountId, year, defaultAccountIds],
    queryFn: () => getRealizedPnl({
      account_ids: accountId ? String(accountId) : defaultAccountIds,
      year: year ? Number(year) : undefined,
    }),
    enabled: defaultAccountIds !== undefined,
  })
  const { sort, toggle } = useSortState('date', 'desc')
  const [tickerFilter, setTickerFilter] = useState('')
  const [gainFilter, setGainFilter] = useState<'all' | 'gains' | 'losses'>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [viewMode, setViewMode] = useState<'account' | 'security'>('account')

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
    if (dateFrom && g.date < dateFrom) return false
    if (dateTo && g.date > dateTo) return false
    return true
  }), [rows, brokerageFilter, tickerFilter, gainFilter, dateFrom, dateTo])

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
    for (const g of filtered) {
      const yr = new Date(g.date).getFullYear()
      if (!m[yr]) m[yr] = { gain: 0, loss: 0, net: 0 }
      const v = parseFloat(g.gain_cad)
      if (v >= 0) m[yr].gain += v; else m[yr].loss += v
      m[yr].net += v
    }
    return Object.entries(m).sort((a, b) => Number(a[0]) - Number(b[0])).map(([yr, v]) => ({
      year: yr, gain: +v.gain.toFixed(2), loss: +v.loss.toFixed(2), net: +v.net.toFixed(2),
    }))
  }, [filtered])

  const byTicker = useMemo(() => {
    const m: Record<string, number> = {}
    for (const g of filtered) m[g.ticker] = (m[g.ticker] || 0) + parseFloat(g.gain_cad)
    return Object.entries(m).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12)
      .map(([ticker, net]) => ({ ticker, net: +net.toFixed(2) }))
  }, [filtered])

  const securityGroups = useMemo(() => {
    const m = new Map<string, { ticker: string; rows: GainRow[]; proceeds: number; acb: number; net: number }>()
    for (const g of filtered) {
      if (!m.has(g.ticker)) m.set(g.ticker, { ticker: g.ticker, rows: [], proceeds: 0, acb: 0, net: 0 })
      const entry = m.get(g.ticker)!
      entry.rows.push(g)
      entry.proceeds += parseFloat(g.proceeds_cad)
      entry.acb += parseFloat(g.acb_cad)
      entry.net += parseFloat(g.gain_cad)
    }
    return [...m.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .map(e => ({ ...e, rows: sortRows(e.rows, sort.col, sort.dir) }))
  }, [filtered, sort])

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
            {allAccts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Year</label>
          <select className="border border-gray-300 rounded-lg px-3 py-2 text-sm" value={year} onChange={e => setYear(e.target.value)}>
            <option value="">All years</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">From Date</label>
          <DatePicker value={dateFrom || ''} onChange={setDateFrom} max={new Date().toISOString().slice(0, 10)} placeholder="From" highlight={!!dateFrom} className="w-36" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">To Date</label>
          <DatePicker value={dateTo || ''} onChange={setDateTo} max={new Date().toISOString().slice(0, 10)} placeholder="To" highlight={!!dateTo} className="w-36" />
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
              <div className="flex gap-1 ml-auto">
                {(['account', 'security'] as const).map(v => (
                  <button key={v} onClick={() => setViewMode(v)}
                    className={`px-3 py-1.5 text-xs rounded border capitalize ${viewMode === v ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                    By {v}
                  </button>
                ))}
              </div>
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
                    {viewMode === 'security' ? (
                      <>
                        {securityGroups.length === 0 && (
                          <tr><td colSpan={COLS} className="px-4 py-8 text-center text-gray-400">No realized gains/losses found.</td></tr>
                        )}
                        {securityGroups.map(({ ticker, rows: secRows, proceeds, acb, net }) => (
                          <Fragment key={ticker}>
                            {secRows.map((g, i) => {
                              const gain = parseFloat(g.gain_cad)
                              return (
                                <tr key={i} className="hover:bg-gray-50">
                                  <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{g.brokerage_name}</td>
                                  <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap max-w-[10rem] truncate">{g.account_name}</td>
                                  <td className="px-4 py-2 text-gray-600 text-xs whitespace-nowrap">{g.date}</td>
                                  <td className="px-4 py-2 font-mono font-semibold"><TickerLink securityId={g.security_id} ticker={g.ticker} className="text-blue-700" /></td>
                                  <td className="px-4 py-2 text-right text-gray-600">{parseFloat(g.quantity).toLocaleString('en-CA', { maximumFractionDigits: 4 })}</td>
                                  <td className="px-4 py-2 text-right">{fmtCAD(g.proceeds_cad)}</td>
                                  <td className="px-4 py-2 text-right text-gray-500">{fmtCAD(g.acb_cad)}</td>
                                  <td className={`px-4 py-2 text-right font-semibold ${gain >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{fmtCAD(gain)}</td>
                                </tr>
                              )
                            })}
                            <tr className="bg-blue-50 border-t border-blue-200 text-xs font-semibold">
                              <td className="px-4 py-1.5 text-blue-700" colSpan={3}>{secRows.length} dispositions</td>
                              <td className="px-4 py-1.5 text-blue-800 font-mono">{ticker} subtotal</td>
                              <td className="px-4 py-1.5" />
                              <td className="px-4 py-1.5 text-right text-blue-800">{fmtCAD(proceeds)}</td>
                              <td className="px-4 py-1.5 text-right text-blue-600">{fmtCAD(acb)}</td>
                              <td className={`px-4 py-1.5 text-right ${net >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmtCAD(net)}</td>
                            </tr>
                          </Fragment>
                        ))}
                      </>
                    ) : (
                      <>
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
                                  <td className="px-4 py-2 font-mono font-semibold"><TickerLink securityId={g.security_id} ticker={g.ticker} className="text-blue-700" /></td>
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
                      </>
                    )}
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
