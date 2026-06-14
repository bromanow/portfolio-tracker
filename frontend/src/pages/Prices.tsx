import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getPriceReport, getPriceHistory, setManualPrice, clearManualPrice, recordOptionHistory,
  addHistoricalPrice, updateHistoricalPrice, deleteHistoricalPrice, fetchPriceHistory,
  getPriceJob, deleteAllHistory, importHistoryCSV, copyHistoryFrom,
} from '../api/client'
import type { PriceReportRow, PriceRecord } from '../api/client'
import { formatOptionTicker } from '../utils/optionFormat'
import DatePicker from '../components/DatePicker'
import { RefreshCw, Pencil, Check, X, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtCAD(val: string | number | null | undefined) {
  if (val == null) return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(n)
}

function fmtNative(val: string | null | undefined, currency: string | null | undefined) {
  if (val == null) return '—'
  const n = parseFloat(val)
  if (isNaN(n)) return '—'
  const ccy = currency?.toUpperCase() ?? 'CAD'
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: ccy, minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(n)
}

function fmtPct(val: string | null | undefined) {
  if (val == null) return null
  const n = parseFloat(val)
  if (isNaN(n)) return null
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return s
}

function fmtDatetime(s: string | null | undefined) {
  if (!s) return '—'
  return s.replace('T', ' ').slice(0, 16)
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <span className="text-xs text-gray-300 italic">none</span>
  const cls =
    source === 'manual' ? 'bg-amber-100 text-amber-700 border border-amber-200' :
    source === 'yahoo' || source === 'yahoo_chain' || source === 'mx_chain' ? 'bg-green-50 text-green-700 border border-green-200' :
    'bg-gray-100 text-gray-500'
  const label = source === 'yahoo_chain' ? 'Yahoo chain' : source === 'mx_chain' ? 'MX chain' : source
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>
}

function CcyBadge({ currency }: { currency: string | null | undefined }) {
  if (!currency) return null
  const isUSD = currency.toUpperCase() === 'USD'
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${isUSD ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
      {currency.toUpperCase()}
    </span>
  )
}

function pnlClass(val: string | null | undefined) {
  if (!val) return 'text-gray-400'
  const n = parseFloat(val)
  return n > 0 ? 'text-emerald-600' : n < 0 ? 'text-red-500' : 'text-gray-500'
}

// ─── Manual price inline editor ──────────────────────────────────────────────

function ManualEditor({
  row,
  onDone,
}: {
  row: PriceReportRow
  onDone: () => void
}) {
  const [val, setVal] = useState(row.price ?? '')
  const qc = useQueryClient()

  const saveMut = useMutation({
    mutationFn: () => {
      const p = parseFloat(val)
      if (isNaN(p) || p < 0) throw new Error('invalid')
      return setManualPrice(row.security_id, p, row.currency ?? 'CAD')
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['price-report'] }); onDone() },
  })
  const delMut = useMutation({
    mutationFn: () => clearManualPrice(row.security_id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['price-report'] }); onDone() },
  })

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-gray-400">{row.currency ?? 'CAD'}</span>
      <input
        autoFocus
        type="number"
        step="0.01"
        min="0"
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') saveMut.mutate()
          if (e.key === 'Escape') onDone()
        }}
        className="w-24 border border-blue-400 rounded px-1.5 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
      <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
        className="text-emerald-600 hover:text-emerald-700 disabled:opacity-50" title="Save">
        <Check className="h-3.5 w-3.5" />
      </button>
      <button onClick={onDone} className="text-gray-400 hover:text-gray-600" title="Cancel">
        <X className="h-3.5 w-3.5" />
      </button>
      {row.source === 'manual' && (
        <button onClick={() => delMut.mutate()} disabled={delMut.isPending}
          className="text-red-400 hover:text-red-600 disabled:opacity-50 ml-1" title="Clear manual price">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

// ─── Individual history row with edit / delete ────────────────────────────────

function HistoryRow({ r, securityId, onChanged }: { r: PriceRecord; securityId: number; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')
  const [editCcy, setEditCcy] = useState('CAD')

  const updateMut = useMutation({
    mutationFn: () => updateHistoricalPrice(securityId, r.price_date, {
      price_date: r.price_date,
      price: parseFloat(editVal),
      currency: editCcy,
    }),
    onSuccess: () => { setEditing(false); onChanged() },
  })

  const deleteMut = useMutation({
    mutationFn: () => deleteHistoricalPrice(securityId, r.price_date),
    onSuccess: () => onChanged(),
  })

  if (editing) {
    return (
      <tr className="bg-blue-50">
        <td className="py-0.5 pr-4 pl-2 text-gray-600 font-medium">{r.price_date}</td>
        <td className="py-0.5 pr-1 text-right" colSpan={2}>
          <div className="flex items-center justify-end gap-1">
            <select value={editCcy} onChange={e => setEditCcy(e.target.value)}
              className="border border-gray-300 rounded px-1 py-0.5 text-xs">
              <option>CAD</option><option>USD</option>
            </select>
            <input
              autoFocus
              type="number" step="0.0001" min="0"
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') updateMut.mutate(); if (e.key === 'Escape') setEditing(false) }}
              className="w-24 border border-blue-400 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none"
            />
          </div>
        </td>
        <td className="py-0.5 pr-2"><SourceBadge source={r.source} /></td>
        <td className="py-0.5">
          <div className="flex items-center gap-1">
            <button onClick={() => updateMut.mutate()} disabled={updateMut.isPending || !editVal}
              className="text-emerald-600 hover:text-emerald-700 disabled:opacity-40" title="Save">
              <Check className="h-3 w-3" />
            </button>
            <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-600" title="Cancel">
              <X className="h-3 w-3" />
            </button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="hover:bg-gray-50 group">
      <td className="py-0.5 pr-4 pl-2 text-gray-600">{r.price_date}</td>
      <td className="py-0.5 pr-4 text-right font-mono">{fmtNative(r.close_price, r.currency)}</td>
      <td className="py-0.5 pr-4 text-right font-mono">{fmtCAD(r.close_price_cad)}</td>
      <td className="py-0.5 pr-2"><SourceBadge source={r.source} /></td>
      <td className="py-0.5">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => { setEditVal(r.close_price ?? ''); setEditCcy(r.currency ?? 'CAD'); setEditing(true) }}
            className="text-gray-400 hover:text-blue-500" title="Edit price">
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={() => { if (window.confirm(`Delete price for ${r.price_date}?`)) deleteMut.mutate() }}
            disabled={deleteMut.isPending}
            className="text-gray-400 hover:text-red-500 disabled:opacity-40" title="Delete">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
  )
}


// ─── Price history expandable panel ──────────────────────────────────────────

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function PriceHistory({ securityId, ticker }: { securityId: number; ticker: string }) {
  const qc = useQueryClient()
  const { data = [], isLoading } = useQuery({
    queryKey: ['price-history', securityId],
    queryFn: () => getPriceHistory(securityId),
  })

  const [showAddForm, setShowAddForm] = useState(false)
  const [addDate, setAddDate] = useState(new Date().toISOString().slice(0, 10))
  const [addPrice, setAddPrice] = useState('')
  const [addCurrency, setAddCurrency] = useState('CAD')
  const [showTools, setShowTools] = useState(false)
  const [copyFromId, setCopyFromId] = useState('')
  const [csvStatus, setCsvStatus] = useState<string | null>(null)

  const deleteAllMut = useMutation({
    mutationFn: () => deleteAllHistory(securityId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['price-history', securityId] }),
  })

  const copyFromMut = useMutation({
    mutationFn: () => copyHistoryFrom(securityId, parseInt(copyFromId)),
    onSuccess: (d: { copied: number; from_ticker: string }) => {
      qc.invalidateQueries({ queryKey: ['price-history', securityId] })
      setCopyFromId('')
      setCsvStatus(`✓ Copied ${d.copied} rows from ${d.from_ticker}`)
    },
  })

  const importCsvMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData(); fd.append('file', file)
      return importHistoryCSV(securityId, fd)
    },
    onSuccess: (d: { imported: number; errors: string[] }) => {
      qc.invalidateQueries({ queryKey: ['price-history', securityId] })
      setCsvStatus(`✓ Imported ${d.imported} rows${d.errors.length ? ` (${d.errors.length} errors)` : ''}`)
    },
  })

  // Group data by year → month
  const byYear = useMemo(() => {
    const map: Record<string, Record<string, PriceRecord[]>> = {}
    for (const r of data as PriceRecord[]) {
      const [y, m] = r.price_date.split('-')
      if (!map[y]) map[y] = {}
      if (!map[y][m]) map[y][m] = []
      map[y][m].push(r)
    }
    return map
  }, [data])

  const years = Object.keys(byYear).sort((a, b) => +b - +a)

  // Default: most recent year expanded, most recent month within it expanded
  const [openYears, setOpenYears] = useState<Record<string, boolean>>({})
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (years.length === 0) return
    const latestYear = years[0]
    const latestMonth = Object.keys(byYear[latestYear]).sort((a, b) => +b - +a)[0]
    setOpenYears({ [latestYear]: true })
    setOpenMonths({ [`${latestYear}-${latestMonth}`]: true })
  }, [years.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  const toggleYear = (y: string) => setOpenYears(p => ({ ...p, [y]: !p[y] }))
  const toggleMonth = (key: string) => setOpenMonths(p => ({ ...p, [key]: !p[key] }))

  const addMut = useMutation({
    mutationFn: () => addHistoricalPrice(securityId, { price_date: addDate, price: parseFloat(addPrice), currency: addCurrency }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['price-history', securityId] })
      setShowAddForm(false)
      setAddPrice('')
    },
  })

  if (isLoading) return <div className="px-8 py-3 text-xs text-gray-400 animate-pulse">Loading history…</div>

  return (
    <div className="px-8 py-3 bg-gray-50 border-t border-gray-100">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Price History — {ticker} {data.length > 0 && <span className="font-normal normal-case text-gray-400">({data.length} entries)</span>}
      </div>

      {data.length === 0 ? (
        <div className="text-xs text-gray-400 italic mb-2">No price history recorded yet.</div>
      ) : (
        <div className="mb-2 space-y-0.5">
          {years.map(year => {
            const yearOpen = !!openYears[year]
            const months = Object.keys(byYear[year]).sort((a, b) => +b - +a)
            const yearCount = months.reduce((s, m) => s + byYear[year][m].length, 0)
            return (
              <div key={year} className="rounded border border-gray-200 bg-white overflow-hidden">
                {/* Year header */}
                <button
                  onClick={() => toggleYear(year)}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-gray-50 text-xs"
                >
                  <span className="font-semibold text-gray-700">{year}</span>
                  <span className="flex items-center gap-2 text-gray-400">
                    <span>{yearCount} entries</span>
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${yearOpen ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {yearOpen && (
                  <div className="border-t border-gray-100">
                    {months.map(month => {
                      const monthKey = `${year}-${month}`
                      const monthOpen = !!openMonths[monthKey]
                      const rows = byYear[year][month]
                      const monthName = MONTH_NAMES[+month - 1]
                      return (
                        <div key={month} className="border-b border-gray-100 last:border-0">
                          {/* Month header */}
                          <button
                            onClick={() => toggleMonth(monthKey)}
                            className="w-full flex items-center justify-between px-4 py-1 hover:bg-gray-50 text-xs"
                          >
                            <span className="text-gray-600">{monthName} {year}</span>
                            <span className="flex items-center gap-2 text-gray-400">
                              <span>{rows.length} entries</span>
                              <ChevronDown className={`h-3 w-3 transition-transform ${monthOpen ? 'rotate-180' : ''}`} />
                            </span>
                          </button>
                          {monthOpen && (
                            <table className="text-xs w-full max-w-2xl ml-4 mb-1">
                              <thead>
                                <tr className="text-gray-400 uppercase">
                                  <th className="text-left pb-1 pr-4 pl-2 font-medium">Date</th>
                                  <th className="text-right pb-1 pr-4 font-medium">Price</th>
                                  <th className="text-right pb-1 pr-4 font-medium">Price (CAD)</th>
                                  <th className="text-left pb-1 pr-4 font-medium">Source</th>
                                  <th className="pb-1 w-14"></th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-50">
                                {rows.map((r, i) => (
                                  <HistoryRow
                                    key={`${r.price_date}-${i}`}
                                    r={r}
                                    securityId={securityId}
                                    onChanged={() => qc.invalidateQueries({ queryKey: ['price-history', securityId] })}
                                  />
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mt-1">
        {!showAddForm ? (
          <button onClick={() => setShowAddForm(true)} className="text-xs text-blue-500 hover:text-blue-700">
            + Add row
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <DatePicker value={addDate || ''} onChange={setAddDate}
              max={new Date().toISOString().slice(0, 10)} placeholder="Date" />
            <input type="number" step="0.0001" min="0" placeholder="Price" value={addPrice}
              onChange={e => setAddPrice(e.target.value)}
              className="border border-gray-300 rounded px-2 py-0.5 text-xs w-24" />
            <select value={addCurrency} onChange={e => setAddCurrency(e.target.value)}
              className="border border-gray-300 rounded px-2 py-0.5 text-xs">
              <option>CAD</option><option>USD</option>
            </select>
            <button onClick={() => addMut.mutate()} disabled={addMut.isPending || !addPrice || !addDate}
              className="text-xs bg-blue-600 text-white rounded px-2 py-0.5 disabled:opacity-50">
              {addMut.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setShowAddForm(false); setAddPrice('') }}
              className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        )}

        <button onClick={() => setShowTools(t => !t)}
          className="text-xs text-gray-400 hover:text-gray-600 border border-dashed border-gray-300 rounded px-2 py-0.5">
          {showTools ? 'Hide tools' : 'More tools…'}
        </button>
      </div>

      {showTools && (
        <div className="mt-2 space-y-2 border border-gray-200 rounded-lg p-3 bg-white text-xs">
          {/* Delete all */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (window.confirm(`Delete ALL ${data.length} price history rows for ${ticker}?`)) deleteAllMut.mutate() }}
              disabled={deleteAllMut.isPending || data.length === 0}
              className="flex items-center gap-1 text-xs border border-red-200 text-red-600 rounded px-2 py-0.5 hover:bg-red-50 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              {deleteAllMut.isPending ? 'Deleting…' : `Delete all history (${data.length} rows)`}
            </button>
            {deleteAllMut.isSuccess && <span className="text-green-600">✓ Deleted</span>}
          </div>

          {/* CSV import */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 border border-gray-300 rounded px-2 py-0.5 hover:bg-gray-50 cursor-pointer">
              <RefreshCw className="h-3 w-3 text-gray-400" />
              {importCsvMut.isPending ? 'Importing…' : 'Import CSV'}
              <input type="file" accept=".csv,.txt" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) { setCsvStatus(null); importCsvMut.mutate(f) } e.target.value = '' }} />
            </label>
            <span className="text-gray-400">date, price [, currency] columns</span>
          </div>

          {/* Copy from another security */}
          <div className="flex items-center gap-2">
            <span className="text-gray-500">Copy history from security ID:</span>
            <input type="number" placeholder="Security ID" value={copyFromId}
              onChange={e => setCopyFromId(e.target.value)}
              className="border border-gray-300 rounded px-2 py-0.5 w-24" />
            <button
              onClick={() => copyFromMut.mutate()}
              disabled={copyFromMut.isPending || !copyFromId}
              className="border border-gray-300 rounded px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
            >
              {copyFromMut.isPending ? 'Copying…' : 'Copy'}
            </button>
            <span className="text-gray-400">(for ticker renames — copies all rows, overwrites conflicts)</span>
          </div>

          {csvStatus && <div className="text-green-600">{csvStatus}</div>}
          {importCsvMut.isError && <div className="text-red-500">Import failed — check CSV format</div>}
          {copyFromMut.isError && <div className="text-red-500">Copy failed — check security ID</div>}
        </div>
      )}
    </div>
  )
}

// ─── Main row ─────────────────────────────────────────────────────────────────

function PriceRow({ row }: { row: PriceReportRow }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const displayTicker = row.is_option ? formatOptionTicker(row.ticker) : row.ticker
  const pct = fmtPct(row.day_change_pct)

  const clearMut = useMutation({
    mutationFn: () => clearManualPrice(row.security_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['price-report'] }),
  })

  const [rowJobId, setRowJobId] = useState<string | null>(null)
  const fetchHistMut = useMutation({
    mutationFn: () => fetchPriceHistory({ security_ids: [row.security_id] }),
    onSuccess: (data) => { const id = data.job_id ?? data.id; if (id) setRowJobId(id) },
  })
  const { data: rowJob } = useQuery({
    queryKey: ['price-job', rowJobId],
    queryFn: () => getPriceJob(rowJobId!),
    enabled: !!rowJobId,
    refetchInterval: (q) => { const d = q.state.data; return !d || d.status === 'running' ? 2000 : false },
  })
  useEffect(() => {
    if (rowJob?.status === 'done') {
      qc.invalidateQueries({ queryKey: ['price-history', row.security_id] })
      setRowJobId(null)
    } else if (rowJob?.status === 'error') {
      setRowJobId(null)
    }
  }, [rowJob?.status])
  const rowBusy = fetchHistMut.isPending || (!!rowJobId && rowJob?.status === 'running')

  return (
    <>
      <tr className={`hover:bg-gray-50 transition-colors ${!row.has_price ? 'bg-amber-50/40' : ''}`}>
        {/* Expand toggle */}
        <td className="px-2 py-2.5 w-6">
          <button onClick={() => setExpanded(e => !e)}
            className="text-gray-300 hover:text-gray-500 transition-colors">
            {expanded
              ? <ChevronUp className="h-3.5 w-3.5" />
              : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </td>

        {/* Ticker / Name */}
        <td className="px-3 py-2.5">
          <div className="font-medium text-gray-900 text-sm">{displayTicker}</div>
          {row.name && !row.is_option && (
            <div className="text-xs text-gray-400 truncate max-w-[180px]">{row.name}</div>
          )}
        </td>

        {/* Asset class */}
        <td className="px-3 py-2.5 text-xs text-gray-500">{row.asset_class}</td>

        {/* Currency */}
        <td className="px-3 py-2.5 text-center"><CcyBadge currency={row.currency} /></td>

        {/* Exchange */}
        <td className="px-3 py-2.5 text-xs text-gray-400">{row.exchange ?? '—'}</td>

        {/* Price (native) */}
        <td className="px-3 py-2.5 text-right">
          {editing ? (
            <ManualEditor row={row} onDone={() => setEditing(false)} />
          ) : (
            <div className="flex items-center justify-end gap-1.5 group">
              <div className="text-right">
                {row.has_price ? (
                  <>
                    <span className="font-semibold text-sm">{fmtNative(row.price, row.price_currency)}</span>
                    {pct && (
                      <span className={`ml-1.5 text-xs ${pnlClass(row.day_change_pct)}`}>{pct}</span>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-amber-500 italic">no price</span>
                )}
              </div>
              <button onClick={() => setEditing(true)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-blue-500"
                title="Set price manually">
                <Pencil className="h-3 w-3" />
              </button>
              {row.source === 'manual' && (
                <button
                  onClick={() => clearMut.mutate()}
                  disabled={clearMut.isPending}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-500 disabled:opacity-30"
                  title="Remove manual override — next refresh will auto-fetch price">
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </td>

        {/* Price CAD */}
        <td className="px-3 py-2.5 text-right text-sm text-gray-600">
          {row.price_cad ? fmtCAD(row.price_cad) : '—'}
        </td>

        {/* Source */}
        <td className="px-3 py-2.5 text-center"><SourceBadge source={row.source} /></td>

        {/* Price date */}
        <td className="px-3 py-2.5 text-xs text-gray-400 whitespace-nowrap">{fmtDate(row.price_date)}</td>

        {/* Last fetched */}
        <td className="px-3 py-2.5 text-xs text-gray-400 whitespace-nowrap">{fmtDatetime(row.fetched_at)}</td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={10} className="p-0">
            <div className="flex items-center gap-2 px-4 pt-3 pb-1">
              <button
                onClick={() => fetchHistMut.mutate()}
                disabled={rowBusy}
                className="flex items-center gap-1.5 text-xs border border-gray-300 rounded px-2.5 py-1 hover:bg-gray-50 disabled:opacity-50"
                title="Re-download price history for this security from Yahoo Finance"
              >
                <RefreshCw className={`h-3 w-3 ${rowBusy ? 'animate-spin' : ''}`} />
                {rowBusy ? 'Fetching…' : 'Reload History'}
              </button>
              {!rowJobId && fetchHistMut.isSuccess && (
                <span className="text-xs text-green-600">✓ History refreshed</span>
              )}
              {rowJob?.status === 'error' && (
                <span className="text-xs text-red-500">Failed — check ticker/exchange</span>
              )}
            </div>
            <PriceHistory securityId={row.security_id} ticker={displayTicker} />
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const ASSET_CLASSES = ['EQUITY', 'OPTION', 'ETF', 'FIXED_INCOME', 'CASH', 'CURRENCY']
const CURRENCIES = ['CAD', 'USD']
const SOURCES = [
  { value: 'auto', label: 'Auto (Yahoo / MX)' },
  { value: 'manual', label: 'Manual' },
  { value: 'missing', label: 'Missing price' },
]

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250]

function Pagination({ page, totalPages, onPrev, onNext, pageSize, onPageSize }: {
  page: number; totalPages: number
  onPrev: () => void; onNext: () => void
  pageSize: number; onPageSize: (n: number) => void
}) {
  return (
    <div className="flex items-center gap-3 text-xs text-gray-500">
      <select
        value={pageSize}
        onChange={e => onPageSize(Number(e.target.value))}
        className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
      >
        {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n} / page</option>)}
      </select>
      <span className="text-gray-400">{page} / {totalPages}</span>
      <button onClick={onPrev} disabled={page <= 1}
        className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">← Prev</button>
      <button onClick={onNext} disabled={page >= totalPages}
        className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">Next →</button>
    </div>
  )
}

export default function Prices() {
  const qc = useQueryClient()
  const [assetClass, setAssetClass] = useState('')
  const [currency, setCurrency] = useState('')
  const [source, setSource] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const { data = [], isLoading } = useQuery({
    queryKey: ['price-report', assetClass, currency, source, search],
    queryFn: () => getPriceReport({
      asset_class: assetClass || undefined,
      currency: currency || undefined,
      source: source || undefined,
      search: search || undefined,
    }),
  })

  const recordHistMut = useMutation({
    mutationFn: recordOptionHistory,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['price-report'] }),
  })

  const [histJobId, setHistJobId] = useState<string | null>(null)
  const refreshHistMut = useMutation({
    mutationFn: () => fetchPriceHistory({}),
    onSuccess: (data) => { const id = data.job_id ?? data.id; if (id) setHistJobId(id) },
  })
  const { data: histJob } = useQuery({
    queryKey: ['price-job', histJobId],
    queryFn: () => getPriceJob(histJobId!),
    enabled: !!histJobId,
    refetchInterval: (q) => { const d = q.state.data; return !d || d.status === 'running' ? 2000 : false },
  })
  useEffect(() => {
    if (histJob?.status === 'done' || histJob?.status === 'error') {
      if (histJob.status === 'done') qc.invalidateQueries({ queryKey: ['price-report'] })
      setHistJobId(null)
    }
  }, [histJob?.status])
  const histBusy = refreshHistMut.isPending || (!!histJobId && histJob?.status === 'running')

  // Reset page when filters change
  useEffect(() => { setPage(1) }, [assetClass, currency, source, search])

  // Summary counts + pagination
  const counts = useMemo(() => ({
    total: data.length,
    withPrice: data.filter(r => r.has_price).length,
    manual: data.filter(r => r.source === 'manual').length,
    missing: data.filter(r => !r.has_price).length,
  }), [data])

  const totalPages = Math.max(1, Math.ceil(data.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageRows = data.slice((safePage - 1) * pageSize, safePage * pageSize)

  const paginationProps = {
    page: safePage, totalPages,
    onPrev: () => setPage(p => Math.max(1, p - 1)),
    onNext: () => setPage(p => Math.min(totalPages, p + 1)),
    pageSize, onPageSize: (n: number) => { setPageSize(n); setPage(1) },
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Security Prices</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => recordHistMut.mutate()}
            disabled={recordHistMut.isPending}
            title="Snapshot today's option prices into price history (run after a price refresh)"
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-purple-300 text-purple-700 hover:bg-purple-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${recordHistMut.isPending ? 'animate-spin' : ''}`} />
            {recordHistMut.isPending ? 'Recording…' : 'Record Option History'}
          </button>
          {recordHistMut.isSuccess && (
            <span className="text-xs text-green-600">✓ {(recordHistMut.data as { recorded?: number })?.recorded ?? 0} recorded</span>
          )}
          <button
            onClick={() => refreshHistMut.mutate()}
            disabled={histBusy}
            title="Download full price history from Yahoo Finance for all securities, back to each security's first transaction date. Use header 'Refresh Prices' for day-to-day updates."
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${histBusy ? 'animate-spin' : ''}`} />
            {histBusy ? 'Fetching… (background)' : 'Re-download Full History'}
          </button>
          {!histJobId && refreshHistMut.isSuccess && (
            <span className="text-xs text-green-600">✓ History updated</span>
          )}
          {histJob?.status === 'error' && (
            <span className="text-xs text-red-500">History fetch failed</span>
          )}
        </div>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-3 text-sm">
        {[
          { label: 'Total securities', val: counts.total, cls: 'bg-gray-100 text-gray-700' },
          { label: 'With price', val: counts.withPrice, cls: 'bg-green-50 text-green-700' },
          { label: 'Manual', val: counts.manual, cls: 'bg-amber-50 text-amber-700' },
          { label: 'Missing', val: counts.missing, cls: counts.missing > 0 ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-400' },
        ].map(({ label, val, cls }) => (
          <div key={label} className={`px-3 py-1.5 rounded-lg font-medium ${cls}`}>
            {val} <span className="font-normal opacity-75">{label}</span>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Search</label>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Ticker or name…"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-48 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Asset Class</label>
            <select value={assetClass} onChange={e => setAssetClass(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm">
              <option value="">All</option>
              {ASSET_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Currency</label>
            <select value={currency} onChange={e => setCurrency(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm">
              <option value="">All</option>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Source</label>
            <select value={source} onChange={e => setSource(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm">
              <option value="">All</option>
              {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          {(assetClass || currency || source || search) && (
            <button
              onClick={() => { setAssetClass(''); setCurrency(''); setSource(''); setSearch('') }}
              className="text-xs text-blue-600 hover:text-blue-800 underline pb-1.5"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : data.length === 0 ? (
          <p className="px-5 py-10 text-center text-gray-400 text-sm">No securities match the current filters.</p>
        ) : (
          <>
            <div className="flex justify-end px-4 py-2 border-b border-gray-100">
              <Pagination {...paginationProps} />
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm divide-y divide-gray-100">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="px-2 py-2.5 w-6" />
                    <th className="px-3 py-2.5 text-left">Security</th>
                    <th className="px-3 py-2.5 text-left">Class</th>
                    <th className="px-3 py-2.5 text-center">CCY</th>
                    <th className="px-3 py-2.5 text-left">Exchange</th>
                    <th className="px-3 py-2.5 text-right">Price (Native)</th>
                    <th className="px-3 py-2.5 text-right">Price (CAD)</th>
                    <th className="px-3 py-2.5 text-center">Source</th>
                    <th className="px-3 py-2.5 text-left">Price Date</th>
                    <th className="px-3 py-2.5 text-left">Last Fetched</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 bg-white">
                  {pageRows.map(row => <PriceRow key={row.security_id} row={row} />)}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end px-4 py-2 border-t border-gray-100">
              <Pagination {...paginationProps} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
