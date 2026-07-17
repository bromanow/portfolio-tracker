import { useState, useMemo, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { X, ExternalLink, TrendingUp, TrendingDown, Loader2, RefreshCw, Activity, Zap, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import TechnicalChart from './TechnicalChart'
import type { ConsolidatedPosition, YahooDetail, PriceHistoryPoint, StoredFundamentals, SecuritySignals, Account, Security, Transaction } from '../api/client'
import {
  getSecurityYahooDetail, getSecurityPriceHistory, getTransactions,
  getSecurityFundamentals, refreshSecurityFundamentals,
  getSecuritySignals, computeSecuritySignals,
  getAccounts, getSecurities, updateTransaction,
  getTypeOverrides, deleteTypeOverride,
  getSecurityNews,
} from '../api/client'
import {
  TransactionEditModal, prepareTransactionUpdate, fmtApiError,
} from './TransactionEditModal'
import type { EditState } from './TransactionEditModal'
import NewsList from './NewsList'
import { getPref, usePreference } from '../hooks/usePreference'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtBig(n: number | null | undefined): string {
  if (n == null) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T'
  if (abs >= 1e9)  return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3)  return (n / 1e3).toFixed(1) + 'K'
  return n.toLocaleString()
}

function fmtPct(n: number | null | undefined, alreadyPct = false): string {
  if (n == null) return '—'
  const val = alreadyPct ? n : n * 100
  return val.toFixed(2) + '%'
}

function fmtNum(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

function fmtCAD(s: string | number | null | undefined): string {
  if (s == null || s === '') return '—'
  const n = typeof s === 'string' ? parseFloat(s) : s
  if (isNaN(n)) return '—'
  if (getPref('hideValues')) return '••••••'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(n)
}

function fmtCur(s: string | number | null | undefined, currency = 'CAD'): string {
  if (s == null || s === '') return '—'
  const n = typeof s === 'string' ? parseFloat(s) : s
  if (isNaN(n)) return '—'
  if (getPref('hideValues')) return '••••••'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)
}

function pnlClass(n: number | string | null | undefined) {
  const v = typeof n === 'string' ? parseFloat(n) : (n ?? 0)
  return v > 0 ? 'text-emerald-600' : v < 0 ? 'text-red-500' : 'text-gray-500'
}

type ChartPeriod = '1m' | '3m' | '6m' | '1y' | '3y' | 'max'
type Tab = 'overview' | 'chart' | 'fundamentals' | 'signals' | 'transactions' | 'news'


// ─── RSI gauge ────────────────────────────────────────────────────────────────

function RsiGauge({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value))
  const zone = value >= 70 ? 'overbought' : value <= 30 ? 'oversold' : 'neutral'
  const color = zone === 'overbought' ? '#ef4444' : zone === 'oversold' ? '#22c55e' : '#3b82f6'
  const label = zone === 'overbought' ? 'Overbought' : zone === 'oversold' ? 'Oversold' : 'Neutral'

  return (
    <div>
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>0 Oversold</span>
        <span className="font-semibold" style={{ color }}>{value.toFixed(1)} — {label}</span>
        <span>100 Overbought</span>
      </div>
      <div className="relative h-2 rounded-full overflow-hidden bg-gradient-to-r from-green-400 via-blue-400 to-red-400">
        <div
          className="absolute top-0 bottom-0 w-3 rounded-full border-2 border-white shadow"
          style={{ left: `calc(${pct}% - 6px)`, backgroundColor: color }}
        />
      </div>
      {/* Zone markers */}
      <div className="relative h-1 mt-0.5">
        <div className="absolute text-[9px] text-gray-300" style={{ left: '30%' }}>▲30</div>
        <div className="absolute text-[9px] text-gray-300" style={{ left: '70%' }}>▲70</div>
      </div>
    </div>
  )
}

// ─── Momentum pills ───────────────────────────────────────────────────────────

function ReturnPill({ label, value }: { label: string; value: number | null | undefined }) {
  if (value == null) return (
    <div className="flex flex-col items-center bg-gray-50 rounded-lg p-2.5">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-sm font-semibold text-gray-300 mt-0.5">—</span>
    </div>
  )
  const pos = value >= 0
  return (
    <div className={`flex flex-col items-center rounded-lg p-2.5 ${pos ? 'bg-emerald-50' : 'bg-red-50'}`}>
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-bold mt-0.5 ${pos ? 'text-emerald-700' : 'text-red-600'}`}>
        {pos ? '+' : ''}{value.toFixed(2)}%
      </span>
    </div>
  )
}

// ─── Stat row helpers ─────────────────────────────────────────────────────────

function StatRow({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex justify-between items-baseline py-1.5 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-medium text-gray-800 ${className}`}>{value}</span>
    </div>
  )
}

