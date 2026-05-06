import React, { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getScannerMeta, getScannerResults, triggerScan,
  getWatchlist, addToWatchlist, removeFromWatchlist,
  getPriceJob,
} from '../api/client'
import type { ScannerResult, WatchlistItem } from '../api/client'
import {
  Play, RefreshCw, X, Plus, Search, ChevronUp, ChevronDown,
  ChevronsUpDown, Star, Briefcase, AlertTriangle, Wifi, WifiOff,
  ChevronRight, Zap, RotateCcw, Info,
} from 'lucide-react'

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n: number | null | undefined, d = 2, prefix = ''): string {
  if (n == null) return '—'
  return prefix + n.toFixed(d)
}

function fmtPct(n: number | null | undefined, d = 1): string {
  if (n == null) return '—'
  return n.toFixed(d) + '%'
}

function fmtVol(n: number | null | undefined): string {
  if (n == null) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (abs >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return String(n)
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc'
type SortCol = keyof ScannerResult

const RATING_ORDER: Record<string, number> = { Best: 0, Good: 1, Fair: 2, Avoid: 3 }

function sortRows(rows: ScannerResult[], col: SortCol, dir: SortDir): ScannerResult[] {
  return [...rows].sort((a, b) => {
    if (col === 'recommendation') {
      const oa = RATING_ORDER[a.recommendation ?? ''] ?? 99
      const ob = RATING_ORDER[b.recommendation ?? ''] ?? 99
      return dir === 'asc' ? oa - ob : ob - oa
    }
    const rawA = a[col] ?? null
    const rawB = b[col] ?? null
    if (rawA == null && rawB == null) return 0
    if (rawA == null) return 1
    if (rawB == null) return -1
    const numA = typeof rawA === 'number' ? rawA : parseFloat(String(rawA))
    const numB = typeof rawB === 'number' ? rawB : parseFloat(String(rawB))
    const cmp = (!isNaN(numA) && !isNaN(numB))
      ? numA - numB
      : String(rawA).localeCompare(String(rawB), undefined, { sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

// ─── Recommendation badge ─────────────────────────────────────────────────────

function RecommendationBadge({ rec }: { rec: string | null }) {
  if (!rec) return <span className="text-gray-300">—</span>
  const styles: Record<string, string> = {
    Best:  'bg-emerald-100 text-emerald-700 border border-emerald-200',
    Good:  'bg-blue-100 text-blue-700 border border-blue-200',
    Fair:  'bg-amber-100 text-amber-700 border border-amber-200',
    Avoid: 'bg-red-100 text-red-600 border border-red-200',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${styles[rec] ?? 'bg-gray-100 text-gray-500 border border-gray-200'}`}>
      {rec}
    </span>
  )
}

// ─── Delta badge ──────────────────────────────────────────────────────────────

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta == null) return <span className="text-gray-300">—</span>
  const abs = Math.abs(delta)
  const color =
    abs >= 0.20 && abs <= 0.30 ? 'text-emerald-600 font-semibold' :
    ((abs >= 0.15 && abs < 0.20) || (abs > 0.30 && abs <= 0.35)) ? 'text-amber-600' :
    abs > 0.45 ? 'text-red-500' :
    'text-gray-500'
  return <span className={`tabular-nums ${color}`}>{delta.toFixed(2)}</span>
}

// ─── Score badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="text-gray-300">—</span>
  const color =
    score >= 20 ? 'bg-emerald-100 text-emerald-700' :
    score >= 12 ? 'bg-blue-100 text-blue-700' :
    score >= 6  ? 'bg-amber-100 text-amber-700' :
                  'bg-gray-100 text-gray-500'
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold tabular-nums ${color}`}>
      {score.toFixed(1)}
    </span>
  )
}

// ─── IV/HV badge ─────────────────────────────────────────────────────────────

function IvHvBadge({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <span className="text-gray-300">—</span>
  const color =
    ratio >= 1.3 ? 'text-emerald-600 font-semibold' :
    ratio >= 1.1 ? 'text-emerald-500' :
    ratio >= 0.9 ? 'text-gray-600' :
                   'text-red-400'
  return <span className={`tabular-nums ${color}`}>{ratio.toFixed(2)}×</span>
}

// ─── Data-source pill ─────────────────────────────────────────────────────────

function DataSourcePill({ source }: { source: string | null }) {
  if (!source) return null
  const isLive = source === 'ibkr'
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded font-medium ${
      isLive ? 'bg-emerald-100 text-emerald-600' : 'bg-gray-100 text-gray-400'
    }`}>
      {isLive ? <Zap className="h-2.5 w-2.5" /> : null}
      {isLive ? 'live' : 'delayed'}
    </span>
  )
}

// ─── Info tooltip ─────────────────────────────────────────────────────────────

function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex items-center ml-0.5 align-middle">
      <Info className="h-3 w-3 text-gray-300 hover:text-blue-400 cursor-help transition-colors" />
      <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 w-56 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] leading-snug text-white shadow-xl opacity-0 group-hover:opacity-100 transition-opacity z-50 whitespace-normal text-left font-normal">
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-gray-900" />
        {text}
      </span>
    </span>
  )
}

// ─── Sort header ──────────────────────────────────────────────────────────────

function SortTh({
  col, label, tip, sortCol, sortDir, onSort,
  align = 'right', className = '',
}: {
  col: SortCol; label: string; tip?: string; sortCol: SortCol; sortDir: SortDir
  onSort: (c: SortCol) => void; align?: 'left' | 'right'; className?: string
}) {
  const active = sortCol === col
  const Icon = active ? (sortDir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown
  return (
    <th
      className={`px-3 py-2 text-xs font-semibold text-gray-500 cursor-pointer select-none whitespace-nowrap hover:bg-gray-100 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
      onClick={() => onSort(col)}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        <Icon className={`h-3 w-3 ${active ? 'text-blue-500' : 'text-gray-300'}`} />
        {label}
        {tip && <span onClick={e => e.stopPropagation()}><InfoTip text={tip} /></span>}
      </span>
    </th>
  )
}

// ─── Suggested Universe ───────────────────────────────────────────────────────

const SUGGESTED: { label: string; tickers: string[] }[] = [
  {
    label: 'Blue Chip / Dividend',
    tickers: ['KO', 'PEP', 'JNJ', 'PG', 'MCD', 'WMT', 'VZ', 'T', 'ABBV', 'PFE'],
  },
  {
    label: 'Tech / Growth',
    tickers: ['AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AMD', 'INTC', 'CSCO'],
  },
  {
    label: 'Financial / Energy',
    tickers: ['JPM', 'BAC', 'GS', 'XOM', 'CVX', 'OXY', 'SLB'],
  },
  {
    label: 'Canadian (TSX)',
    tickers: ['RY.TO', 'TD.TO', 'BNS.TO', 'BMO.TO', 'ENB.TO', 'TRP.TO', 'CNR.TO', 'SU.TO', 'BCE.TO'],
  },
]

function SuggestedUniverse({ watchlistTickers, onAdd }: { watchlistTickers: Set<string>; onAdd: (t: string) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border border-dashed border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-500 hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Star className="h-3 w-3 text-amber-400" />
          Suggested Universe
        </span>
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          <p className="text-[11px] text-gray-400">
            Quality covered-call candidates: liquid, optionable, typically IV-rich.
            Click + to add to your watchlist.
          </p>
          {SUGGESTED.map(group => (
            <div key={group.label}>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mb-1.5">{group.label}</div>
              <div className="flex flex-wrap gap-1">
                {group.tickers.map(t => {
                  const already = watchlistTickers.has(t)
                  return (
                    <button
                      key={t}
                      onClick={() => !already && onAdd(t)}
                      disabled={already}
                      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        already
                          ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-default'
                          : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50'
                      }`}
                    >
                      {already ? null : <Plus className="h-2.5 w-2.5" />}
                      {t}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Collapsible section ──────────────────────────────────────────────────────

function CollapsibleSection({
  label, defaultOpen = true, compact = false, children,
}: {
  label: string; defaultOpen?: boolean; compact?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className={`w-full flex items-center justify-between text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 hover:text-gray-700 transition-colors ${compact ? 'py-0.5' : 'py-1'}`}
      >
        <span className="flex items-center gap-1.5">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && children}
    </div>
  )
}

// ─── Watchlist panel ──────────────────────────────────────────────────────────

function WatchlistPanel() {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: watchlist = [] } = useQuery({
    queryKey: ['scanner-watchlist'],
    queryFn: getWatchlist,
  })

  const addMut = useMutation({
    mutationFn: (ticker: string) => addToWatchlist(ticker),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scanner-watchlist'] })
      setInput('')
      setError(null)
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(msg ?? 'Failed to add ticker')
    },
  })

  const removeMut = useMutation({
    mutationFn: removeFromWatchlist,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanner-watchlist'] }),
  })

  const submit = (ticker?: string) => {
    const t = (ticker ?? input).trim().toUpperCase()
    if (!t) return
    addMut.mutate(t)
  }

  const watchlistTickers = useMemo(
    () => new Set(watchlist.map((w: WatchlistItem) => w.ticker)),
    [watchlist]
  )

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
      <h2 className="font-semibold text-gray-800 flex items-center gap-2">
        <Star className="h-4 w-4 text-amber-400" />
        Watchlist
        <span className="text-xs text-gray-400 font-normal ml-1">
          {watchlist.length} ticker{watchlist.length !== 1 ? 's' : ''}
        </span>
      </h2>
      <p className="text-xs text-gray-400">
        Add any ticker here. The scanner also automatically includes all your portfolio positions.
      </p>

      {/* Add form */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => { setInput(e.target.value.toUpperCase()); setError(null) }}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. AAPL, SU.TO"
          className="flex-1 border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => submit()}
          disabled={!input.trim() || addMut.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}

      {/* Ticker chips */}
      {watchlist.length > 0 && (
        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
          {watchlist.map((item: WatchlistItem) => (
            <span
              key={item.ticker}
              className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 text-xs px-2 py-1 rounded-full"
              title={item.company_name ?? item.ticker}
            >
              {item.ticker}
              <button
                onClick={() => removeMut.mutate(item.ticker)}
                className="text-gray-400 hover:text-red-500 ml-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Suggested universe */}
      <SuggestedUniverse watchlistTickers={watchlistTickers} onAdd={submit} />
    </div>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

interface Filters {
  minYield: number
  maxOtm: number
  minDelta: number
  maxDelta: number
  minOi: number
  minOptionVol: number
  minStockVol: number
  minDivYield: number
  minDte: number
  maxDte: number
  minRating: string
  inPortfolioOnly: boolean
  search: string
}

const DEFAULT_FILTERS: Filters = {
  minYield: 8,
  maxOtm: 20,
  minDelta: 0,
  maxDelta: 1,
  minOi: 50,
  minOptionVol: 3,
  minStockVol: 250_000,
  minDivYield: 0,
  minDte: 14,
  maxDte: 60,
  minRating: 'Avoid',
  inPortfolioOnly: false,
  search: '',
}

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch })
  const isDirty = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS)
  const n = "border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"

  return (
    <div className="bg-gray-50 rounded-lg px-4 py-3 space-y-2.5">
      {/* Row 1 — returns & expiry */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide w-14 shrink-0">Returns</span>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Min yield</span>
          <input type="number" value={filters.minYield} min={0} max={100} step={0.5}
            className={`${n} w-16`} onChange={e => set({ minYield: parseFloat(e.target.value) || 0 })} />
          <span className="text-xs text-gray-400">%/yr</span>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Max OTM</span>
          <input type="number" value={filters.maxOtm} min={1} max={50} step={1}
            className={`${n} w-16`} onChange={e => { const v = parseFloat(e.target.value); set({ maxOtm: isNaN(v) ? 25 : v }) }} />
          <span className="text-xs text-gray-400">%</span>
        </label>

        <div className="w-px h-4 bg-gray-200 mx-1" />
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide shrink-0">Expiry</span>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">DTE</span>
          <input type="number" value={filters.minDte} min={0} max={365} step={1}
            className={`${n} w-14`} onChange={e => set({ minDte: parseInt(e.target.value) || 0 })} />
          <span className="text-xs text-gray-400">–</span>
          <input type="number" value={filters.maxDte} min={1} max={365} step={1}
            className={`${n} w-14`} onChange={e => set({ maxDte: parseInt(e.target.value) || 999 })} />
          <span className="text-xs text-gray-400">days</span>
        </label>

        <div className="w-px h-4 bg-gray-200 mx-1" />

        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input type="checkbox" checked={filters.inPortfolioOnly}
            onChange={e => set({ inPortfolioOnly: e.target.checked })}
            className="rounded text-blue-600" />
          <span className="text-xs text-gray-600 flex items-center gap-1">
            <Briefcase className="h-3 w-3" /> Portfolio only
          </span>
        </label>

        <div className="w-px h-4 bg-gray-200 mx-1" />

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Min Rating</span>
          <select value={filters.minRating} onChange={e => set({ minRating: e.target.value })}
            className={`${n} pr-6`}>
            <option value="Avoid">All (Avoid+)</option>
            <option value="Fair">Fair+</option>
            <option value="Good">Good+</option>
            <option value="Best">Best only</option>
          </select>
        </label>
      </div>

      {/* Row 2 — Greeks & liquidity */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide w-14 shrink-0">Greeks</span>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Delta (Δ)</span>
          <input type="number" value={filters.minDelta} min={0} max={1} step={0.05}
            className={`${n} w-16`} onChange={e => { const v = parseFloat(e.target.value); set({ minDelta: isNaN(v) ? 0 : v }) }} />
          <span className="text-xs text-gray-400">–</span>
          <input type="number" value={filters.maxDelta} min={0} max={1} step={0.05}
            className={`${n} w-16`} onChange={e => { const v = parseFloat(e.target.value); set({ maxDelta: isNaN(v) ? 1 : v }) }} />
        </label>

        <div className="w-px h-4 bg-gray-200 mx-1" />
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide shrink-0">Liquidity</span>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Min option OI</span>
          <input type="number" value={filters.minOi} min={0} step={50}
            className={`${n} w-20`} onChange={e => set({ minOi: parseInt(e.target.value) || 0 })} />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Min option vol/day</span>
          <input type="number" value={filters.minOptionVol} min={0} step={1}
            className={`${n} w-16`} onChange={e => set({ minOptionVol: parseInt(e.target.value) || 0 })} />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Min stock avg vol</span>
          <input type="number" value={filters.minStockVol} min={0} step={50_000}
            className={`${n} w-24`} onChange={e => set({ minStockVol: parseInt(e.target.value) || 0 })} />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 whitespace-nowrap">Min div yield</span>
          <input type="number" value={filters.minDivYield} min={0} max={20} step={0.5}
            className={`${n} w-16`} onChange={e => set({ minDivYield: parseFloat(e.target.value) || 0 })} />
          <span className="text-xs text-gray-400">%</span>
        </label>

        <div className="flex items-center gap-2 ml-auto">
          <Search className="h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            value={filters.search}
            onChange={e => set({ search: e.target.value.toUpperCase() })}
            placeholder="Filter ticker…"
            className={`${n} w-28`}
          />
          {isDirty && (
            <button
              onClick={() => onChange(DEFAULT_FILTERS)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 px-1.5 py-1 rounded hover:bg-gray-200 transition-colors"
              title="Reset filters to defaults"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Results filter bar (rating toggles + min score) ─────────────────────────

const ALL_RATINGS = ['Best', 'Good', 'Fair', 'Avoid'] as const
const RATING_BADGE: Record<string, string> = {
  Best:  'bg-emerald-100 text-emerald-700 border border-emerald-200',
  Good:  'bg-blue-100 text-blue-700 border border-blue-200',
  Fair:  'bg-amber-100 text-amber-700 border border-amber-200',
  Avoid: 'bg-red-100 text-red-600 border border-red-200',
}

function ResultsFilterBar({
  activeRatings, minScore,
  onToggleRating, onMinScore,
}: {
  activeRatings: Set<string>
  minScore: number
  onToggleRating: (r: string) => void
  onMinScore: (v: number) => void
}) {
  const n = "border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
  const allActive = activeRatings.size === 0
  return (
    <div className="flex flex-wrap items-center gap-3 bg-gray-50 rounded-lg px-4 py-2.5 text-xs">
      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide shrink-0">Filter Results</span>
      <div className="flex items-center gap-1.5">
        <span className="text-gray-500 mr-0.5">Rating:</span>
        <button
          onClick={() => activeRatings.size > 0 && onToggleRating('__all__')}
          className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${allActive ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-500 border-gray-300 hover:border-gray-500'}`}
        >All</button>
        {ALL_RATINGS.map(r => {
          const active = activeRatings.has(r)
          return (
            <button key={r} onClick={() => onToggleRating(r)}
              className={`px-2 py-0.5 rounded text-xs font-semibold border transition-colors ${active ? RATING_BADGE[r] : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400 hover:text-gray-600'}`}
            >{r}</button>
          )
        })}
      </div>
      <div className="w-px h-4 bg-gray-200" />
      <label className="flex items-center gap-1.5">
        <span className="text-gray-500 whitespace-nowrap">Min Score</span>
        <input type="number" value={minScore} min={0} max={40} step={1}
          className={`${n} w-16 text-xs`}
          onChange={e => { const v = parseFloat(e.target.value); onMinScore(isNaN(v) ? 0 : v) }} />
      </label>
    </div>
  )
}

// ─── Results table ────────────────────────────────────────────────────────────

function ResultsTable({ rows }: { rows: ScannerResult[] }) {
  const [sortCol, setSortCol] = useState<SortCol>('score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = useMemo(() => sortRows(rows, sortCol, sortDir), [rows, sortCol, sortDir])

  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const th = (col: SortCol, label: string, tip: string, align: 'left' | 'right' = 'right') => (
    <SortTh col={col} label={label} tip={tip} sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align={align} />
  )

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <AlertTriangle className="h-8 w-8 mb-2 text-gray-200" />
        <p className="text-sm">No opportunities match the current filters.</p>
        <p className="text-xs mt-1">Try lowering the minimum yield or widening the DTE / Delta range.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            {th('ticker',            'Ticker',      'Stock symbol. Blue background = you own shares in your portfolio. The briefcase badge shows how many 100-share contracts you could write.', 'left')}
            {th('recommendation',    'Rating',      'Overall quality rating: Best = high score + ideal delta; Good = solid setup; Fair = acceptable but not ideal; Avoid = high assignment risk or wide spread.', 'left')}
            {th('score',             'Score',       'Composite quality score. Higher is better. Formula: CC yield × delta quality × IV richness × DTE sweet-spot × liquidity × spread quality. Use it to rank opportunities, not as an absolute target.')}
            {th('current_price',     'Price',       'Current stock price (delayed ~15 min for yfinance, live for IBKR).')}
            {th('dividend_yield',    'Div Yield',   'Company annual dividend yield as a % of current share price. Dividends add to total return on top of covered-call premium.')}
            {th('strike',            'Strike',      'The strike price of the call option you would sell. Must be above current price (OTM) to be a covered call.')}
            {th('expiry_date',       'Expiry',      'Option expiration date. After this date the option expires worthless (you keep the premium) or is assigned (you sell your shares at the strike).')}
            {th('dte',               'DTE',         'Days To Expiration. 28–45 days is the sweet spot for theta decay — enough time value to collect meaningful premium, short enough for rapid decay.')}
            {th('delta',             'Δ Delta',     'Option delta: probability the option expires in-the-money (roughly). 0.20–0.30 is the covered-call sweet spot — good premium, ~70–80% chance of expiring worthless. IBKR: live. yfinance: Black-Scholes estimate.')}
            {th('bid',               'Bid',         'Highest price a buyer will pay. You would typically fill between bid and mid.')}
            {th('ask',               'Ask',         'Lowest price a seller will accept.')}
            {th('mid',               'Mid',         'Midpoint of bid and ask — the fair value of the option. Used to calculate yield.')}
            {th('bid_ask_spread_pct','Spread%',     'Bid/ask spread as % of ask price. Tighter is better — easier to get filled near mid. Under 5% is excellent, over 25% makes it hard to fill at a good price.')}
            {th('annual_yield_pct',  'CC yield/yr', 'Covered-call option premium expressed as an annualized % of the stock price. Formula: (mid / stock price) × (365 / DTE) × 100. This is income from selling the call, separate from any dividends.')}
            {th('otm_pct',           'OTM %',       'How far the strike is above the current stock price, as a %. Higher = more buffer before assignment, but lower premium.')}
            {th('max_return_pct',    'Max Return',  'Total return if the stock is called away at the strike: (strike − price + premium) / price. This is the best case scenario.')}
            {th('breakeven',         'Breakeven',   'Stock price at which you break even if the stock falls: current price minus the option premium collected.')}
            {th('iv_pct',            'IV',          'Implied Volatility — the market\'s expectation of future price movement, expressed as an annualised %. Higher IV = richer premium. Compare to HV to see if options are expensive or cheap.')}
            {th('hv_30_pct',         'HV 30d',      '30-day Historical Volatility — how much the stock actually moved over the past 30 days, annualised. Computed from your stored price history.')}
            {th('iv_hv_ratio',       'IV/HV',       'IV divided by HV. Above 1.0× means the market is paying more than recent realized volatility — you\'re selling overpriced options. 1.2×+ is ideal for covered calls.')}
            {th('theta',             'Θ/day',       'Theta (time decay) in dollars per day. This is how much option value erodes each day due to passage of time — money that flows to you as the seller.')}
            {th('open_interest',     'OI',          'Open Interest — number of outstanding contracts. Higher OI = more liquid market, easier to get a good fill. Under 50 can be hard to trade.')}
            {th('volume',            'Vol',         'Option contracts traded today. Low volume makes it harder to fill at the mid price.')}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {sorted.map(r => {
            const yieldColor =
              (r.annual_yield_pct ?? 0) >= 20 ? 'text-emerald-600 font-semibold' :
              (r.annual_yield_pct ?? 0) >= 12 ? 'text-emerald-600' :
              (r.annual_yield_pct ?? 0) >= 8  ? 'text-amber-600' : 'text-gray-700'

            const spreadColor =
              (r.bid_ask_spread_pct ?? 99) <= 5  ? 'text-emerald-600' :
              (r.bid_ask_spread_pct ?? 99) <= 15 ? 'text-gray-600' :
              (r.bid_ask_spread_pct ?? 99) <= 25 ? 'text-amber-600' : 'text-red-500'

            return (
              <tr key={r.id} className={`hover:bg-blue-50/30 transition-colors ${r.in_portfolio ? 'bg-blue-50/20' : ''}`}>
                {/* Ticker */}
                <td className="px-3 py-2 text-left whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-gray-900">{r.ticker}</span>
                    {r.in_portfolio && (
                      <span className="text-[10px] font-medium bg-blue-100 text-blue-600 px-1 py-0.5 rounded"
                        title={`${r.portfolio_qty} shares · ${r.portfolio_contracts} contracts`}>
                        <Briefcase className="h-2.5 w-2.5 inline" /> {r.portfolio_contracts}c
                      </span>
                    )}
                    <DataSourcePill source={r.data_source} />
                  </div>
                  {r.company_name && (
                    <div className="text-xs text-gray-400 whitespace-nowrap">{r.company_name}</div>
                  )}
                </td>

                {/* Rating */}
                <td className="px-3 py-2 text-left">
                  <RecommendationBadge rec={r.recommendation} />
                </td>

                {/* Score */}
                <td className="px-3 py-2 text-right">
                  <ScoreBadge score={r.score} />
                </td>

                {/* Price & contract details */}
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {r.currency === 'CAD' ? 'C$' : '$'}{fmt(r.current_price, 2)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.dividend_yield != null
                    ? <span className={`text-xs ${r.dividend_yield >= 3 ? 'text-emerald-600 font-medium' : 'text-gray-500'}`}>{fmtPct(r.dividend_yield, 1)}</span>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">
                  {fmt(r.strike, 2)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600 text-xs">
                  {r.expiry_date ?? '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <span className={`text-xs font-medium ${
                    (r.dte ?? 99) <= 21 ? 'text-amber-600' :
                    (r.dte ?? 99) <= 45 ? 'text-gray-700' : 'text-gray-500'
                  }`}>{r.dte}</span>
                </td>

                {/* Delta */}
                <td className="px-3 py-2 text-right">
                  <DeltaBadge delta={r.delta} />
                </td>

                {/* Bid / Ask / Mid */}
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{fmt(r.bid, 2)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">{fmt(r.ask, 2)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium text-gray-800">{fmt(r.mid, 2)}</td>

                {/* Spread */}
                <td className={`px-3 py-2 text-right tabular-nums text-xs ${spreadColor}`}>
                  {fmtPct(r.bid_ask_spread_pct, 1)}
                </td>

                {/* Analytics */}
                <td className={`px-3 py-2 text-right tabular-nums ${yieldColor}`}>
                  {fmtPct(r.annual_yield_pct, 1)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                  {fmtPct(r.otm_pct, 1)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-blue-600">
                  {fmtPct(r.max_return_pct, 1)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500 text-xs">
                  {fmt(r.breakeven, 2)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                  {fmtPct(r.iv_pct, 1)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                  {fmtPct(r.hv_30_pct, 1)}
                </td>
                <td className="px-3 py-2 text-right">
                  <IvHvBadge ratio={r.iv_hv_ratio} />
                </td>

                {/* Theta */}
                <td className="px-3 py-2 text-right tabular-nums text-gray-500 text-xs">
                  {r.theta != null ? fmt(r.theta, 2) : '—'}
                </td>

                {/* Liquidity */}
                <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                  {fmtVol(r.open_interest)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                  {fmtVol(r.volume)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const FILTERS_KEY = 'scanner-filters-v1'

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (!raw) return DEFAULT_FILTERS
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_FILTERS
  }
}

export default function Scanner() {
  const [filters, setFilters] = useState<Filters>(loadFilters)
  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
  }, [filters])

  // Results-section filters (not persisted, not sent to scan)
  const [resultRatings, setResultRatings] = useState<Set<string>>(new Set())
  const [resultMinScore, setResultMinScore] = useState(0)

  const toggleRating = (r: string) => {
    if (r === '__all__') { setResultRatings(new Set()); return }
    setResultRatings(prev => {
      const next = new Set(prev)
      if (next.has(r)) next.delete(r); else next.add(r)
      return next
    })
  }

  const [jobId, setJobId] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: meta } = useQuery({
    queryKey: ['scanner-meta'],
    queryFn:  getScannerMeta,
    refetchInterval: 30_000,
  })

  // Poll job status while a scan is running
  const { data: jobStatus } = useQuery({
    queryKey: ['scanner-job', jobId],
    queryFn:  () => getPriceJob(jobId!),
    enabled:  !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'running' ? 3000 : false
    },
  })

  const [lastJobResult, setLastJobResult] = useState<{ opportunities: number; tickers_scanned: number } | null>(null)

  // React to job completion
  useEffect(() => {
    if (!jobStatus) return
    if (jobStatus.status === 'done' || jobStatus.status === 'error') {
      qc.invalidateQueries({ queryKey: ['scanner-meta'] })
      qc.invalidateQueries({ queryKey: ['scanner-results'] })
      if (jobStatus.status === 'done') {
        const result = (jobStatus as { result?: { opportunities?: number; tickers_scanned?: number } }).result
        if (result) setLastJobResult({ opportunities: result.opportunities ?? 0, tickers_scanned: result.tickers_scanned ?? 0 })
        setJobId(null)
      }
    }
  }, [jobStatus?.status])

  const isScanning = jobStatus?.status === 'running' || false

  const scanMut = useMutation({
    mutationFn: triggerScan,
    onSuccess: d => {
      if (d.job_id) setJobId(d.job_id)
    },
  })

  // Query params → backend filters
  const queryParams = {
    min_yield:    filters.minYield > 0 ? filters.minYield : undefined,
    max_otm:      filters.maxOtm < 25 ? filters.maxOtm : undefined,
    min_oi:       filters.minOi > 0 ? filters.minOi : undefined,
    min_dte:      filters.minDte > 0 ? filters.minDte : undefined,
    max_dte:      filters.maxDte < 999 ? filters.maxDte : undefined,
    in_portfolio: filters.inPortfolioOnly || undefined,
    limit: 1000,
  }

  const { data: rawResults = [], isLoading } = useQuery({
    queryKey: ['scanner-results', queryParams],
    queryFn:  () => getScannerResults(queryParams),
    enabled:  meta?.available === true,
  })

  // Client-side filters: ticker search, delta range, option vol, stock vol, results-section filters
  const results = useMemo(() => {
    let rows = rawResults
    if (filters.search) rows = rows.filter(r => r.ticker.includes(filters.search))
    if (filters.minDelta > 0 || filters.maxDelta < 1) {
      rows = rows.filter(r => {
        if (r.delta == null) return true
        const abs = Math.abs(r.delta)
        return abs >= filters.minDelta && abs <= filters.maxDelta
      })
    }
    if (filters.minOptionVol > 0) {
      rows = rows.filter(r => (r.volume ?? 0) >= filters.minOptionVol)
    }
    if (filters.minStockVol > 0) {
      rows = rows.filter(r => (r.avg_stock_volume ?? 0) >= filters.minStockVol)
    }
    if (resultRatings.size > 0) {
      rows = rows.filter(r => r.recommendation != null && resultRatings.has(r.recommendation))
    }
    if (resultMinScore > 0) {
      rows = rows.filter(r => (r.score ?? 0) >= resultMinScore)
    }
    return rows
  }, [rawResults, filters.search, filters.minDelta, filters.maxDelta, filters.minOptionVol, filters.minStockVol, resultRatings, resultMinScore])

  // Scan params sent to backend when Run Scan is pressed
  const scanParams = {
    min_avg_stock_vol: filters.minStockVol,
    min_option_oi:     filters.minOi,
    min_option_vol:    filters.minOptionVol,
    min_dte:           filters.minDte,
    max_dte:           filters.maxDte,
    min_otm_pct:       0.5,
    max_otm_pct:       filters.maxOtm,
    min_div_yield:     filters.minDivYield,
    min_rating:        filters.minRating,
  }

  const lastScanned = meta?.scanned_at
    ? new Date(meta.scanned_at + 'Z').toLocaleString()
    : null

  const liveDataActive = meta?.ibkr_connected === true

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Covered Call Scanner</h1>
          {lastScanned && (
            <p className="text-xs text-gray-400 mt-0.5">
              Last scan: {lastScanned} · {meta?.tickers} tickers · {meta?.total_rows?.toLocaleString()} opportunities
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 ml-auto">
          {/* Gateway status */}
          {meta?.ibkr_available && (
            <div
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border ${
                meta.ibkr_connected
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : meta.gateway_running
                  ? 'bg-amber-50 border-amber-200 text-amber-700'
                  : 'bg-gray-50 border-gray-200 text-gray-400'
              }`}
              title={
                meta.ibkr_connected
                  ? 'IB Gateway connected — scanner uses live Greeks'
                  : meta.gateway_running
                  ? 'IB Gateway running but not connected'
                  : 'IB Gateway not running — scanner uses yfinance (delayed ~15 min)'
              }
            >
              {meta.ibkr_connected || meta.gateway_running
                ? <Wifi className="h-3.5 w-3.5" />
                : <WifiOff className="h-3.5 w-3.5" />}
              <span className="font-medium">
                {meta.ibkr_connected
                  ? 'Live Greeks'
                  : meta.gateway_running
                  ? 'IB Gateway running'
                  : 'IB Gateway offline'}
              </span>
              {!meta.ibkr_connected && (
                <span className="text-gray-400">· delayed data</span>
              )}
            </div>
          )}

          <button
            onClick={() => scanMut.mutate(scanParams)}
            disabled={isScanning || scanMut.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 shadow-sm"
          >
            {isScanning
              ? <RefreshCw className="h-4 w-4 animate-spin" />
              : <Play className="h-4 w-4" />}
            {isScanning ? 'Scanning…' : 'Run Scan'}
          </button>
        </div>
      </div>

      {/* Scan status */}
      {isScanning && (
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-700">
          <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
          {liveDataActive
            ? 'Fetching live Greeks from IB Gateway across all tickers — this takes 3–8 minutes…'
            : 'Scanning option chains across all tickers — this takes 2–5 minutes…'}
        </div>
      )}
      {jobStatus?.status === 'error' && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          Scan failed: {(jobStatus as { error?: string }).error ?? 'Unknown error'}
        </div>
      )}
      {lastJobResult !== null && lastJobResult.opportunities === 0 && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-medium">Scan completed — 0 opportunities found</span> across {lastJobResult.tickers_scanned} tickers.
            <span className="block text-xs text-amber-600 mt-0.5">
              Yahoo Finance returns zero bid/ask prices for options outside US market hours (9:30am–4:00pm Eastern).
              Connect IB Gateway for live after-hours data, or run the scan during/shortly after market close.
            </span>
          </div>
        </div>
      )}

      {/* Collapsible top section: watchlist + how-to */}
      <CollapsibleSection label="Watchlist & Setup" defaultOpen={true}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-1">
            <WatchlistPanel />
          </div>
          <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-2.5 text-sm text-gray-600">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2">
              How the scanner works
              {liveDataActive && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-normal">
                  <Zap className="h-3 w-3" /> Live Greeks active
                </span>
              )}
            </h2>
            <ul className="space-y-1.5 text-xs text-gray-500 list-disc list-inside">
              <li>Scans your <strong>portfolio holdings</strong> plus your <strong>watchlist</strong> for covered-call opportunities.</li>
              {liveDataActive
                ? <li>Connected to <strong>IB Gateway</strong> — fetches real-time option chains with actual <strong>Greeks (Δ, Γ, Θ, V)</strong> and live bid/ask prices.</li>
                : <li>Fetches option chains from <strong>Yahoo Finance</strong> (~15 min delayed). Connect IB Gateway for live Greeks.</li>
              }
              <li>Your filter settings are used as <strong>pre-scan thresholds</strong> — the scanner only fetches options matching your DTE, OTM, OI, volume and dividend yield minimums.</li>
              <li><strong>Score</strong> (higher = better): CC yield × delta quality × IV richness × DTE sweet-spot × liquidity × spread quality. Hover the <Info className="h-3 w-3 inline" /> on the Score column for the full breakdown.</li>
              <li><strong>Delta 0.20–0.30</strong> is the covered-call sweet spot — meaningful premium with ~70–80% chance of expiring worthless. For yfinance results delta is estimated via Black-Scholes.</li>
              <li><strong>Yes, highest score = best trade to consider first.</strong> Rating (Best/Good/Fair/Avoid) combines score and delta tier.</li>
            </ul>
          </div>
        </div>
      </CollapsibleSection>

      {/* Collapsible filter bar */}
      <CollapsibleSection label="Scan Filters" defaultOpen={true} compact>
        <FilterBar filters={filters} onChange={setFilters} />
      </CollapsibleSection>

      {/* No scan yet */}
      {!meta?.available && !isScanning && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400 space-y-3">
          <Play className="h-10 w-10 text-gray-200" />
          <p className="text-sm font-medium">No scan results yet</p>
          <p className="text-xs">Add tickers to your watchlist then click <strong>Run Scan</strong> to find covered-call opportunities.</p>
        </div>
      )}

      {/* Results */}
      {meta?.available && (
        <div className="space-y-3">
          <ResultsFilterBar
            activeRatings={resultRatings}
            minScore={resultMinScore}
            onToggleRating={toggleRating}
            onMinScore={setResultMinScore}
          />
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>
              Showing <strong className="text-gray-600">{results.length.toLocaleString()}</strong> opportunities
              {filters.search && ` matching "${filters.search}"`}
            </span>
            <span className="text-gray-300">Sorted by score descending by default · click any column to re-sort</span>
          </div>

          {isLoading
            ? <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-7 w-7 border-b-2 border-blue-600" /></div>
            : <ResultsTable rows={results} />}
        </div>
      )}
    </div>
  )
}
