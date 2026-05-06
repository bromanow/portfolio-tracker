import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getConsolidatedPositions, getBulkFundamentalsSignals } from '../api/client'
import type { StoredFundamentals } from '../api/client'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

/** n is a ratio (0.0536 → "5.36%") */
function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return (n * 100).toFixed(decimals) + '%'
}

/** n is already a percentage (5.36 → "5.4%") */
function fmtPctRaw(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toFixed(decimals) + '%'
}

function fmtLarge(n: number | null | undefined): string {
  if (n == null) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T'
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  return n.toFixed(0)
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

// ─── Column definitions ───────────────────────────────────────────────────────

interface Row {
  security_id: number
  ticker: string
  name: string | null
  weight_pct: number | null
  market_value_cad: number | null
  // Valuation
  pe_ratio: number | null
  forward_pe: number | null
  peg_ratio: number | null
  price_to_book: number | null
  price_to_sales: number | null
  ev_to_ebitda: number | null
  // Per-share
  eps: number | null
  forward_eps: number | null
  // Income
  dividend_yield: number | null
  dividend_rate: number | null
  payout_ratio: number | null
  // Quality
  return_on_equity: number | null
  return_on_assets: number | null
  gross_margin: number | null
  operating_margin: number | null
  profit_margin: number | null
  // Risk
  beta: number | null
  debt_to_equity: number | null
  current_ratio: number | null
  // Analyst
  analyst_target_price: number | null
  analyst_recommendation: string | null
  analyst_count: number | null
}

interface ColDef {
  key: keyof Row
  label: string
  group: string
  render: (row: Row) => string
  align?: 'left' | 'right'
  colorFn?: (row: Row) => string
}

function recColor(rec: string | null): string {
  if (!rec) return ''
  const r = rec.toLowerCase()
  if (r.includes('strong buy') || r === 'buy') return 'text-emerald-600'
  if (r.includes('hold') || r.includes('neutral')) return 'text-amber-600'
  if (r.includes('sell') || r.includes('underperform')) return 'text-red-500'
  return 'text-gray-700'
}

function marginColor(n: number | null): string {
  if (n == null) return ''
  if (n > 0.15) return 'text-emerald-600'
  if (n > 0.05) return 'text-amber-600'
  return 'text-red-500'
}

function roeColor(n: number | null): string {
  if (n == null) return ''
  if (n > 0.15) return 'text-emerald-600'
  if (n > 0.05) return 'text-amber-600'
  return 'text-red-500'
}

const COLUMNS: ColDef[] = [
  // Identity
  { key: 'ticker',       group: '',          label: 'Ticker',       render: r => r.ticker,                           align: 'left' },
  { key: 'weight_pct',   group: '',          label: 'Weight',       render: r => fmtPctRaw(r.weight_pct, 1),         align: 'right' },
  // Valuation
  { key: 'pe_ratio',     group: 'Valuation', label: 'P/E',          render: r => fmt(r.pe_ratio, 1),                 align: 'right' },
  { key: 'forward_pe',   group: 'Valuation', label: 'Fwd P/E',      render: r => fmt(r.forward_pe, 1),               align: 'right' },
  { key: 'peg_ratio',    group: 'Valuation', label: 'PEG',          render: r => fmt(r.peg_ratio, 2),                align: 'right' },
  { key: 'price_to_book',group: 'Valuation', label: 'P/B',          render: r => fmt(r.price_to_book, 2),            align: 'right' },
  { key: 'price_to_sales',group:'Valuation', label: 'P/S',          render: r => fmt(r.price_to_sales, 2),           align: 'right' },
  { key: 'ev_to_ebitda', group: 'Valuation', label: 'EV/EBITDA',   render: r => fmt(r.ev_to_ebitda, 1),             align: 'right' },
  // Per-share
  { key: 'eps',          group: 'Per-Share', label: 'EPS',          render: r => fmt(r.eps, 2),                      align: 'right' },
  { key: 'forward_eps',  group: 'Per-Share', label: 'Fwd EPS',      render: r => fmt(r.forward_eps, 2),              align: 'right' },
  // Income
  // dividend_yield stored as percentage already (e.g. 7.82 = 7.82%), NOT a ratio
  { key: 'dividend_yield',group:'Income',    label: 'Div Yield',    render: r => fmtPctRaw(r.dividend_yield, 2),     align: 'right',
    colorFn: r => r.dividend_yield != null && r.dividend_yield > 0 ? 'text-emerald-700' : '' },
  { key: 'dividend_rate', group: 'Income',   label: 'Div Rate',     render: r => r.dividend_rate != null ? '$' + fmt(r.dividend_rate, 2) : '—', align: 'right' },
  { key: 'payout_ratio',  group: 'Income',   label: 'Payout',       render: r => fmtPct(r.payout_ratio, 1),         align: 'right' },
  // Quality
  { key: 'return_on_equity', group: 'Quality', label: 'ROE',        render: r => fmtPct(r.return_on_equity, 1),     align: 'right', colorFn: r => roeColor(r.return_on_equity) },
  { key: 'return_on_assets', group: 'Quality', label: 'ROA',        render: r => fmtPct(r.return_on_assets, 1),     align: 'right', colorFn: r => roeColor(r.return_on_assets) },
  { key: 'gross_margin',     group: 'Quality', label: 'Gross Mgn',  render: r => fmtPct(r.gross_margin, 1),         align: 'right', colorFn: r => marginColor(r.gross_margin) },
  { key: 'operating_margin', group: 'Quality', label: 'Op Mgn',     render: r => fmtPct(r.operating_margin, 1),     align: 'right', colorFn: r => marginColor(r.operating_margin) },
  { key: 'profit_margin',    group: 'Quality', label: 'Net Mgn',    render: r => fmtPct(r.profit_margin, 1),        align: 'right', colorFn: r => marginColor(r.profit_margin) },
  // Risk
  { key: 'beta',         group: 'Risk',      label: 'Beta',         render: r => fmt(r.beta, 2),                     align: 'right',
    colorFn: r => r.beta == null ? '' : r.beta < 0.8 ? 'text-emerald-600' : r.beta < 1.3 ? 'text-blue-600' : 'text-red-500' },
  { key: 'debt_to_equity',   group: 'Risk',  label: 'D/E',          render: r => fmt(r.debt_to_equity, 2),          align: 'right' },
  { key: 'current_ratio',    group: 'Risk',  label: 'Curr. Ratio',  render: r => fmt(r.current_ratio, 2),           align: 'right' },
  // Analyst
  { key: 'analyst_target_price', group: 'Analyst', label: 'Target', render: r => r.analyst_target_price != null ? '$' + fmt(r.analyst_target_price, 2) : '—', align: 'right' },
  { key: 'analyst_recommendation', group: 'Analyst', label: 'Rating', render: r => r.analyst_recommendation ?? '—', align: 'left',
    colorFn: r => recColor(r.analyst_recommendation) },
  { key: 'analyst_count', group: 'Analyst', label: '# Analysts',   render: r => r.analyst_count != null ? String(r.analyst_count) : '—', align: 'right' },
]

// ─── Sort header cell ─────────────────────────────────────────────────────────

function SortTh({
  col, label, sortCol, sortDir, onSort, align = 'right',
}: {
  col: keyof Row; label: string; sortCol: keyof Row | null; sortDir: SortDir
  onSort: (c: keyof Row) => void; align?: 'left' | 'right'
}) {
  const active = sortCol === col
  return (
    <th
      className={`px-3 py-2 text-xs font-semibold text-gray-500 cursor-pointer select-none whitespace-nowrap hover:bg-gray-100 ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {align === 'right' && (active
          ? sortDir === 'asc' ? <ChevronUp className="h-3 w-3 text-blue-500" /> : <ChevronDown className="h-3 w-3 text-blue-500" />
          : <ChevronsUpDown className="h-3 w-3 text-gray-300" />)}
        {label}
        {align === 'left' && (active
          ? sortDir === 'asc' ? <ChevronUp className="h-3 w-3 text-blue-500" /> : <ChevronDown className="h-3 w-3 text-blue-500" />
          : <ChevronsUpDown className="h-3 w-3 text-gray-300" />)}
      </span>
    </th>
  )
}

// ─── Column group header spans & colours ─────────────────────────────────────

const GROUP_STYLE: Record<string, { bg: string; text: string }> = {
  'Valuation': { bg: 'bg-blue-100',   text: 'text-blue-700'   },
  'Per-Share': { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  'Income':    { bg: 'bg-emerald-100',text: 'text-emerald-700'},
  'Quality':   { bg: 'bg-amber-100',  text: 'text-amber-700'  },
  'Risk':      { bg: 'bg-rose-100',   text: 'text-rose-700'   },
  'Analyst':   { bg: 'bg-purple-100', text: 'text-purple-700' },
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

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  accountIds: string | null | undefined
  asOf: string | undefined
}

export default function FundamentalsTab({ accountIds, asOf }: Props) {
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

  // Compute total portfolio value for weight calculation
  const totalValue = useMemo(() =>
    consolidated.reduce((sum, p) => {
      const v = p.market_value_cad ? parseFloat(p.market_value_cad) : 0
      return sum + (isNaN(v) ? 0 : v)
    }, 0),
    [consolidated]
  )

  const rows = useMemo((): Row[] => {
    return consolidated
      .filter(p => p.security_id != null)
      .map(p => {
        const mv = p.market_value_cad ? parseFloat(p.market_value_cad) : null
        const funds: StoredFundamentals | null = bulk[String(p.security_id)]?.fundamentals ?? null
        return {
          security_id:          p.security_id!,
          ticker:               p.ticker,
          name:                 p.security_name,
          weight_pct:           mv != null && totalValue > 0 ? (mv / totalValue) * 100 : null,
          market_value_cad:     mv,
          pe_ratio:             funds?.pe_ratio ?? null,
          forward_pe:           funds?.forward_pe ?? null,
          peg_ratio:            funds?.peg_ratio ?? null,
          price_to_book:        funds?.price_to_book ?? null,
          price_to_sales:       funds?.price_to_sales ?? null,
          ev_to_ebitda:         funds?.ev_to_ebitda ?? null,
          eps:                  funds?.eps ?? null,
          forward_eps:          funds?.forward_eps ?? null,
          dividend_yield:       funds?.dividend_yield ?? null,
          dividend_rate:        funds?.dividend_rate ?? null,
          payout_ratio:         funds?.payout_ratio ?? null,
          return_on_equity:     funds?.return_on_equity ?? null,
          return_on_assets:     funds?.return_on_assets ?? null,
          gross_margin:         funds?.gross_margin ?? null,
          operating_margin:     funds?.operating_margin ?? null,
          profit_margin:        funds?.profit_margin ?? null,
          beta:                 funds?.beta ?? null,
          debt_to_equity:       funds?.debt_to_equity ?? null,
          current_ratio:        funds?.current_ratio ?? null,
          analyst_target_price: funds?.analyst_target_price ?? null,
          analyst_recommendation: funds?.analyst_recommendation ?? null,
          analyst_count:        funds?.analyst_count ?? null,
        }
      })
  }, [consolidated, bulk, totalValue])

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

  const coverageCount = rows.filter(r => r.pe_ratio != null || r.dividend_yield != null || r.beta != null).length

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        Fundamentals available for {coverageCount} of {rows.length} positions.
        Use <strong>Refresh Fundamentals</strong> in the Risk Scoring panel to update.
      </p>
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
                  return (
                    <td
                      key={String(col.key)}
                      className={`px-3 py-2 whitespace-nowrap ${col.align === 'left' ? 'text-left' : 'text-right tabular-nums'} ${color || (val === '—' ? 'text-gray-300' : 'text-gray-800')}`}
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
        Large cap/financials: D/E &gt; 100 is normal. Options excluded from fundamental data.
      </p>
    </div>
  )
}
