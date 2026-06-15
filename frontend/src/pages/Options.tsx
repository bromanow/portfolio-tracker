import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getOptionsReport, getAccounts, setManualPrice, clearManualPrice, expireOption, getOptionsLive } from '../api/client'
import type { OptionPosition, OptionIncomeRow, Account } from '../api/client'
import { parseOptionTicker } from '../utils/optionFormat'
import { ChevronUp, ChevronDown, ChevronsUpDown, Pencil, Check, X, Trash2 } from 'lucide-react'
import MultiSelectDropdown from '../components/MultiSelectDropdown'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'

function fmtCAD(val: string | number | null | undefined) {
  if (val === null || val === undefined) return '—'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return '—'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function pnlClass(val: string | number | null | undefined) {
  if (!val) return 'text-gray-400'
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (n > 0) return 'text-emerald-600'
  if (n < 0) return 'text-red-500'
  return 'text-gray-500'
}

function DteBadge({ dte }: { dte: number | null }) {
  if (dte === null) return <span className="text-gray-400">—</span>
  const cls = dte < 0 ? 'bg-red-100 text-red-700'
    : dte < 14 ? 'bg-orange-100 text-orange-700'
    : dte < 30 ? 'bg-yellow-100 text-yellow-700'
    : 'bg-green-100 text-green-700'
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{dte < 0 ? 'Expired' : `${dte}d`}</span>
}

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return null
  const isCall = type === 'CALL'
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${isCall ? 'bg-blue-100 text-blue-700' : 'bg-pink-100 text-pink-700'}`}>
      {type}
    </span>
  )
}

function DirectionBadge({ direction }: { direction: 'LONG' | 'SHORT' }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${direction === 'SHORT' ? 'bg-orange-100 text-orange-700' : 'bg-teal-100 text-teal-700'}`}>
      {direction}
    </span>
  )
}

function MoneynessTag({ itm, moneyness, optionType }: { itm: boolean | null; moneyness: number | null; optionType: string | null }) {
  if (itm === null) return null
  const label = itm ? 'ITM' : 'OTM'
  const cls = itm ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
  const delta = moneyness !== null ? ` ${moneyness >= 0 ? '+' : ''}${moneyness.toFixed(2)}` : ''
  return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>{label}{delta}</span>
}

function CcyBadge({ currency }: { currency: string | null | undefined }) {
  if (!currency) return null
  const isUSD = currency.toUpperCase() === 'USD'
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${isUSD ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
      {currency.toUpperCase()}
    </span>
  )
}

function closeTypeLabel(t: string | null) {
  if (!t) return '—'
  return { OPTION_EXPIRY: 'Expired', OPTION_ASSIGNMENT: 'Assigned', OPTION_SELL: 'Closed', OPTION_BUY: 'Bought back' }[t] ?? t
}

type SortDir = 'asc' | 'desc'
type SortState<T extends string> = { col: T; dir: SortDir }

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="inline ml-0.5 h-3 w-3 text-gray-300" />
  return dir === 'asc'
    ? <ChevronUp className="inline ml-0.5 h-3 w-3 text-blue-500" />
    : <ChevronDown className="inline ml-0.5 h-3 w-3 text-blue-500" />
}