function StatCard({ label, value, sub, className = '' }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="text-xs text-gray-400 mb-0.5">{label}</div>
      <div className={`text-base font-semibold ${className}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── 52-week range bar ────────────────────────────────────────────────────────

function RangeBar({ low, high, current, currency }: { low: number; high: number; current: number; currency?: string }) {
  const pct = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100))
  const fmt = (v: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2 }).format(v)
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{fmt(low)}</span>
        <span className="text-gray-600 font-medium">52-Week Range</span>
        <span>{fmt(high)}</span>
      </div>
      <div className="relative h-1.5 bg-gray-200 rounded-full">
        <div className="absolute h-1.5 bg-blue-200 rounded-full" style={{ width: '100%' }} />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-600 rounded-full border-2 border-white shadow"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface Props {
  position: ConsolidatedPosition
  allPositions: ConsolidatedPosition[]
  onClose: () => void
}

export default function SecurityDetailPanel({ position, allPositions, onClose }: Props) {
  // Subscribed only so this component re-renders when the header's eye-icon toggle
  // flips — fmtCAD/fmtCur read the pref directly via getPref().
  usePreference('hideValues')
  const [tab, setTab] = useState<Tab>('overview')
  const [chartPeriod, setChartPeriod] = useState<ChartPeriod>('1y')
  const [txSortCol, setTxSortCol] = useState<'transaction_date' | 'transaction_type' | 'account_name' | 'quantity' | 'price' | 'cad_amount'>('transaction_date')
  const [txSortDir, setTxSortDir] = useState<'asc' | 'desc'>('desc')
  const [groupByAccount, setGroupByAccount] = useState(false)
  const qc = useQueryClient()

  const secId = position.security_id
  const isOption = position.asset_class === 'OPTION'
  const nativeCurrency = position.currency || 'CAD'

  // Live Yahoo data (overview Market Data strip + legacy fallback)
  const yahooQ = useQuery({
    queryKey: ['yahoo-detail', secId],
    queryFn: () => getSecurityYahooDetail(secId!),
    enabled: !!secId && !isOption && tab === 'overview',
    staleTime: 5 * 60 * 1000,
  })
  const yahoo: YahooDetail | undefined = yahooQ.data

  // Stored fundamentals (Fundamentals tab)
  const fundsQ = useQuery({
    queryKey: ['fundamentals', secId],
    queryFn: () => getSecurityFundamentals(secId!),
    enabled: !!secId && !isOption && tab === 'fundamentals',
    staleTime: 30 * 60 * 1000,
  })
  const funds: StoredFundamentals | undefined = fundsQ.data

  // Stored signals (Signals tab + Overview badge)
  const sigQ = useQuery({
    queryKey: ['signals', secId],
    queryFn: () => getSecuritySignals(secId!),
    enabled: !!secId && !isOption,
    staleTime: 60 * 60 * 1000,
  })
  const sig: SecuritySignals | undefined = sigQ.data

  const newsQ = useQuery({
    queryKey: ['security-news', secId],
    queryFn: () => getSecurityNews(secId!),
    enabled: !!secId && tab === 'news',
    staleTime: 15 * 60 * 1000,
  })

  // Mutations
  const refreshFunds = useMutation({
    mutationFn: () => refreshSecurityFundamentals(secId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fundamentals', secId] }),
  })
  const recomputeSig = useMutation({
    mutationFn: () => computeSecuritySignals(secId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['signals', secId] }),
  })

  const histQ = useQuery({
    queryKey: ['price-history', secId, chartPeriod],
    queryFn: () => getSecurityPriceHistory(secId!, chartPeriod),
    enabled: !!secId && tab === 'chart',
    staleTime: 10 * 60 * 1000,
  })
  const priceHistory: PriceHistoryPoint[] = histQ.data ?? []

  const txnQ = useQuery({
    queryKey: ['transactions-panel', secId],
    queryFn: () => getTransactions({ security_id: secId!, page_size: 200, sort_by: 'transaction_date', sort_dir: 'desc' }),
    enabled: !!secId && tab === 'transactions',
  })
  const transactions = (txnQ.data as { items: Record<string, unknown>[] } | undefined)?.items ?? []

  // ── Sort + group-by-account (client-side; the 200-row page is already loaded) ──
  const sortedTransactions = useMemo(() => {
    const dir = txSortDir === 'asc' ? 1 : -1
    return [...transactions].sort((a, b) => {
      const av = a[txSortCol], bv = b[txSortCol]
      const an = parseFloat(String(av)), bn = parseFloat(String(bv))
      const cmp = (!isNaN(an) && !isNaN(bn) && txSortCol !== 'transaction_date')
        ? an - bn
        : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { sensitivity: 'base' })
      return dir * cmp
    })
  }, [transactions, txSortCol, txSortDir])

  const txGroups = useMemo(() => {
    const sumOf = (rows: Record<string, unknown>[]) => ({
      qty: rows.reduce((s, t) => s + (parseFloat(String(t.quantity ?? '0')) || 0), 0),
      amt: rows.reduce((s, t) => s + (parseFloat(String(t.cad_amount ?? '0')) || 0), 0),
    })
    if (!groupByAccount) return [{ key: '', rows: sortedTransactions, ...sumOf(sortedTransactions) }]
    const byAcct = new Map<string, Record<string, unknown>[]>()
    for (const t of sortedTransactions) {
      const k = String(t.account_name ?? '—')
      if (!byAcct.has(k)) byAcct.set(k, [])
      byAcct.get(k)!.push(t)
    }
    return [...byAcct.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, rows]) => ({ key, rows, ...sumOf(rows) }))
  }, [sortedTransactions, groupByAccount])
  const grandTotal = useMemo(() => ({
    qty: sortedTransactions.reduce((s, t) => s + (parseFloat(String(t.quantity ?? '0')) || 0), 0),
    amt: sortedTransactions.reduce((s, t) => s + (parseFloat(String(t.cad_amount ?? '0')) || 0), 0),
  }), [sortedTransactions])

  const toggleTxSort = (col: typeof txSortCol) => {
    if (col === txSortCol) setTxSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setTxSortCol(col); setTxSortDir(col === 'transaction_date' ? 'desc' : 'asc') }
  }

  // ── Inline transaction editing (reuses the same modal as Activity → Transactions) ──
  const [editingTxn, setEditingTxn] = useState<EditState | null>(null)
  const [editTxnError, setEditTxnError] = useState<string | null>(null)
  const [editTickerInput, setEditTickerInput] = useState('')

  const { data: editAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts(), enabled: tab === 'transactions' })
  const { data: editSecurities = [] } = useQuery({ queryKey: ['securities'], queryFn: () => getSecurities(), enabled: tab === 'transactions' })

  const updateTxnMutation = useMutation({
    mutationFn: ({ id, fields }: { id: number; fields: Partial<Transaction> }) => updateTransaction(id, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions-panel', secId] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setEditingTxn(null)
      setEditTxnError(null)
    },
    onError: (err: unknown) => setEditTxnError(fmtApiError(err)),
  })

  const openTxnEdit = (t: Record<string, unknown>) => {
    setEditTxnError(null)
    setEditTickerInput(String(t.security_ticker ?? position.ticker ?? ''))
    setEditingTxn({ tx: t as unknown as Transaction, fields: { ...t } as Partial<Transaction> })
  }

  // Reclassify rules management (created quick via the edit modal's checkbox, or reviewed/
  // removed here). See SecurityAccountTypeOverride on the backend.
  const typeOverridesQ = useQuery({
    queryKey: ['type-overrides', secId],
    queryFn: () => getTypeOverrides(secId!),
    enabled: !!secId && tab === 'transactions',
  })
  const deleteOverrideMutation = useMutation({
    mutationFn: deleteTypeOverride,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['type-overrides', secId] }),
  })

  // Derived position numbers
  const qty      = parseFloat(position.total_quantity || '0')
  const acb      = parseFloat(position.total_acb_cad || '0')
  const acbShare = parseFloat(position.acb_per_share_cad || '0')
  const mktVal   = position.market_value_cad ? parseFloat(position.market_value_cad) : null
  const pnl      = position.unrealized_pnl_cad ? parseFloat(position.unrealized_pnl_cad) : null
  const pnlPct   = position.unrealized_pnl_pct ? parseFloat(position.unrealized_pnl_pct) : null
  const price    = position.current_price_cad ? parseFloat(position.current_price_cad) : null
  const priceNative = position.current_price ? parseFloat(position.current_price) : null
  const dayChg   = position.day_change_pct ? parseFloat(position.day_change_pct) : null

  // Chart data — prefer CAD prices, fall back to native
  const chartData = priceHistory
    .filter(p => (p.close_cad ?? p.close) != null)
    .map(p => ({ date: p.date, price: p.close_cad ?? p.close! }))

  const chartCurrency = 'CAD'
  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'chart', label: 'Chart' },
    { id: 'fundamentals', label: 'Fundamentals' },
    { id: 'signals', label: 'Signals' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'news', label: 'News' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/20" />

      {/* Panel */}
      <div
        className="w-[620px] bg-white shadow-2xl flex flex-col h-full overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="px-5 pt-4 pb-3 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-gray-900 truncate">
                  {position.security_name || position.ticker}
                </h2>
                {yahoo?.website && (
                  <a href={yahoo.website} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                    <ExternalLink className="h-3.5 w-3.5 text-gray-400 hover:text-blue-500" />
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="font-mono text-sm font-semibold text-blue-700">{position.ticker}</span>
                {position.fetch_ticker && position.fetch_ticker !== position.ticker && (
                  <span className="text-xs text-purple-500 font-mono" title="Actual Yahoo Finance lookup symbol">
                    ↗{position.fetch_ticker}
                  </span>
                )}
                {position.exchange && <span className="text-xs text-gray-400">{position.exchange}</span>}
                {position.currency && <span className="text-xs text-gray-400">· {position.currency}</span>}
                {yahoo?.sector && <span className="text-xs text-gray-400">· {yahoo.sector}</span>}
              </div>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 ml-3 flex-shrink-0">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Price strip */}
          <div className="flex items-baseline gap-3 mt-2.5">
            {price != null && (
              <span className="text-2xl font-bold text-gray-900">{fmtCAD(price)}</span>
            )}
            {nativeCurrency !== 'CAD' && priceNative != null && (
              <span className="text-sm text-gray-400">{fmtCur(priceNative, nativeCurrency)}</span>
            )}
            {dayChg != null && (
              <span className={`text-sm font-medium flex items-center gap-0.5 ${dayChg >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                {dayChg >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {dayChg >= 0 ? '+' : ''}{dayChg.toFixed(2)}% today
              </span>
            )}
            {position.price_date && (
              <span className="text-xs text-gray-400 ml-auto">{position.price_date}</span>
            )}
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b border-gray-100 flex-shrink-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Tab content ── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Overview ── */}
          {tab === 'overview' && (
            <div className="p-5 space-y-5">

              {/* Position summary cards */}
              <section>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Your Position</h3>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  <StatCard label="Quantity" value={qty.toLocaleString('en-CA', { maximumFractionDigits: 4 })} />
                  <StatCard label="ACB / Share" value={fmtCAD(acbShare)} />
                  <StatCard label="Total Cost" value={fmtCAD(acb)} />
                  <StatCard label="Market Value" value={mktVal != null ? fmtCAD(mktVal) : '—'} />
                </div>
                {pnl != null && (
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${pnl >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                    {pnl >= 0 ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-500" />}
                    <span className={`font-semibold ${pnlClass(pnl)}`}>{fmtCAD(pnl)}</span>
                    {pnlPct != null && (
                      <span className={`text-sm ${pnlClass(pnl)}`}>({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</span>
                    )}
                    <span className="text-xs text-gray-400 ml-1">unrealized P&L</span>
                  </div>
                )}
              </section>

              {/* Market stats */}
              {!isOption && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Market Data</h3>
                  {yahooQ.isLoading ? (
                    <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading market data…
                    </div>
                  ) : yahoo?.available === false ? (
                    <div className="text-sm text-gray-400 py-2">Market data unavailable: {yahoo.reason}</div>
                  ) : yahoo ? (
                    <div className="space-y-3">
                      {/* 52-week range */}
                      {yahoo.fifty_two_week_low != null && yahoo.fifty_two_week_high != null && price != null && (
                        <div className="bg-gray-50 rounded-lg p-3">
                          <RangeBar
                            low={yahoo.fifty_two_week_low}
                            high={yahoo.fifty_two_week_high}
                            current={priceNative ?? price}
                            currency={nativeCurrency}
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-x-6">
                        <div>
                          <StatRow label="Market Cap" value={fmtBig(yahoo.market_cap)} />
                          <StatRow label="P/E Ratio" value={fmtNum(yahoo.pe_ratio)} />
                          <StatRow label="Fwd P/E" value={fmtNum(yahoo.forward_pe)} />
                          <StatRow label="EPS" value={fmtNum(yahoo.eps)} />
                          <StatRow label="Beta" value={fmtNum(yahoo.beta)} />
                        </div>
                        <div>
                          <StatRow label="Volume" value={yahoo.volume != null ? yahoo.volume.toLocaleString() : '—'} />
                          <StatRow label="Avg Volume" value={yahoo.avg_volume != null ? yahoo.avg_volume.toLocaleString() : '—'} />
                          <StatRow label="Dividend" value={yahoo.dividend_rate != null ? fmtCur(yahoo.dividend_rate, nativeCurrency) : '—'} />
                          <StatRow label="Yield" value={fmtPct(yahoo.dividend_yield)} />
                          <StatRow label="50-Day Avg" value={yahoo.fifty_day_avg != null ? fmtCur(yahoo.fifty_day_avg, nativeCurrency) : '—'} />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </section>
              )}

              {/* Signals quick-look */}
              {!isOption && sig?.available && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Technical Signals
                    <button onClick={() => setTab('signals')} className="ml-2 text-blue-500 normal-case font-normal hover:underline">view all →</button>
                  </h3>
                  <div className="grid grid-cols-2 gap-x-6">
                    <div>
                      {sig.rsi_14 != null && (
                        <StatRow
                          label="RSI-14"
                          value={`${sig.rsi_14.toFixed(1)} ${sig.rsi_14 >= 70 ? '(Overbought)' : sig.rsi_14 <= 30 ? '(Oversold)' : '(Neutral)'}`}
                          className={sig.rsi_14 >= 70 ? 'text-red-500' : sig.rsi_14 <= 30 ? 'text-emerald-600' : ''}
                        />
                      )}
                      {sig.return_1m != null && (
                        <StatRow
                          label="1-Month Return"
                          value={`${sig.return_1m >= 0 ? '+' : ''}${sig.return_1m.toFixed(2)}%`}
                          className={sig.return_1m >= 0 ? 'text-emerald-600' : 'text-red-500'}
                        />
                      )}
                      {sig.return_12m != null && (
                        <StatRow
                          label="12-Month Return"
                          value={`${sig.return_12m >= 0 ? '+' : ''}${sig.return_12m.toFixed(2)}%`}
                          className={sig.return_12m >= 0 ? 'text-emerald-600' : 'text-red-500'}
                        />
                      )}
                    </div>
                    <div>
                      {sig.golden_cross != null && (
                        <div className="flex justify-between items-baseline py-1.5 border-b border-gray-50">
                          <span className="text-xs text-gray-500">Trend</span>
                          <span className={`text-xs font-semibold ${sig.golden_cross ? 'text-emerald-600' : 'text-red-500'}`}>
                            {sig.golden_cross ? '★ Golden Cross' : '✕ Death Cross'}
                          </span>
                        </div>
                      )}
                      {sig.volatility_20d != null && (
                        <StatRow
                          label="Volatility (20d)"
                          value={`${sig.volatility_20d.toFixed(1)}%`}
                          className={sig.volatility_20d > 40 ? 'text-amber-600' : ''}
                        />
                      )}
                      {sig.price_vs_50d != null && (
                        <StatRow
                          label="vs 50-Day MA"
                          value={`${sig.price_vs_50d >= 0 ? '+' : ''}${sig.price_vs_50d.toFixed(2)}%`}
                          className={sig.price_vs_50d >= 0 ? 'text-emerald-600' : 'text-red-500'}
                        />
                      )}
                    </div>
                  </div>
                </section>
              )}

              {/* Description */}
              {(yahoo?.description) && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">About</h3>
                  <p className="text-sm text-gray-600 leading-relaxed line-clamp-6">{yahoo.description}</p>
                  {yahoo.website && (
                    <a href={yahoo.website} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:underline mt-1 inline-block">
                      {yahoo.website.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                </section>
              )}

              {/* Accounts breakdown */}
              {position.accounts.length > 1 && (
                <section>
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">By Account</h3>
                  <div className="space-y-1">
                    {position.accounts.map(a => (
                      <div key={a.account_id} className="flex justify-between items-center text-sm py-1.5 border-b border-gray-50 last:border-0">
                        <span className="text-gray-600">{a.account_name}</span>
                        <div className="flex gap-4 text-right">
                          <span className="text-gray-500 text-xs">{parseFloat(a.quantity).toLocaleString('en-CA', { maximumFractionDigits: 4 })} shares</span>
                          <span className="font-medium text-gray-800 w-24">{fmtCAD(a.total_acb_cad)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* ── Chart ── */}
          {tab === 'chart' && (
            <div className="p-5">
              {/* Period selector */}
              <div className="flex gap-1 mb-4">
                {(['1m', '3m', '6m', '1y', '3y', 'max'] as ChartPeriod[]).map(p => (
                  <button
                    key={p}
                    onClick={() => setChartPeriod(p)}
                    className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                      chartPeriod === p
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {p.toUpperCase()}
                  </button>
                ))}
              </div>

              {histQ.isLoading ? (
                <div className="flex items-center justify-center h-64 text-gray-400">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading price history…
                </div>
              ) : chartData.length === 0 ? (
                <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
                  No price history available for this period.
                  <br />Run a historical price download from the Prices tab.
                </div>
              ) : (
                <TechnicalChart data={chartData} costBasis={acbShare} currency={chartCurrency} height={280} />
              )}
            </div>
          )}

          {/* ── Fundamentals ── */}
          {tab === 'fundamentals' && (
            <div className="p-5 space-y-5">
              {isOption ? (
                <p className="text-sm text-gray-400">Fundamentals are not available for options.</p>
              ) : fundsQ.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  {/* Header: last-updated + refresh button */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">
                      {funds?.fetched_at
                        ? `Updated ${new Date(funds.fetched_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : funds?.available === false ? 'Not yet fetched' : ''}
                    </span>
                    <button
                      onClick={() => refreshFunds.mutate()}
                      disabled={refreshFunds.isPending}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshFunds.isPending ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>

                  {funds?.available === false ? (
                    <div className="text-sm text-gray-400 py-2 text-center">
                      {funds.reason}
                      <br />
                      <button onClick={() => refreshFunds.mutate()} className="text-blue-500 hover:underline mt-2 text-xs">
                        Fetch now
                      </button>
                    </div>
                  ) : funds ? (
                    <>
                      <section>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Valuation</h3>
                        <div className="grid grid-cols-2 gap-x-6">
                          <div>
                            <StatRow label="Market Cap" value={fmtBig(funds.market_cap)} />
                            <StatRow label="Enterprise Value" value={fmtBig(funds.enterprise_value)} />
                            <StatRow label="P/E (Trailing)" value={fmtNum(funds.pe_ratio)} />
                            <StatRow label="P/E (Forward)" value={fmtNum(funds.forward_pe)} />
                            <StatRow label="PEG Ratio" value={fmtNum(funds.peg_ratio)} />
                          </div>
                          <div>
                            <StatRow label="Price/Book" value={fmtNum(funds.price_to_book)} />
                            <StatRow label="Price/Sales" value={fmtNum(funds.price_to_sales)} />
                            <StatRow label="EV/EBITDA" value={fmtNum(funds.ev_to_ebitda)} />
                            <StatRow label="EPS" value={fmtNum(funds.eps)} />
                            <StatRow label="Fwd EPS" value={fmtNum(funds.forward_eps)} />
                          </div>
                        </div>
                      </section>

                      <section>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Financials</h3>
                        <div className="grid grid-cols-2 gap-x-6">
                          <div>
                            <StatRow label="Revenue" value={fmtBig(funds.total_revenue)} />
                            <StatRow label="EBITDA" value={fmtBig(funds.ebitda)} />
                            <StatRow label="Net Income" value={fmtBig(funds.net_income)} />
                            <StatRow label="Free Cash Flow" value={fmtBig(funds.free_cashflow)} />
                            <StatRow label="Operating CF" value={fmtBig(funds.operating_cashflow)} />
                          </div>
                          <div>
                            <StatRow label="Gross Margin" value={fmtPct(funds.gross_margin)} />
                            <StatRow label="Operating Margin" value={fmtPct(funds.operating_margin)} />
                            <StatRow label="Profit Margin" value={fmtPct(funds.profit_margin)} />
                            <StatRow label="Revenue Growth" value={fmtPct(funds.revenue_growth)} />
                            <StatRow label="Earnings Growth" value={fmtPct(funds.earnings_growth)} />
                          </div>
                        </div>
                      </section>

                      <section>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Balance Sheet & Returns</h3>
                        <div className="grid grid-cols-2 gap-x-6">
                          <div>
                            <StatRow label="Total Debt" value={fmtBig(funds.total_debt)} />
                            <StatRow label="Total Cash" value={fmtBig(funds.total_cash)} />
                            <StatRow label="Debt/Equity" value={fmtNum(funds.debt_to_equity)} />
                            <StatRow label="Current Ratio" value={fmtNum(funds.current_ratio)} />
                          </div>
                          <div>
                            <StatRow label="Return on Equity" value={fmtPct(funds.return_on_equity)} />
                            <StatRow label="Return on Assets" value={fmtPct(funds.return_on_assets)} />
                            <StatRow label="Beta" value={fmtNum(funds.beta)} />
                            <StatRow label="Shares Outstanding" value={fmtBig(funds.shares_outstanding)} />
                          </div>
                        </div>
                      </section>

                      {funds.analyst_target_price != null && (
                        <section>
                          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Analyst Consensus</h3>
                          <div className="grid grid-cols-2 gap-x-6">
                            <div>
                              <StatRow label="Target Price" value={fmtCur(funds.analyst_target_price, nativeCurrency)} />
                              <StatRow label="Analysts" value={funds.analyst_count != null ? String(funds.analyst_count) : '—'} />
                            </div>
                            <div>
                              {funds.analyst_recommendation && (
                                <div className="flex justify-between items-baseline py-1.5 border-b border-gray-50">
                                  <span className="text-xs text-gray-500">Recommendation</span>
                                  <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${
                                    funds.analyst_recommendation.includes('buy') ? 'bg-emerald-100 text-emerald-700' :
                                    funds.analyst_recommendation.includes('sell') ? 'bg-red-100 text-red-700' :
                                    'bg-gray-100 text-gray-600'
                                  }`}>{funds.analyst_recommendation}</span>
                                </div>
                              )}
                              {funds.short_ratio != null && <StatRow label="Short Ratio" value={fmtNum(funds.short_ratio)} />}
                            </div>
                          </div>
                        </section>
                      )}

                      {(funds.employees || funds.website) && (
                        <section>
                          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Company</h3>
                          <div className="grid grid-cols-2 gap-x-6">
                            <div>
                              {funds.employees != null && <StatRow label="Employees" value={funds.employees.toLocaleString()} />}
                            </div>
                            <div>
                              {funds.website && (
                                <div className="flex justify-between items-baseline py-1.5 border-b border-gray-50">
                                  <span className="text-xs text-gray-500">Website</span>
                                  <a href={funds.website} target="_blank" rel="noopener noreferrer"
                                    className="text-xs text-blue-500 hover:underline truncate max-w-[180px]">
                                    {funds.website.replace(/^https?:\/\//, '')}
                                  </a>
                                </div>
                              )}
                            </div>
                          </div>
                        </section>
                      )}
                    </>
                  ) : null}
                </>
              )}
            </div>
          )}

          {/* ── Signals ── */}
          {tab === 'signals' && (
            <div className="p-5 space-y-5">
              {isOption ? (
                <p className="text-sm text-gray-400">Technical signals are not available for options.</p>
              ) : sigQ.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Activity className="h-3 w-3" />
                      {sig?.as_of_date ? `As of ${sig.as_of_date}` : sig?.available === false ? 'Not yet computed' : ''}
                    </span>
                    <button
                      onClick={() => recomputeSig.mutate()}
                      disabled={recomputeSig.isPending}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${recomputeSig.isPending ? 'animate-spin' : ''}`} />
                      Recompute
                    </button>
                  </div>

                  {sig?.available === false ? (
                    <div className="text-sm text-gray-400 py-2 text-center">
                      {sig.reason}
                      <br />
                      <span className="text-xs">Download price history first, then click Recompute.</span>
                    </div>
                  ) : sig ? (
                    <>
                      {/* Momentum: return pills */}
                      <section>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                          <Zap className="h-3 w-3 inline mr-1" />Momentum
                        </h3>
                        <div className="grid grid-cols-4 gap-2">
                          <ReturnPill label="1 Month" value={sig.return_1m} />
                          <ReturnPill label="3 Months" value={sig.return_3m} />
                          <ReturnPill label="6 Months" value={sig.return_6m} />
                          <ReturnPill label="12 Months" value={sig.return_12m} />
                        </div>
                        {sig.momentum_12_1 != null && (
                          <div className="mt-2 text-xs text-gray-500 text-center">
                            12-1 Month Factor:{' '}
                            <span className={`font-semibold ${sig.momentum_12_1 >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                              {sig.momentum_12_1 >= 0 ? '+' : ''}{sig.momentum_12_1.toFixed(2)}%
                            </span>
                            <span className="text-gray-400 ml-1">(medium-term trend strength)</span>
                          </div>
                        )}
                      </section>

                      {/* RSI */}
                      {sig.rsi_14 != null && (
                        <section>
                          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">RSI (14-Day)</h3>
                          <div className="bg-gray-50 rounded-lg p-3">
                            <RsiGauge value={sig.rsi_14} />
                          </div>
                        </section>
                      )}

                      {/* Trend */}
                      <section>
                        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Trend</h3>
                        <div className="space-y-2">
                          {sig.golden_cross != null && (
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                                sig.golden_cross ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                              }`}>
                                {sig.golden_cross ? '★ Golden Cross' : '✕ Death Cross'}
                              </span>
                              <span className="text-xs text-gray-400">
                                {sig.golden_cross ? '50-day MA above 200-day MA (bullish)' : '50-day MA below 200-day MA (bearish)'}
                              </span>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-x-6">
                            <div>
                              <StatRow label="50-Day MA" value={sig.ma_50d != null ? fmtCAD(sig.ma_50d) : '—'} />
                              <StatRow
                                label="vs 50-Day MA"
                                value={sig.price_vs_50d != null ? `${sig.price_vs_50d >= 0 ? '+' : ''}${sig.price_vs_50d.toFixed(2)}%` : '—'}
                                className={sig.price_vs_50d != null ? (sig.price_vs_50d >= 0 ? 'text-emerald-600' : 'text-red-500') : ''}
                              />
                            </div>
                            <div>
                              <StatRow label="200-Day MA" value={sig.ma_200d != null ? fmtCAD(sig.ma_200d) : '—'} />
                              <StatRow
                                label="vs 200-Day MA"
                                value={sig.price_vs_200d != null ? `${sig.price_vs_200d >= 0 ? '+' : ''}${sig.price_vs_200d.toFixed(2)}%` : '—'}
                                className={sig.price_vs_200d != null ? (sig.price_vs_200d >= 0 ? 'text-emerald-600' : 'text-red-500') : ''}
                              />
                            </div>
                          </div>
                        </div>
                      </section>

                      {/* Volatility */}
                      {(sig.volatility_20d != null || sig.volatility_60d != null) && (
                        <section>
                          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Realised Volatility (Annualised)</h3>
                          <div className="grid grid-cols-2 gap-x-6">
                            <div>
                              <StatRow
                                label="20-Day Vol"
                                value={sig.volatility_20d != null ? `${sig.volatility_20d.toFixed(1)}%` : '—'}
                                className={sig.volatility_20d != null && sig.volatility_20d > 40 ? 'text-amber-600' : ''}
                              />
                            </div>
                            <div>
                              <StatRow
                                label="60-Day Vol"
                                value={sig.volatility_60d != null ? `${sig.volatility_60d.toFixed(1)}%` : '—'}
                                className={sig.volatility_60d != null && sig.volatility_60d > 40 ? 'text-amber-600' : ''}
                              />
                            </div>
                          </div>
                          <p className="text-xs text-gray-400 mt-2">
                            Low &lt;15% · Medium 15–30% · High 30–50% · Very High &gt;50%
                          </p>
                        </section>
                      )}

                      <p className="text-xs text-gray-300 pt-1">
                        Computed from local price history · {sig.computed_at ? new Date(sig.computed_at).toLocaleString('en-CA') : ''}
                      </p>
                    </>
                  ) : null}
                </>
              )}
            </div>
          )}

          {/* ── Transactions ── */}
          {tab === 'transactions' && (
            <div className="p-5">
              {(typeOverridesQ.data ?? []).length > 0 && (
                <div className="mb-4 bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Reclassify Rules</h4>
                  <div className="space-y-1">
                    {typeOverridesQ.data!.map(rule => (
                      <div key={rule.id} className="flex items-center justify-between text-xs bg-white border border-gray-100 rounded px-2.5 py-1.5">
                        <span className="text-gray-700">
                          <span className="font-medium">{rule.from_type}</span> → <span className="font-medium">{rule.to_type}</span>
                          <span className="text-gray-400"> for </span>{rule.account_name}
                        </span>
                        <button
                          onClick={() => deleteOverrideMutation.mutate(rule.id)}
                          disabled={deleteOverrideMutation.isPending}
                          className="text-gray-300 hover:text-red-500"
                          title="Delete this rule"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    Applied automatically to new imports going forward. Create one from the checkbox
                    when editing a transaction whose type you change.
                  </p>
                </div>
              )}
              {txnQ.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading transactions…
                </div>
              ) : transactions.length === 0 ? (
                <p className="text-sm text-gray-400">No transactions found.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-gray-400">Click a row to edit it.</p>
                    <button
                      onClick={() => setGroupByAccount(g => !g)}
                      className={`text-xs border rounded px-2.5 py-1 ${groupByAccount ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                    >
                      Group by Account
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs divide-y divide-gray-100">
                      <thead className="bg-gray-50">
                        <tr className="text-gray-500 uppercase">
                          {([
                            ['transaction_date', 'Date', 'left'],
                            ['transaction_type', 'Type', 'left'],
                            ['account_name', 'Account', 'left'],
                            ['quantity', 'Qty', 'right'],
                            ['price', 'Price', 'right'],
                            ['cad_amount', 'Amount (CAD)', 'right'],
                          ] as const).map(([col, label, align]) => (
                            <th
                              key={col}
                              onClick={() => toggleTxSort(col)}
                              className={`px-3 py-2 cursor-pointer select-none hover:bg-gray-100 text-${align}`}
                            >
                              <span className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
                                {label}
                                {txSortCol === col
                                  ? (txSortDir === 'asc' ? <ChevronUp className="h-3 w-3 text-blue-600" /> : <ChevronDown className="h-3 w-3 text-blue-600" />)
                                  : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {txGroups.map((group, gi) => (
                          <Fragment key={gi}>
                            {groupByAccount && (
                              <tr key={`hdr-${gi}`} className="bg-gray-50">
                                <td colSpan={6} className="px-3 py-1.5 text-xs font-semibold text-gray-600">{group.key}</td>
                              </tr>
                            )}
                            {group.rows.map((t: Record<string, unknown>, i: number) => {
                              const typ = String(t.transaction_type || '')
                              const isBuy = ['BUY', 'DRIP'].includes(typ)
                              const isSell = ['SELL', 'OPTION_EXPIRY', 'OPTION_ASSIGNMENT'].includes(typ)
                              return (
                                <tr key={`${gi}-${i}`} className="hover:bg-blue-50 cursor-pointer" onClick={() => openTxnEdit(t)}>
                                  <td className="px-3 py-2 text-gray-600">{String(t.transaction_date || '').slice(0, 10)}</td>
                                  <td className="px-3 py-2">
                                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                                      isBuy ? 'bg-blue-50 text-blue-700' :
                                      isSell ? 'bg-red-50 text-red-700' :
                                      'bg-gray-100 text-gray-600'
                                    }`}>{typ}</span>
                                  </td>
                                  <td className="px-3 py-2 text-gray-500 max-w-[120px] truncate">{String(t.account_name || '—')}</td>
                                  <td className="px-3 py-2 text-right text-gray-700">
                                    {t.quantity != null ? parseFloat(String(t.quantity)).toLocaleString('en-CA', { maximumFractionDigits: 4 }) : '—'}
                                  </td>
                                  <td className="px-3 py-2 text-right text-gray-700">
                                    {t.price != null ? fmtCur(parseFloat(String(t.price)), String(t.currency || 'CAD')) : '—'}
                                  </td>
                                  <td className="px-3 py-2 text-right font-medium">
                                    {t.cad_amount != null ? fmtCAD(String(t.cad_amount)) : '—'}
                                  </td>
                                </tr>
                              )
                            })}
                            {groupByAccount && (
                              <tr key={`sub-${gi}`} className="bg-gray-50/60 font-medium">
                                <td colSpan={3} className="px-3 py-1.5 text-right text-gray-500 text-xs">Subtotal</td>
                                <td className="px-3 py-1.5 text-right text-gray-700">{group.qty.toLocaleString('en-CA', { maximumFractionDigits: 4 })}</td>
                                <td />
                                <td className="px-3 py-1.5 text-right text-gray-800">{fmtCAD(group.amt)}</td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-gray-200 font-semibold">
                          <td colSpan={3} className="px-3 py-2 text-right text-gray-600 text-xs">Total</td>
                          <td className="px-3 py-2 text-right text-gray-900">{grandTotal.qty.toLocaleString('en-CA', { maximumFractionDigits: 4 })}</td>
                          <td />
                          <td className="px-3 py-2 text-right text-gray-900">{fmtCAD(grandTotal.amt)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}

              <TransactionEditModal
                editing={editingTxn}
                onClose={() => { setEditingTxn(null); setEditTxnError(null) }}
                onChangeFields={fields => setEditingTxn(p => p ? { ...p, fields } : null)}
                accounts={editAccounts as Account[]}
                securities={editSecurities as Security[]}
                tickerInput={editTickerInput}
                onTickerChange={val => {
                  setEditTickerInput(val)
                  const sec = (editSecurities as Security[]).find(s => s.ticker.toUpperCase() === val)
                  setEditingTxn(p => p ? { ...p, fields: { ...p.fields, security_id: sec?.id ?? null } } : null)
                }}
                error={editTxnError}
                saving={updateTxnMutation.isPending}
                onSave={() => {
                  if (!editingTxn) return
                  updateTxnMutation.mutate({ id: editingTxn.tx.id, fields: prepareTransactionUpdate(editingTxn.fields) })
                }}
              />
            </div>
          )}

          {tab === 'news' && (
            <div className="p-5">
              <NewsList
                items={newsQ.data?.items}
                isLoading={newsQ.isLoading}
                emptyMessage={`No news found${newsQ.data?.symbol ? ` for ${newsQ.data.symbol}` : ''}.`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
