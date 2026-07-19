import { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { getIbkrScannerParams, runIbkrScanner } from '../api/client'
import type { ScannerLocationNode } from '../api/client'
import { Loader2, Play, Plus, X, AlertTriangle } from 'lucide-react'
import TickerLink from './TickerLink'

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

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

function pctClass(n: number | null | undefined): string {
  if (n == null) return 'text-muted-foreground'
  return n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'
}

/** Compact low—pin—high bar, mirroring the Holdings page's Day/52-Wk Range columns. */
function RangeBar({ low, high, current }: { low: number | null; high: number | null; current: number | null }) {
  if (low == null || high == null || current == null || !isFinite(low) || !isFinite(high) || high <= low) {
    return <span className="text-muted-foreground/50 text-xs">—</span>
  }
  const pct = Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100))
  return (
    <div className="w-28">
      <div className="relative h-4">
        <div className="absolute top-0 text-primary" style={{ left: `${pct}%`, transform: 'translateX(-50%)' }} title={fmtPrice(current)}>
          <svg width="11" height="14" viewBox="0 0 14 18" fill="currentColor">
            <path d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 11 7 11s7-5.75 7-11c0-3.87-3.13-7-7-7z" />
          </svg>
        </div>
        <div className="absolute left-0 right-0 top-[13px] h-[3px] bg-accent rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1 tabular-nums leading-none">
        <span>{fmtPrice(low)}</span>
        <span>{fmtPrice(high)}</span>
      </div>
    </div>
  )
}

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
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
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
      <div className="bg-card rounded-xl border border-border p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Instrument</label>
            <select
              value={instrument}
              onChange={e => handleInstrumentChange(e.target.value)}
              className="bg-background text-foreground w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              {params.instrument_list.map(i => (
                <option key={i.type} value={i.type}>{i.display_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Location</label>
            <select
              value={location}
              onChange={e => setLocation(e.target.value)}
              className="bg-background text-foreground w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              {locations.map(l => (
                <option key={l.type} value={l.type}>{l.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Scan ({scanCodes.length} available)</label>
            <select
              value={scanCode}
              onChange={e => setScanCode(e.target.value)}
              className="bg-background text-foreground w-full border border-border rounded-lg px-3 py-2 text-sm"
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
                    ? 'bg-primary text-white border-primary'
                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-accent'
                }`}
              >
                {q.label}
              </button>
            ))}
          </div>
        )}

        {/* ── Filters ── */}
        <div className="pt-3 border-t border-border space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">Filters (optional)</label>
            <button
              onClick={addFilterRow}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary"
            >
              <Plus className="h-3 w-3" /> Add filter
            </button>
          </div>
          {filterRows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={row.code}
                onChange={e => updateFilterRow(i, { code: e.target.value })}
                className="bg-background text-foreground flex-1 border border-border rounded-lg px-2.5 py-1.5 text-xs"
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
                className="bg-background text-foreground w-28 border border-border rounded-lg px-2.5 py-1.5 text-xs"
              />
              <button onClick={() => removeFilterRow(i)} className="text-muted-foreground/50 hover:text-red-500 dark:text-red-400">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
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
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {results.length} result{results.length !== 1 ? 's' : ''}
              {results.length === 50 && <span className="ml-1.5 normal-case font-normal text-muted-foreground">(IBKR caps each scan at 50 — narrow with filters for more precision)</span>}
            </span>
          </div>
          {results.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No matches</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="min-w-full text-sm divide-y divide-border">
              <thead className="bg-muted/50">
                <tr className="text-xs text-muted-foreground uppercase">
                  <th className="px-3 py-2 text-left w-10">#</th>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Company</th>
                  <th className="px-3 py-2 text-left">Exchange</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Chg %</th>
                  <th className="px-3 py-2 text-right">Volume</th>
                  <th className="px-3 py-2 text-right">Avg Vol</th>
                  <th className="px-3 py-2 text-left">Day Range</th>
                  <th className="px-3 py-2 text-left">52-Wk Range</th>
                  <th className="px-3 py-2 text-left">Industry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {results.map((r, i) => (
                  <tr key={r.con_id ?? i} className="hover:bg-muted/50">
                    <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-2 font-mono font-semibold text-primary">
                      {r.symbol ? <TickerLink ticker={r.symbol} /> : '—'}
                    </td>
                    <td className="px-3 py-2 text-foreground whitespace-nowrap">{r.company_name || '—'}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.exchange || '—'}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmtPrice(r.last_price)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${pctClass(r.change_pct)}`}>{fmtPct(r.change_pct)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap">{r.volume || '—'}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap text-xs">{r.avg_volume || '—'}</td>
                    <td className="px-3 py-2"><RangeBar low={r.day_low} high={r.day_high} current={r.last_price} /></td>
                    <td className="px-3 py-2"><RangeBar low={r.week52_low} high={r.week52_high} current={r.last_price} /></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{r.industry || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