function SortTh<T extends string>({
  col, sort, onSort, children, className,
}: { col: T; sort: SortState<T>; onSort: (c: T) => void; children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 cursor-pointer select-none hover:bg-gray-100 transition-colors ${className ?? ''}`}
      onClick={() => onSort(col)}
    >
      {children}
      <SortIcon active={sort.col === col} dir={sort.dir} />
    </th>
  )
}

function ManualPriceCell({
  position,
  onSaved,
}: {
  position: OptionPosition
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const qc = useQueryClient()

  const mut = useMutation({
    mutationFn: () => {
      const price = parseFloat(value)
      if (isNaN(price) || price <= 0) throw new Error('Invalid price')
      return setManualPrice(position.security_id, price, tradingCurrency)
    },
    onSuccess: () => {
      setEditing(false)
      setValue('')
      qc.invalidateQueries({ queryKey: ['options-report'] })
      onSaved()
    },
  })

  const clearMut = useMutation({
    mutationFn: () => clearManualPrice(position.security_id),
    onSuccess: () => {
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['options-report'] })
      onSaved()
    },
  })

  const tradingCurrency = position.price_currency ?? position.currency ?? 'CAD'
  const isUSD = tradingCurrency.toUpperCase() === 'USD'

  if (!editing) {
    return (
      <div className="flex items-center justify-end gap-1 group">
        {position.current_price_cad ? (
          <div className="text-right">
            <span className="font-semibold">{fmtCAD(position.current_price_cad)}</span>
            {isUSD && position.current_price && (
              <span className="text-xs text-gray-400 ml-1">US${parseFloat(position.current_price).toFixed(2)}</span>
            )}
          </div>
        ) : (
          <span className="text-gray-300 text-xs">no price</span>
        )}
        <button
          onClick={() => { setValue(position.current_price ?? ''); setEditing(true) }}
          className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 text-gray-400 hover:text-blue-500"
          title="Enter price manually"
        >
          <Pencil className="h-3 w-3" />
        </button>
        {position.price_source === 'manual' && (
          <button
            onClick={() => clearMut.mutate()}
            disabled={clearMut.isPending}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-500 disabled:opacity-30"
            title="Remove manual override — next refresh will auto-fetch price">
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <span className="text-xs text-gray-400">{tradingCurrency}</span>
      <input
        autoFocus
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') mut.mutate(); if (e.key === 'Escape') setEditing(false) }}
        className="w-20 border border-blue-400 rounded px-1.5 py-0.5 text-sm text-right focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
      <button onClick={() => mut.mutate()} disabled={mut.isPending} className="text-emerald-600 hover:text-emerald-700 disabled:opacity-50">
        <Check className="h-3.5 w-3.5" />
      </button>
      <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-600">
        <X className="h-3.5 w-3.5" />
      </button>
      {position.price_source === 'manual' && (
        <button
          onClick={() => clearMut.mutate()}
          disabled={clearMut.isPending}
          className="text-red-400 hover:text-red-600 disabled:opacity-30 ml-1"
          title="Remove manual override">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function useSortTable<T extends string>(defaultCol: T, defaultDir: SortDir = 'asc') {
  const [sort, setSort] = useState<SortState<T>>({ col: defaultCol, dir: defaultDir })
  const toggle = (col: T) =>
    setSort(prev => prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' })
  return { sort, toggle }
}

type PosCol = 'display' | 'underlying' | 'option_type' | 'strike' | 'expiry_date' | 'dte' | 'qty' | 'currency' | 'price' | 'mkt_val' | 'acb' | 'pnl' | 'account'
type IncCol = 'date' | 'display' | 'underlying' | 'option_type' | 'direction' | 'currency' | 'event' | 'qty' | 'proceeds' | 'cost' | 'gain'

function sortPositions(rows: OptionPosition[], sort: SortState<PosCol>): OptionPosition[] {
  return [...rows].sort((a, b) => {
    let va: any, vb: any
    switch (sort.col) {
      case 'display': { va = parseOptionTicker(a.ticker)?.display ?? a.ticker; vb = parseOptionTicker(b.ticker)?.display ?? b.ticker; break }
      case 'underlying': va = a.underlying_ticker ?? ''; vb = b.underlying_ticker ?? ''; break
      case 'option_type': va = a.option_type ?? ''; vb = b.option_type ?? ''; break
      case 'strike': va = a.strike ?? 0; vb = b.strike ?? 0; break
      case 'expiry_date': va = a.expiry_date ?? ''; vb = b.expiry_date ?? ''; break
      case 'dte': va = a.days_to_expiry ?? 9999; vb = b.days_to_expiry ?? 9999; break
      case 'qty': va = Math.abs(parseFloat(a.quantity ?? '0')); vb = Math.abs(parseFloat(b.quantity ?? '0')); break
      case 'currency': va = (a.price_currency ?? a.currency) ?? ''; vb = (b.price_currency ?? b.currency) ?? ''; break
      case 'price': va = parseFloat(a.current_price_cad ?? '0'); vb = parseFloat(b.current_price_cad ?? '0'); break
      case 'mkt_val': va = parseFloat(a.market_value_cad ?? '0'); vb = parseFloat(b.market_value_cad ?? '0'); break
      case 'acb': va = parseFloat(a.total_acb_cad ?? '0'); vb = parseFloat(b.total_acb_cad ?? '0'); break
      case 'pnl': va = parseFloat(a.unrealized_pnl_cad ?? '0'); vb = parseFloat(b.unrealized_pnl_cad ?? '0'); break
      case 'account': va = a.account_name ?? ''; vb = b.account_name ?? ''; break
      default: return 0
    }
    if (va < vb) return sort.dir === 'asc' ? -1 : 1
    if (va > vb) return sort.dir === 'asc' ? 1 : -1
    return 0
  })
}

function sortIncome(rows: OptionIncomeRow[], sort: SortState<IncCol>): OptionIncomeRow[] {
  return [...rows].sort((a, b) => {
    let va: any, vb: any
    switch (sort.col) {
      case 'date': va = a.date; vb = b.date; break
      case 'display': { va = parseOptionTicker(a.ticker)?.display ?? a.ticker; vb = parseOptionTicker(b.ticker)?.display ?? b.ticker; break }
      case 'underlying': va = a.underlying_ticker ?? ''; vb = b.underlying_ticker ?? ''; break
      case 'option_type': va = a.option_type ?? ''; vb = b.option_type ?? ''; break
      case 'direction': va = a.direction ?? 'LONG'; vb = b.direction ?? 'LONG'; break
      case 'currency': va = a.currency ?? ''; vb = b.currency ?? ''; break
      case 'event': va = a.close_type ?? ''; vb = b.close_type ?? ''; break
      case 'qty': va = Math.abs(parseFloat(a.quantity)); vb = Math.abs(parseFloat(b.quantity)); break
      case 'proceeds': va = parseFloat(a.proceeds_cad); vb = parseFloat(b.proceeds_cad); break
      case 'cost': va = parseFloat(a.acb_cad); vb = parseFloat(b.acb_cad); break
      case 'gain': va = parseFloat(a.gain_cad); vb = parseFloat(b.gain_cad); break
      default: return 0
    }
    if (va < vb) return sort.dir === 'asc' ? -1 : 1
    if (va > vb) return sort.dir === 'asc' ? 1 : -1
    return 0
  })
}

export default function Options() {
  const [incomeYear, setIncomeYear] = useState<string>('')

  // Income multi-select filters
  const [incFilterUnderlying, setIncFilterUnderlying] = useState<string[]>([])
  const [incFilterType, setIncFilterType] = useState<string[]>([])
  const [incFilterDir, setIncFilterDir] = useState<string[]>([])
  const [incFilterCcy, setIncFilterCcy] = useState<string[]>([])
  const [incFilterEvent, setIncFilterEvent] = useState<string[]>([])

  // Expire confirmation: tracks "accountId_securityId" of the position pending confirm
  const [expiringKey, setExpiringKey] = useState<string | null>(null)

  const posSort = useSortTable<PosCol>('expiry_date', 'asc')
  const incSort = useSortTable<IncCol>('date', 'desc')

  const qc = useQueryClient()
  const { data: rawAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const accounts = rawAccounts as Account[]
  const { histAccountIds, hasFilter } = usePortfolioFilters(accounts)

  // Always scope to user's accounts
  const accountIdsParam = histAccountIds ?? undefined

  const { data: report, isLoading } = useQuery({
    queryKey: ['options-report', accountIdsParam],
    queryFn: () => getOptionsReport({ account_ids: accountIdsParam }),
  })

  // Live bid/ask + greeks from IBeam (production-only). Fetched async so the table renders
  // immediately; cells fall back to "—" when IBeam is down. Cached server-side (60s).
  const { data: live, isFetching: liveFetching } = useQuery({
    queryKey: ['options-live'],
    queryFn: getOptionsLive,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const quotes = live?.quotes ?? {}

  const expireMut = useMutation({
    mutationFn: ({ accountId, securityId, expiryDate }: { accountId: number; securityId: number; expiryDate?: string }) =>
      expireOption(accountId, securityId, expiryDate),
    onSuccess: () => {
      setExpiringKey(null)
      qc.invalidateQueries({ queryKey: ['options-report'] })
    },
  })

  const openPositions = (report?.open_positions ?? []) as OptionPosition[]
  const incomeRows = (report?.income ?? []) as OptionIncomeRow[]
  const summary = report?.summary

  // Year chips
  const years = [...new Set(incomeRows.map(r => r.date.slice(0, 4)))].sort().reverse()

  // Filter option lists derived from all income rows (not filtered, so options don't disappear)
  const incUnderlyingOptions = useMemo(() =>
    [...new Set(incomeRows.map(r => r.underlying_ticker).filter(Boolean))].sort()
      .map(v => ({ value: v, label: v })),
    [incomeRows]
  )
  const incCcyOptions = useMemo(() =>
    [...new Set(incomeRows.map(r => r.currency).filter(Boolean))].sort()
      .map(v => ({ value: v!, label: v! })),
    [incomeRows]
  )
  const incTypeOptions = [{ value: 'CALL', label: 'Call' }, { value: 'PUT', label: 'Put' }]
  const incDirOptions = [{ value: 'LONG', label: 'Long' }, { value: 'SHORT', label: 'Short' }]
  const incEventOptions = [
    { value: 'OPTION_EXPIRY', label: 'Expired' },
    { value: 'OPTION_ASSIGNMENT', label: 'Assigned' },
    { value: 'OPTION_SELL', label: 'Closed' },
    { value: 'OPTION_BUY', label: 'Bought back' },
  ]

  const hasIncomeFilters = incFilterUnderlying.length > 0 || incFilterType.length > 0 || incFilterDir.length > 0 || incFilterCcy.length > 0 || incFilterEvent.length > 0

  const clearIncomeFilters = () => {
    setIncFilterUnderlying([])
    setIncFilterType([])
    setIncFilterDir([])
    setIncFilterCcy([])
    setIncFilterEvent([])
  }

  // Apply all income filters
  const filteredIncome = useMemo(() => {
    let rows = incomeYear ? incomeRows.filter(r => r.date.startsWith(incomeYear)) : incomeRows
    if (incFilterUnderlying.length) rows = rows.filter(r => incFilterUnderlying.includes(r.underlying_ticker))
    if (incFilterType.length) rows = rows.filter(r => r.option_type && incFilterType.includes(r.option_type))
    if (incFilterDir.length) rows = rows.filter(r => r.direction && incFilterDir.includes(r.direction))
    if (incFilterCcy.length) rows = rows.filter(r => r.currency != null && incFilterCcy.includes(r.currency))
    if (incFilterEvent.length) rows = rows.filter(r => r.close_type != null && incFilterEvent.includes(r.close_type))
    return rows
  }, [incomeRows, incomeYear, incFilterUnderlying, incFilterType, incFilterDir, incFilterCcy, incFilterEvent])

  // Income by year summary
  const incomeByYear = years.map(y => ({
    year: y,
    total: incomeRows.filter(r => r.date.startsWith(y)).reduce((s, r) => s + parseFloat(r.gain_cad), 0),
    count: incomeRows.filter(r => r.date.startsWith(y)).length,
  }))

  // Column totals for filtered income
  const totalProceeds = filteredIncome.reduce((s, r) => s + parseFloat(r.proceeds_cad), 0)
  const totalCost = filteredIncome.reduce((s, r) => s + parseFloat(r.acb_cad), 0)
  const totalGain = filteredIncome.reduce((s, r) => s + parseFloat(r.gain_cad), 0)

  const sortedPositions = useMemo(() => sortPositions(openPositions, posSort.sort), [openPositions, posSort.sort])
  const sortedIncome = useMemo(() => sortIncome(filteredIncome, incSort.sort), [filteredIncome, incSort.sort])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Options</h1>
      </div>

      {/* Summary bar */}
      {summary && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl px-6 py-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
            <div>
              <div className="text-xs text-purple-500 uppercase tracking-wide">Open Contracts</div>
              <div className="text-2xl font-bold text-purple-900">{summary.open_contracts}</div>
            </div>
            <div>
              <div className="text-xs text-purple-500 uppercase tracking-wide">Market Exposure</div>
              <div className="text-2xl font-bold text-purple-900">{fmtCAD(summary.total_exposure_cad)}</div>
            </div>
            <div>
              <div className="text-xs text-purple-500 uppercase tracking-wide">Unrealized P&L</div>
              <div className={`text-2xl font-bold ${pnlClass(summary.unrealized_pnl_cad)}`}>{fmtCAD(summary.unrealized_pnl_cad)}</div>
            </div>
            <div className="border-l border-purple-200 pl-10">
              <div className="text-xs text-purple-500 uppercase tracking-wide">Total Option Income</div>
              <div className={`text-2xl font-bold ${pnlClass(summary.total_income_cad)}`}>{fmtCAD(summary.total_income_cad)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Notice for expired positions needing a closing transaction */}
      {!isLoading && openPositions.some(p => (p.days_to_expiry ?? 0) < 0) && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          <span className="mt-0.5 text-red-500">⚠</span>
          <span>
            <strong>Missing expiry transactions:</strong> The options highlighted below expired within the last 30 days but have no closing transaction on record.
            Interactive Brokers does not always provide expiry transactions. Click <strong>Expire</strong> on each row to record the transaction and move them to income history.
          </span>
        </div>
      )}

      {/* Canadian options notice */}
      {!isLoading && openPositions.some(p => (p.price_currency ?? p.currency) === 'CAD' && !p.current_price_cad) && (
        <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-800">
          <span className="mt-0.5 text-blue-500">ℹ</span>
          <span>
            <strong>Canadian option pricing:</strong> Prices are fetched automatically from the Montreal Exchange (m-x.ca).
            If a price is still missing, use the pencil icon to enter it manually — manual prices are preserved across auto-refreshes
            and can be cleared with the trash icon to resume auto-fetching.
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-32"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600" /></div>
      ) : (
        <>
          {/* Open Positions */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-800">Open Positions ({openPositions.length})</h2>
            </div>
            {openPositions.length === 0 ? (
              <p className="px-5 py-8 text-center text-gray-400 text-sm">No open option positions</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm divide-y divide-gray-100">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <tr>
                      <SortTh col="display" sort={posSort.sort} onSort={posSort.toggle} className="text-left">Position</SortTh>
                      <SortTh col="underlying" sort={posSort.sort} onSort={posSort.toggle} className="text-left">Underlying</SortTh>
                      <SortTh col="option_type" sort={posSort.sort} onSort={posSort.toggle} className="text-center">Type</SortTh>
                      <SortTh col="strike" sort={posSort.sort} onSort={posSort.toggle} className="text-right">Strike</SortTh>
                      <th className="px-4 py-2.5 text-right text-xs text-gray-500 uppercase">Und. Price</th>
                      <SortTh col="expiry_date" sort={posSort.sort} onSort={posSort.toggle} className="text-center">Expiry</SortTh>
                      <SortTh col="dte" sort={posSort.sort} onSort={posSort.toggle} className="text-center">DTE</SortTh>
                      <SortTh col="qty" sort={posSort.sort} onSort={posSort.toggle} className="text-right">Qty</SortTh>
                      <SortTh col="currency" sort={posSort.sort} onSort={posSort.toggle} className="text-center">CCY</SortTh>
                      <SortTh col="price" sort={posSort.sort} onSort={posSort.toggle} className="text-right">Opt Price</SortTh>
                      <th className="px-4 py-2.5 text-right text-xs text-gray-500 uppercase whitespace-nowrap" title="Live bid / ask from IBKR (IBeam)">Bid / Ask</th>
                      <th className="px-4 py-2.5 text-right text-xs text-gray-500 uppercase" title="Implied volatility (IBKR)">IV</th>
                      <th className="px-4 py-2.5 text-center text-xs text-gray-500 uppercase whitespace-nowrap" title="Greeks from IBKR: delta / gamma / theta / vega">Greeks (Δ·Γ·Θ·V)</th>
                      <th className="px-4 py-2.5 text-right text-xs text-gray-500 uppercase whitespace-nowrap" title="Premium per contract: sold/contract for short, paid/contract for long">Prem/ct</th>
                      <SortTh col="mkt_val" sort={posSort.sort} onSort={posSort.toggle} className="text-right">Mkt Val</SortTh>
                      <SortTh col="acb" sort={posSort.sort} onSort={posSort.toggle} className="text-right">ACB</SortTh>
                      <SortTh col="pnl" sort={posSort.sort} onSort={posSort.toggle} className="text-right">P&L</SortTh>
                      <SortTh col="account" sort={posSort.sort} onSort={posSort.toggle} className="text-left">Account</SortTh>
                      <th className="px-4 py-2.5 text-center text-xs text-gray-500 uppercase">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 bg-white">
                    {sortedPositions.map((p, i) => {
                      const qty = parseFloat(p.quantity)
                      const isShort = qty < 0
                      const parsed = parseOptionTicker(p.ticker)
                      const direction: 'LONG' | 'SHORT' = isShort ? 'SHORT' : 'LONG'
                      const isExpired = (p.days_to_expiry ?? 1) < 0
                      const posKey = `${p.account_id}_${p.security_id}`
                      const isConfirming = expiringKey === posKey
                      return (
                        <tr key={i} className={`hover:bg-gray-50 ${isExpired ? 'bg-red-50/30' : ''}`}>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-medium text-gray-900">{parsed?.display ?? p.ticker}</span>
                              <DirectionBadge direction={direction} />
                            </div>
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="font-medium text-gray-700">{p.underlying_ticker ?? '—'}</span>
                            {p.underlying_position_qty != null && (() => {
                              const uQty = parseFloat(p.underlying_position_qty)
                              const optQty = Math.abs(parseFloat(p.quantity))
                              const covered = uQty >= optQty * 100
                              return (
                                <div className={`text-xs font-medium ${covered ? 'text-teal-600' : 'text-gray-400'}`}>
                                  {uQty.toFixed(0)} sh{covered ? ' ✓' : ''}
                                </div>
                              )
                            })()}
                          </td>
                          <td className="px-4 py-2.5 text-center"><TypeBadge type={p.option_type} /></td>
                          <td className="px-4 py-2.5 text-right font-mono text-sm">
                            <div>${p.strike?.toFixed(2) ?? '—'}</div>
                            <MoneynessTag itm={p.itm} moneyness={p.moneyness} optionType={p.option_type} />
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {p.underlying_price ? (
                              <span className="font-mono text-sm text-gray-800">
                                {p.underlying_price_currency === 'USD' ? 'US$' : '$'}{parseFloat(p.underlying_price).toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-gray-300 text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-center text-xs text-gray-600">{p.expiry_date ?? '—'}</td>
                          <td className="px-4 py-2.5 text-center"><DteBadge dte={p.days_to_expiry} /></td>
                          <td className={`px-4 py-2.5 text-right font-mono ${qty < 0 ? 'text-orange-600' : 'text-teal-600'}`}>{qty}</td>
                          <td className="px-4 py-2.5 text-center"><CcyBadge currency={p.price_currency ?? p.currency} /></td>
                          <td className="px-4 py-2.5">
                            <ManualPriceCell position={p} onSaved={() => {}} />
                          </td>
                          {(() => {
                            const q = quotes[String(p.security_id)]
                            const g = (v: number | null | undefined, d = 2) => (v == null ? <span className="text-gray-300">—</span> : v.toFixed(d))
                            const premPerCt = Math.abs(parseFloat(p.quantity)) > 0
                              ? Math.abs(parseFloat(p.total_acb_cad ?? '0')) / Math.abs(parseFloat(p.quantity))
                              : null
                            return (
                              <>
                                <td className="px-4 py-2.5 text-right font-mono text-xs whitespace-nowrap">
                                  {q && (q.bid != null || q.ask != null)
                                    ? <span className="text-gray-700">{q.bid != null ? q.bid.toFixed(2) : '—'} / {q.ask != null ? q.ask.toFixed(2) : '—'}</span>
                                    : <span className="text-gray-300">{liveFetching ? '…' : '—'}</span>}
                                </td>
                                <td className="px-4 py-2.5 text-right text-xs text-gray-600">{q?.iv_pct != null ? `${q.iv_pct.toFixed(1)}%` : <span className="text-gray-300">—</span>}</td>
                                <td className="px-4 py-2.5 text-center font-mono text-xs text-gray-600 whitespace-nowrap">
                                  {q ? <span>{g(q.delta)}·{g(q.gamma, 3)}·{g(q.theta)}·{g(q.vega)}</span> : <span className="text-gray-300">{liveFetching ? '…' : '—'}</span>}
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-600">{premPerCt != null ? fmtCAD(premPerCt) : <span className="text-gray-300">—</span>}</td>
                              </>
                            )
                          })()}
                          <td className="px-4 py-2.5 text-right font-semibold">{fmtCAD(p.market_value_cad)}</td>
                          <td className="px-4 py-2.5 text-right text-gray-600">{fmtCAD(p.total_acb_cad)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {p.unrealized_pnl_cad ? (
                              <span className={`font-medium ${pnlClass(p.unrealized_pnl_cad)}`}>
                                {fmtCAD(p.unrealized_pnl_cad)}
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-500">{p.account_name}</td>
                          <td className="px-4 py-2.5 text-center">
                            {isConfirming ? (
                              <div className="flex items-center gap-1 justify-center">
                                <button
                                  onClick={() => expireMut.mutate({ accountId: p.account_id, securityId: p.security_id, expiryDate: p.expiry_date ?? undefined })}
                                  disabled={expireMut.isPending}
                                  className="text-xs px-2 py-0.5 bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 whitespace-nowrap"
                                >
                                  Confirm
                                </button>
                                <button onClick={() => setExpiringKey(null)} className="text-gray-400 hover:text-gray-600">
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setExpiringKey(posKey)}
                                className={`text-xs px-2 py-0.5 rounded border whitespace-nowrap ${
                                  isExpired
                                    ? 'border-red-300 text-red-600 hover:bg-red-50 font-medium'
                                    : 'border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600'
                                }`}
                              >
                                Expire
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Income by Year chips */}
          {incomeByYear.length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-gray-500 font-medium">Option Income:</span>
              <button onClick={() => setIncomeYear('')}
                className={`px-3 py-1 rounded-full text-xs font-medium border ${!incomeYear ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`}>
                All ({incomeRows.length})
              </button>
              {incomeByYear.map(({ year, total, count }) => (
                <button key={year} onClick={() => setIncomeYear(year)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border ${incomeYear === year ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`}>
                  {year} · {fmtCAD(total)} ({count})
                </button>
              ))}
            </div>
          )}

          {/* Income History */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <h2 className="font-semibold text-gray-800">Option Income History ({filteredIncome.length} events)</h2>
                <div className="flex items-center gap-2 flex-wrap">
                  <MultiSelectDropdown
                    placeholder="Underlying"
                    options={incUnderlyingOptions}
                    selected={incFilterUnderlying}
                    onChange={setIncFilterUnderlying}
                  />
                  <MultiSelectDropdown
                    placeholder="Type"
                    options={incTypeOptions}
                    selected={incFilterType}
                    onChange={setIncFilterType}
                  />
                  <MultiSelectDropdown
                    placeholder="Direction"
                    options={incDirOptions}
                    selected={incFilterDir}
                    onChange={setIncFilterDir}
                  />
                  <MultiSelectDropdown
                    placeholder="Currency"
                    options={incCcyOptions}
                    selected={incFilterCcy}
                    onChange={setIncFilterCcy}
                  />
                  <MultiSelectDropdown
                    placeholder="Event"
                    options={incEventOptions}
                    selected={incFilterEvent}
                    onChange={setIncFilterEvent}
                  />
                  {hasIncomeFilters && (
                    <button
                      onClick={clearIncomeFilters}
                      className="text-xs text-gray-400 hover:text-gray-600 px-1"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
            {filteredIncome.length === 0 ? (
              <p className="px-5 py-8 text-center text-gray-400 text-sm">No option income events</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm divide-y divide-gray-100">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                    <tr>
                      <SortTh col="date" sort={incSort.sort} onSort={incSort.toggle} className="text-left">Date</SortTh>
                      <SortTh col="display" sort={incSort.sort} onSort={incSort.toggle} className="text-left">Position</SortTh>
                      <SortTh col="underlying" sort={incSort.sort} onSort={incSort.toggle} className="text-left">Underlying</SortTh>
                      <SortTh col="option_type" sort={incSort.sort} onSort={incSort.toggle} className="text-center">Type</SortTh>
                      <SortTh col="direction" sort={incSort.sort} onSort={incSort.toggle} className="text-center">Dir</SortTh>
                      <SortTh col="currency" sort={incSort.sort} onSort={incSort.toggle} className="text-center">CCY</SortTh>
                      <SortTh col="event" sort={incSort.sort} onSort={incSort.toggle} className="text-center">Event</SortTh>
                      <SortTh col="qty" sort={incSort.sort} onSort={incSort.toggle} className="text-right">Qty</SortTh>
                      <SortTh col="proceeds" sort={incSort.sort} onSort={incSort.toggle} className="text-right">Proceeds</SortTh>
                      <SortTh col="cost" sort={incSort.sort} onSort={incSort.toggle} className="text-right">Cost</SortTh>
                      <SortTh col="gain" sort={incSort.sort} onSort={incSort.toggle} className="text-right">Gain/Loss</SortTh>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 bg-white">
                    {sortedIncome.map((r, i) => {
                      const parsed = parseOptionTicker(r.ticker)
                      const qty = parseFloat(r.quantity)
                      return (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{r.date}</td>
                          <td className="px-4 py-2.5 font-medium whitespace-nowrap">{parsed?.display ?? r.ticker}</td>
                          <td className="px-4 py-2.5 text-gray-700 font-medium whitespace-nowrap">{r.underlying_ticker ?? '—'}</td>
                          <td className="px-4 py-2.5 text-center"><TypeBadge type={r.option_type} /></td>
                          <td className="px-4 py-2.5 text-center"><DirectionBadge direction={r.direction ?? (qty < 0 ? 'SHORT' : 'LONG')} /></td>
                          <td className="px-4 py-2.5 text-center"><CcyBadge currency={r.currency} /></td>
                          <td className="px-4 py-2.5 text-center">
                            <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{closeTypeLabel(r.close_type)}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono">{Math.abs(qty)}</td>
                          <td className="px-4 py-2.5 text-right">{fmtCAD(r.proceeds_cad)}</td>
                          <td className="px-4 py-2.5 text-right text-gray-500">{fmtCAD(r.acb_cad)}</td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${pnlClass(r.gain_cad)}`}>{fmtCAD(r.gain_cad)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                    <tr className="font-semibold text-sm">
                      <td colSpan={8} className="px-4 py-2.5 text-gray-500">Total ({filteredIncome.length})</td>
                      <td className="px-4 py-2.5 text-right">{fmtCAD(totalProceeds)}</td>
                      <td className="px-4 py-2.5 text-right text-gray-500">{fmtCAD(totalCost)}</td>
                      <td className={`px-4 py-2.5 text-right ${pnlClass(totalGain)}`}>{fmtCAD(totalGain)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
