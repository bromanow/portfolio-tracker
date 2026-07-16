import { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getIbkrScannerParams, runIbkrScanner } from '../api/client'
import type { ScannerLocationNode } from '../api/client'
import { Loader2, Play, Plus, X, AlertTriangle } from 'lucide-react'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FlatLocation { type: string; label: string }

function flattenLocations(node: ScannerLocationNode, path: string[] = []): FlatLocation[] {
  if (!node.locations || node.locations.length === 0) {
    return [{ type: node.type, label: [...path, node.display_name].join(' › ') }]
  }
  return node.locations.flatMap(child => flattenLocations(child, [...path, node.display_name]))
}

// A handful of common scans to make this usable without hunting through 500+ codes.
// Only shown if the code is actually valid for the selected instrument.
const QUICK_SCANS = [
  { label: 'Top % Gainers', code: 'TOP_PERC_GAIN' },
  { label: 'Top % Losers', code: 'TOP_PERC_LOSE' },
  { label: 'Most Active', code: 'MOST_ACTIVE' },
  { label: 'High Dividend Yield', code: 'HIGH_DIVIDEND_YIELD_IB' },
  { label: 'Near 52-Wk High', code: 'HIGH_VS_52W_HL' },
  { label: 'Near 52-Wk Low', code: 'LOW_VS_52W_HL' },
]

interface FilterRow { code: string; value: string }

// ─── Main component ───────────────────────────────────────────────────────────

export default function IbkrScannerTool() {
  const paramsQ = useQuery({
    queryKey: ['ibkr-scanner-params'],
    queryFn: getIbkrScannerParams,
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
  const params = paramsQ.data

  const [instrument, setInstrument] = useState('STK')
  const [location, setLocation] = useState('STK.US.MAJOR')
  const [scanCode, setScanCode] = useState('TOP_PERC_GAIN')
  const [filterRows, setFilterRows] = useState<FilterRow[]>([])

  const locations = useMemo(() => {
    if (!params) return [] as FlatLocation[]
    const node = params.location_tree.find(l => l.type === instrument)
    return node ? flattenLocations(node) : []
  }, [params, instrument])

  const scanCodes = useMemo(() => {
    if (!params) return []
    return params.scan_type_list.filter(s => s.instruments.includes(instrument))
  }, [params, instrument])

  const filterOptions = useMemo(() => {
    if (!params) return []
    const inst = params.instrument_list.find(i => i.type === instrument)
    if (!inst) return []
    const allowed = new Set(inst.filters)
    return params.filter_list.filter(f => allowed.has(f.code))
  }, [params, instrument])

  const quickScans = QUICK_SCANS.filter(q => scanCodes.some(s => s.code === q.code))

  const handleInstrumentChange = (type: string) => {
    setInstrument(type)
    const node = params?.location_tree.find(l => l.type === type)
    const locs = node ? flattenLocations(node) : []
    setLocation(locs[0]?.type ?? '')
    const codes = params?.scan_type_list.filter(s => s.instruments.includes(type)) ?? []
    setScanCode(codes[0]?.code ?? '')
    setFilterRows([])
  }

  const addFilterRow = () => setFilterRows(rows => [...rows, { code: filterOptions[0]?.code ?? '', value: '' }])
  const removeFilterRow = (i: number) => setFilterRows(rows => rows.filter((_, idx) => idx !== i))
  const updateFilterRow = (i: number, patch: Partial<FilterRow>) =>
    setFilterRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const runMutation = useMutation({
    mutationFn: () =>
      runIbkrScanner({
        instrument,
        location,
        scan_code: scanCode,
        filters: filterRows
          .filter(r => r.code && r.value !== '')
          .map(r => ({ code: r.code, value: parseFloat(r.value) })),
      }),
  })

  if (paramsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading scanner metadata from IBKR…
      </div>
    )
  }

  if (paramsQ.isError || !params) {
    const detail = (paramsQ.error as { response?: { data?: { detail?: string } } } | undefined)
      ?.response?.data?.detail
    return (
      <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-4">
        <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <span>{detail || 'Could not reach IBKR — make sure IBeam is connected (log in to refresh a live session).'}</span>
      </div>
    )
  }

  const results = runMutation.data?.items ?? []

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Instrument</label>
            <select
              value={instrument}
              onChange={e => handleInstrumentChange(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {params.instrument_list.map(i => (
                <option key={i.type} value={i.type}>{i.display_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Location</label>
            <select
              value={location}
              onChange={e => setLocation(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {locations.map(l => (
                <option key={l.type} value={l.type}>{l.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Scan ({scanCodes.length} available)</label>
            <select
              value={scanCode}
              onChange={e => setScanCode(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {scanCodes.map(s => (
                <option key={s.code} value={s.code}>{s.display_name}</option>
              ))}
            </select>
          </div>
        </div>

        {quickScans.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {quickScans.map(q => (
              <button
                key={q.code}
                onClick={() => setScanCode(q.code)}
                className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                  scanCode === q.code
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>
        )}

        {/* ── Filters ── */}
        <div className="pt-3 border-t border-gray-100 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-500">Filters (optional)</label>
            <button
              onClick={addFilterRow}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
            >
              <Plus className="h-3 w-3" /> Add filter
            </button>
          </div>
          {filterRows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={row.code}
                onChange={e => updateFilterRow(i, { code: e.target.value })}
                className="flex-1 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs"
              >
                {filterOptions.map(f => (
                  <option key={f.code} value={f.code}>{f.display_name}</option>
                ))}
              </select>
              <input
                type="number"
                value={row.value}
                onChange={e => updateFilterRow(i, { value: e.target.value })}
                placeholder="Value"
                className="w-28 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs"
              />
              <button onClick={() => removeFilterRow(i)} className="text-gray-300 hover:text-red-500">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {runMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run Scan
        </button>
      </div>

      {runMutation.isError && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-4">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            {(runMutation.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
              || 'Scan failed.'}
          </span>
        </div>
      )}

      {runMutation.isSuccess && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {results.length} result{results.length !== 1 ? 's' : ''}
              {results.length === 50 && <span className="ml-1.5 normal-case font-normal text-gray-400">(IBKR caps each scan at 50 — narrow with filters for more precision)</span>}
            </span>
          </div>
          {results.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">No matches</div>
          ) : (
            <table className="min-w-full text-sm divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr className="text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2 text-left w-12">#</th>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-left">Exchange</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {results.map((r, i) => (
                  <tr key={r.con_id ?? i} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2 font-mono font-semibold text-blue-700">{r.symbol || '—'}</td>
                    <td className="px-3 py-2 text-gray-700">{r.company_name || '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">{r.exchange || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
