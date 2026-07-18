import { useState, useMemo, useCallback, Fragment } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, ChevronDown, RefreshCw, Database } from 'lucide-react'
import {
  getAccounts, getMonthlyReturns, refreshSnapshotViews, getSnapshotViewStatus,
} from '../../api/client'
import type { Account, MonthlyReturnRow } from '../../api/client'
import { fmtPct } from './shared'

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

export default function MonthlyReturnsReport() {
  const currentYear = new Date().getFullYear()
  const [yearFrom, setYearFrom] = useState(currentYear - 1)
  const [yearTo,   setYearTo]   = useState(currentYear)
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [typeFilter,      setTypeFilter]      = useState('')
  const [nameFilter,      setNameFilter]      = useState('')
  const [groupBy, setGroupBy] = useState<'none' | 'brokerage' | 'account_type'>('brokerage')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [viewRefreshStatus, setViewRefreshStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const queryClient = useQueryClient()

  const { data: accountsData = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const allAccts = accountsData as Account[]
  const defaultAccountIds = useMemo(
    () => allAccts.map(a => String(a.id)).join(',') || undefined,
    [allAccts],
  )

  const { data: viewStatus } = useQuery({
    queryKey: ['snapshot-view-status'],
    queryFn:  getSnapshotViewStatus,
    staleTime: 30_000,
  })

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['monthly-returns', yearFrom, yearTo, defaultAccountIds],
    queryFn:  () => getMonthlyReturns({ year_from: yearFrom, year_to: yearTo, account_ids: defaultAccountIds }),
    enabled:  defaultAccountIds !== undefined,
  })

  const handleRefreshViews = useCallback(async () => {
    setViewRefreshStatus('running')
    try {
      await refreshSnapshotViews()
      await queryClient.invalidateQueries({ queryKey: ['snapshot-view-status'] })
      await refetch()
      setViewRefreshStatus('done')
      setTimeout(() => setViewRefreshStatus('idle'), 3000)
    } catch {
      setViewRefreshStatus('error')
      setTimeout(() => setViewRefreshStatus('idle'), 4000)
    }
  }, [queryClient, refetch])

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
        {/* View refresh — pushed to the right */}
        <div className="ml-auto flex flex-col items-end gap-1">
          <button
            onClick={handleRefreshViews}
            disabled={viewRefreshStatus === 'running'}
            title="Refresh the monthly snapshot materialized view so this report reflects the latest data."
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
              ${viewRefreshStatus === 'running' ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
              : viewRefreshStatus === 'done'    ? 'bg-green-50 text-green-700 border-green-300'
              : viewRefreshStatus === 'error'   ? 'bg-red-50 text-red-700 border-red-300'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
          >
            {viewRefreshStatus === 'running'
              ? <><RefreshCw className="w-3 h-3 animate-spin" /> Refreshing…</>
              : viewRefreshStatus === 'done'
              ? <><Database className="w-3 h-3" /> Refreshed!</>
              : viewRefreshStatus === 'error'
              ? <><Database className="w-3 h-3" /> Failed</>
              : <><Database className="w-3 h-3" /> Refresh View</>}
          </button>
          {viewStatus && (
            <span className="text-xs text-gray-400">
              {viewStatus.rows.toLocaleString()} rows
              {viewStatus.last_refresh ? ` · last refreshed ${new Date(viewStatus.last_refresh).toLocaleDateString()}` : ' · not yet refreshed'}
            </span>
          )}
        </div>
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
