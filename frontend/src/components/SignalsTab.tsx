import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getConsolidatedPositions, getBulkFundamentalsSignals } from '../api/client'
import type { SecuritySignals } from '../api/client'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'

// ─── Formatting helpers ───────────────────────────────────────────────────────

/** Returns already-percentage value as "±N.NN%" */
function fmtReturn(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%'
}

function fmtVol(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toFixed(1) + '%'
}

function fmtRsi(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toFixed(1)
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc'

function sortRows<T>(rows: T[], col: keyof T | null, dir: SortDir): T[] {
  if (!col) return rows
  return [...rows].sort((a, b) => {
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

// ─── Row shape ────────────────────────────────────────────────────────────────

interface Row {
  security_id: number
  ticker: string
  name: string | null
  weight_pct: number | null
  // Trend
  price_vs_50d: number | null
  price_vs_200d: number | null
  golden_cross: boolean | null
  // Momentum
  return_1m: number | null
  return_3m: number | null
  return_6m: number | null
  return_12m: number | null
  momentum_12_1: number | null
  // Oscillators
  rsi_14: number | null
  // Volatility
  volatility_20d: number | null
  volatility_60d: number | null
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function returnColor(n: number | null): string {
  if (n == null) return ''
  return n > 0 ? 'text-emerald-600' : 'text-red-500'
}

function vsMAColor(n: number | null): string {
  if (n == null) return ''
  return n > 0 ? 'text-emerald-600' : 'text-red-500'
}

function rsiColor(n: number | null): string {
  if (n == null) return ''
  if (n >= 70) return 'text-red-500'
  if (n <= 30) return 'text-emerald-600'
  return 'text-gray-700'
}

function volColor(n: number | null): string {
  if (n == null) return ''
  if (n < 15) return 'text-emerald-600'
  if (n < 30) return 'text-amber-600'
  return 'text-red-500'
}

// ─── Column definitions ───────────────────────────────────────────────────────

interface ColDef {
  key: keyof Row
  label: string
  group: string
  render: (row: Row) => string | JSX.Element
  align?: 'left' | 'right' | 'center'
  colorFn?: (row: Row) => string
}

const COLUMNS: ColDef[] = [
  { key: 'ticker',        group: '',           label: 'Ticker',       render: r => r.ticker,                   align: 'left' },
  { key: 'weight_pct',    group: '',           label: 'Weight',       render: r => r.weight_pct != null ? r.weight_pct.toFixed(1) + '%' : '—', align: 'right' },
  // Trend
  { key: 'price_vs_50d',  group: 'Trend',      label: 'vs 50d MA',    render: r => fmtReturn(r.price_vs_50d),  align: 'right', colorFn: r => vsMAColor(r.price_vs_50d) },
  { key: 'price_vs_200d', group: 'Trend',      label: 'vs 200d MA',   render: r => fmtReturn(r.price_vs_200d), align: 'right', colorFn: r => vsMAColor(r.price_vs_200d) },
  {
    key: 'golden_cross', group: 'Trend', label: 'Golden Cross', align: 'center',
    render: r => {
      if (r.golden_cross == null) return '—'
      return r.golden_cross
        ? <span className="inline-block px-1.5 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700">✓ GX</span>
        : <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-400">DC</span>
    },
    colorFn: _ => '',
  },
  // Momentum
  { key: 'return_1m',     group: 'Momentum',   label: '1M Return',    render: r => fmtReturn(r.return_1m),     align: 'right', colorFn: r => returnColor(r.return_1m) },
  { key: 'return_3m',     group: 'Momentum',   label: '3M Return',    render: r => fmtReturn(r.return_3m),     align: 'right', colorFn: r => returnColor(r.return_3m) },
  { key: 'return_6m',     group: 'Momentum',   label: '6M Return',    render: r => fmtReturn(r.return_6m),     align: 'right', colorFn: r => returnColor(r.return_6m) },
  { key: 'return_12m',    group: 'Momentum',   label: '12M Return',   render: r => fmtReturn(r.return_12m),    align: 'right', colorFn: r => returnColor(r.return_12m) },
  { key: 'momentum_12_1', group: 'Momentum',   label: '12-1 Mom',     render: r => fmtReturn(r.momentum_12_1), align: 'right', colorFn: r => returnColor(r.momentum_12_1) },
  // Oscillators
  {
    key: 'rsi_14', group: 'Oscillators', label: 'RSI 14', align: 'right',
    render: r => {
      if (r.rsi_14 == null) return '—'
      const label = r.rsi_14 >= 70 ? ' OB' : r.rsi_14 <= 30 ? ' OS' : ''
      return fmtRsi(r.rsi_14) + label
    },
    colorFn: r => rsiColor(r.rsi_14),
  },
  // Volatility
  { key: 'volatility_20d', group: 'Volatility', label: '20d Vol',      render: r => fmtVol(r.volatility_20d),  align: 'right', colorFn: r => volColor(r.volatility_20d) },
  { key: 'volatility_60d', group: 'Volatility', label: '60d Vol',      render: r => fmtVol(r.volatility_60d),  align: 'right', colorFn: r => volColor(r.volatility_60d) },
]

// ─── Group spans & colours ────────────────────────────────────────────────────

const GROUP_STYLE: Record<string, { bg: string; text: string }> = {
  'Trend':       { bg: 'bg-blue-100',   text: 'text-blue-700'   },
  'Momentum':    { bg: 'bg-emerald-100',text: 'text-emerald-700'},
  'Oscillators': { bg: 'bg-amber-100',  text: 'text-amber-700'  },
  'Volatility':  { bg: 'bg-rose-100',   text: 'text-rose-700'   },
}

function groupSpans() {
  const groups: { label: string; span: number }[] = []
  for (const col of COLUMNS) {
    const last = groups[groups.length - 1]
    if (last && last.label === col.group) {
      last.span++
    } else {
      groups.push({ label: col.group, span: 1 })
    }
  }
  return groups
}

// ─── Sort header cell ─────────────────────────────────────────────────────────

function SortTh({
  col, label, sortCol, sortDir, onSort, align = 'right',
}: {
  col: keyof Row; label: string; sortCol: keyof Row | null; sortDir: SortDir
  onSort: (c: keyof Row) => void; align?: 'left' | 'right' | 'center'
}) {
  const active = sortCol === col
  const Icon = active
    ? sortDir === 'asc' ? ChevronUp : ChevronDown
    : ChevronsUpDown
  const iconColor = active ? 'text-blue-500' : 'text-gray-300'
  return (
    <th
      className={`px-3 py-2 text-xs font-semibold text-gray-500 cursor-pointer select-none whitespace-nowrap hover:bg-gray-100 ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {align === 'right' && <Icon className={`h-3 w-3 ${iconColor}`} />}
        {label}
        {(align === 'left' || align === 'center') && <Icon className={`h-3 w-3 ${iconColor}`} />}
      </span>
    </th>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  accountIds: string | null | undefined
  asOf: string | undefined
}

export default function SignalsTab({ accountIds, asOf }: Props) {
  const [sortCol, setSortCol] = useState<keyof Row>('weight_pct')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const { data: consolidated = [], isLoading: posLoading } = useQuery({
    queryKey: ['consolidated-positions', accountIds, asOf],
    queryFn:  () => getConsolidatedPositions({ account_ids: accountIds ?? undefined, as_of: asOf }),
    enabled:  accountIds !== null,
  })

  const securityIds = useMemo(() =>
    consolidated
      .map(p => p.security_id)
      .filter((id): id is number => id != null),
    [consolidated]
  )

  const { data: bulk = {}, isLoading: bulkLoading } = useQuery({
    queryKey: ['bulk-fundamentals-signals', securityIds.join(',')],
    queryFn:  () => getBulkFundamentalsSignals(securityIds),
    enabled:  securityIds.length > 0,
    staleTime: 5 * 60_000,
  })

  const totalValue = useMemo(() =>
    consolidated.reduce((sum, p) => {
      const v = p.market_value_cad ? parseFloat(p.market_value_cad) : 0
      return sum + (isNaN(v) ? 0 : v)
    }, 0),
    [consolidated]
  )

  const rows = useMemo((): Row[] =>
    consolidated
      .filter(p => p.security_id != null)
      .map(p => {
        const mv = p.market_value_cad ? parseFloat(p.market_value_cad) : null
        const sig: SecuritySignals | null = bulk[String(p.security_id)]?.signals ?? null
        return {
          security_id:    p.security_id!,
          ticker:         p.ticker,
          name:           p.security_name,
          weight_pct:     mv != null && totalValue > 0 ? (mv / totalValue) * 100 : null,
          price_vs_50d:   sig?.price_vs_50d ?? null,
          price_vs_200d:  sig?.price_vs_200d ?? null,
          golden_cross:   sig?.golden_cross ?? null,
          return_1m:      sig?.return_1m ?? null,
          return_3m:      sig?.return_3m ?? null,
          return_6m:      sig?.return_6m ?? null,
          return_12m:     sig?.return_12m ?? null,
          momentum_12_1:  sig?.momentum_12_1 ?? null,
          rsi_14:         sig?.rsi_14 ?? null,
          volatility_20d: sig?.volatility_20d ?? null,
          volatility_60d: sig?.volatility_60d ?? null,
        }
      }),
    [consolidated, bulk, totalValue]
  )

  const sorted = useMemo(() => sortRows(rows, sortCol, sortDir), [rows, sortCol, sortDir])

  function handleSort(col: keyof Row) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('desc')
    }
  }

  const isLoading = posLoading || bulkLoading
  const spans = groupSpans()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (rows.length === 0) {
    return <p className="text-gray-400 text-sm py-8 text-center">No positions found.</p>
  }

  const coverageCount = rows.filter(r =>
    r.return_1m != null || r.rsi_14 != null || r.price_vs_50d != null
  ).length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs text-gray-400">
        <span>Signals available for {coverageCount} of {rows.length} positions.</span>
        <span className="flex items-center gap-2">
          <span className="text-emerald-600 font-medium">Green</span> = bullish ·
          <span className="text-red-500 font-medium"> Red</span> = bearish ·
          OB = Overbought · OS = Oversold · GX = Golden Cross · DC = Death Cross
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            {/* Group header row */}
            <tr className="border-b border-gray-200">
              {spans.map((g, i) => {
                const style = GROUP_STYLE[g.label]
                return (
                  <th
                    key={i}
                    colSpan={g.span}
                    className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-center border-r border-gray-100 last:border-r-0 ${style ? `${style.bg} ${style.text}` : 'bg-gray-50 text-gray-300'}`}
                  >
                    {g.label}
                  </th>
                )
              })}
            </tr>
            {/* Sort header row */}
            <tr className="border-b border-gray-200">
              {COLUMNS.map(col => (
                <SortTh
                  key={String(col.key)}
                  col={col.key}
                  label={col.label}
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  align={col.align}
                />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map(row => (
              <tr key={row.security_id} className="hover:bg-blue-50/30 transition-colors">
                {COLUMNS.map(col => {
                  const val = col.render(row)
                  const color = col.colorFn ? col.colorFn(row) : ''
                  const isStr = typeof val === 'string'
                  const isDash = val === '—'
                  return (
                    <td
                      key={String(col.key)}
                      className={`px-3 py-2 whitespace-nowrap ${col.align === 'left' ? 'text-left' : col.align === 'center' ? 'text-center' : 'text-right tabular-nums'} ${color || (isDash ? 'text-gray-300' : isStr ? 'text-gray-800' : '')}`}
                    >
                      {col.key === 'ticker'
                        ? <span className="font-semibold text-gray-900">{val}</span>
                        : val}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-300 text-right">
        Signals computed from historical price data. Options are excluded.
      </p>
    </div>
  )
}
