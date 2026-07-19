import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowLeft, Loader2, ExternalLink, TrendingUp, TrendingDown } from 'lucide-react'
import TechnicalChart from '../components/TechnicalChart'
import {
  getConsolidatedPositions,
  getSecurityYahooDetail,
  getSecurityPriceHistory,
  getTransactions,
} from '../api/client'
import type { ConsolidatedPosition, PriceHistoryPoint } from '../api/client'

type ChartPeriod = '1m' | '3m' | '6m' | '1y' | '2y' | '5y'
const PERIODS: ChartPeriod[] = ['1m', '3m', '6m', '1y', '2y', '5y']

function fmtCAD(n: number | string | null | undefined): string {
  if (n == null || n === '') return '—'
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (isNaN(v)) return '—'
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(v)
}

function fmtPct(n: number | string | null | undefined): string {
  if (n == null || n === '') return '—'
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (isNaN(v)) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

export default function SecurityDetail() {
  const { securityId } = useParams<{ securityId: string }>()
  const navigate = useNavigate()
  const id = securityId ? parseInt(securityId, 10) : null
  const [period, setPeriod] = useState<ChartPeriod>('1y')

  const { data: allPositions = [], isLoading } = useQuery({
    queryKey: ['consolidated-positions'],
    queryFn: () => getConsolidatedPositions({}),
    staleTime: 2 * 60 * 1000,
  })

  const position = (allPositions as ConsolidatedPosition[]).find(p => p.security_id === id)
  const secId = position?.security_id ?? null
  const isOption = position?.asset_class === 'OPTION'

  const yahooQ = useQuery({
    queryKey: ['yahoo-detail', secId],
    queryFn: () => getSecurityYahooDetail(secId!),
    enabled: !!secId && !isOption,
    staleTime: 5 * 60 * 1000,
  })

  const histQ = useQuery({
    queryKey: ['price-history', secId, period],
    queryFn: () => getSecurityPriceHistory(secId!, period),
    enabled: !!secId,
    staleTime: 10 * 60 * 1000,
  })

  const txQ = useQuery({
    queryKey: ['transactions-panel', secId],
    queryFn: () => getTransactions({ security_id: secId!, page_size: 50, sort_by: 'transaction_date', sort_dir: 'desc' }),
    enabled: !!secId,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!position) {
    return (
      <div className="p-4 space-y-4">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-sm text-primary">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <p className="text-muted-foreground text-sm">Security not found.</p>
      </div>
    )
  }

  const yahoo = yahooQ.data
  const priceHistory: PriceHistoryPoint[] = histQ.data ?? []
  const chartData = priceHistory
    .filter(p => (p.close_cad ?? p.close) != null)
    .map(p => ({ date: p.date, price: p.close_cad ?? p.close! }))

  const price     = position.current_price_cad ? parseFloat(position.current_price_cad) : null
  const dayChg    = position.day_change_pct ? parseFloat(position.day_change_pct) : null
  const mktVal    = position.market_value_cad ? parseFloat(position.market_value_cad) : null
  const pnl       = position.unrealized_pnl_cad ? parseFloat(position.unrealized_pnl_cad) : null
  const pnlPct    = position.unrealized_pnl_pct ? parseFloat(position.unrealized_pnl_pct) : null
  const acb       = position.total_acb_cad ? parseFloat(position.total_acb_cad) : null
  const acbShare  = position.acb_per_share_cad ? parseFloat(position.acb_per_share_cad) : null
  const qty       = position.total_quantity ? parseFloat(position.total_quantity) : null
  const transactions = (txQ.data as { items: Record<string, unknown>[] } | undefined)?.items ?? []

  return (
    <div className="space-y-4 pb-4">
      {/* Back nav */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        Holdings
      </button>

      {/* Header card */}
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-foreground truncate">
                {position.security_name || position.ticker}
              </h1>
              {yahoo?.website && (
                <a href={yahoo.website} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                </a>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              <span className="font-mono text-sm font-semibold text-primary">{position.ticker}</span>
              {position.exchange && <span className="text-xs text-muted-foreground">{position.exchange}</span>}
              {position.currency && <span className="text-xs text-muted-foreground">· {position.currency}</span>}
              {yahoo?.sector && <span className="text-xs text-muted-foreground">· {yahoo.sector}</span>}
            </div>
          </div>
        </div>

        {/* Price strip */}
        <div className="flex items-baseline gap-3 mt-3">
          {price != null && <span className="text-2xl font-bold text-foreground">{fmtCAD(price)}</span>}
          {dayChg != null && (
            <span className={`text-sm font-medium flex items-center gap-0.5 ${dayChg >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
              {dayChg >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
              {fmtPct(dayChg)} today
            </span>
          )}
        </div>

        {/* Position stats grid */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          {[
            { label: 'Shares', value: qty?.toFixed(4) ?? '—' },
            { label: 'Market Value', value: fmtCAD(mktVal) },
            { label: 'ACB / Share', value: fmtCAD(acbShare) },
            { label: 'Total ACB', value: fmtCAD(acb) },
            { label: 'Unrealized P&L', value: fmtCAD(pnl), color: pnl != null ? (pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400') : '' },
            { label: 'Return', value: fmtPct(pnlPct), color: pnlPct != null ? (pnlPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400') : '' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-muted/50 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
              <div className={`text-sm font-semibold ${color ?? 'text-foreground'}`}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Price chart */}
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Price History (CAD)</h2>
          <div className="flex gap-1">
            {PERIODS.map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  period === p ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {p.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {histQ.isLoading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/50" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-xs text-muted-foreground">No price data</div>
        ) : (
          <TechnicalChart data={chartData} costBasis={acbShare} currency="CAD" height={200} />
        )}
      </div>

      {/* Recent transactions */}
      {transactions.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Recent Transactions</h2>
          <div className="space-y-2">
            {(transactions as Record<string, unknown>[]).slice(0, 10).map((tx, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                <div>
                  <div className="text-xs font-medium text-foreground">{String(tx.transaction_type ?? '')} · {String(tx.transaction_date ?? '').slice(0, 10)}</div>
                  <div className="text-xs text-muted-foreground">{String(tx.account_name ?? '')} · {Number(tx.quantity ?? 0).toFixed(2)} shares @ {fmtCAD(Number(tx.price ?? 0))}</div>
                </div>
                <div className={`text-xs font-semibold ${Number(tx.total_amount_cad ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                  {fmtCAD(Number(tx.total_amount_cad ?? 0))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
