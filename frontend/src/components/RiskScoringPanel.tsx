import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getPortfolioRisk, refreshFundamentals } from '../api/client'
import { ChevronDown, ChevronRight, RefreshCw, AlertTriangle, Info } from 'lucide-react'

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—'
  return n.toFixed(decimals) + '%'
}

function fmtNum(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}

// ─── Gauge / score card ───────────────────────────────────────────────────────

function MetricCard({
  label, value, sub, color = 'text-gray-800', tooltip,
}: {
  label: string
  value: string
  sub?: string
  color?: string
  tooltip?: string
}) {
  return (
    <div className="bg-gray-50 rounded-lg p-3 flex flex-col gap-0.5" title={tooltip}>
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-xl font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-xs text-gray-400">{sub}</span>}
    </div>
  )
}

// ─── HHI gauge ───────────────────────────────────────────────────────────────

function HhiGauge({ hhi }: { hhi: number }) {
  // HHI on 0-100 scale (sum of squared weights * 100)
  // <10 = diversified, 10-25 = moderate, >25 = concentrated
  const pct = Math.min(100, hhi / 40 * 100)
  const color = hhi < 10 ? 'bg-emerald-500' : hhi < 25 ? 'bg-amber-500' : 'bg-red-500'
  const label = hhi < 10 ? 'Well Diversified' : hhi < 25 ? 'Moderately Concentrated' : 'Highly Concentrated'

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-500">
        <span>Herfindahl Index</span>
        <span className="font-semibold text-gray-700">{hhi.toFixed(1)}</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-gray-400">{label}</div>
    </div>
  )
}

// ─── Currency bar ─────────────────────────────────────────────────────────────

const CCY_COLORS: Record<string, string> = {
  CAD: 'bg-red-400',
  USD: 'bg-blue-400',
  GBP: 'bg-purple-400',
  EUR: 'bg-amber-400',
}

function CurrencyBar({ exposure }: { exposure: Array<{ currency: string; pct: number }> }) {
  return (
    <div className="space-y-2">
      <div className="flex h-4 rounded overflow-hidden gap-px">
        {exposure.map(e => (
          <div
            key={e.currency}
            className={`${CCY_COLORS[e.currency] ?? 'bg-gray-400'}`}
            style={{ width: `${e.pct}%` }}
            title={`${e.currency} ${e.pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {exposure.map(e => (
          <span key={e.currency} className="flex items-center gap-1 text-xs text-gray-600">
            <span className={`inline-block w-2.5 h-2.5 rounded-sm ${CCY_COLORS[e.currency] ?? 'bg-gray-400'}`} />
            {e.currency} {e.pct.toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Volatility indicator ─────────────────────────────────────────────────────

function volColor(pct: number | null | undefined): string {
  if (pct == null) return 'text-gray-400'
  if (pct < 15) return 'text-emerald-600'
  if (pct < 25) return 'text-amber-600'
  return 'text-red-500'
}

function betaColor(beta: number | null | undefined): string {
  if (beta == null) return 'text-gray-400'
  if (beta < 0.8) return 'text-emerald-600'
  if (beta < 1.3) return 'text-blue-600'
  return 'text-red-500'
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface Props {
  accountIds: string | undefined
}

export default function RiskScoringPanel({ accountIds }: Props) {
  const [expanded, setExpanded] = useState(false)
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['portfolio-risk', accountIds],
    queryFn: () => getPortfolioRisk({ account_ids: accountIds }),
    enabled: expanded,
  })

  const refreshMut = useMutation({
    mutationFn: refreshFundamentals,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['portfolio-risk'] }),
  })

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div
        className="px-5 py-3 flex items-center gap-2 cursor-pointer hover:bg-gray-50 select-none"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded
          ? <ChevronDown className="h-4 w-4 text-gray-400" />
          : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <h2 className="font-semibold text-gray-800">Risk Scoring</h2>
        <span className="text-xs text-gray-400">beta · volatility · concentration · currency</span>

        {expanded && (
          <button
            onClick={e => { e.stopPropagation(); refreshMut.mutate() }}
            disabled={refreshMut.isPending}
            className="ml-auto flex items-center gap-1.5 text-xs bg-white border border-gray-200 rounded px-3 py-1 hover:bg-gray-50 disabled:opacity-50"
            title="Fetch beta & dividend yield from Yahoo Finance (run weekly)"
          >
            <RefreshCw className={`h-3 w-3 ${refreshMut.isPending ? 'animate-spin' : ''}`} />
            {refreshMut.isPending ? 'Refreshing…' : 'Refresh Fundamentals'}
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-gray-100 p-5">
          {isLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
            </div>
          ) : !data?.available ? (
            <p className="text-gray-400 text-sm">{data?.reason ?? 'No risk data available.'}</p>
          ) : (
            <div className="space-y-6">

              {/* Row 1: Core metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard
                  label="Portfolio Beta"
                  value={fmtNum(data.portfolio_beta)}
                  sub={data.beta_coverage_pct != null ? `${data.beta_coverage_pct.toFixed(0)}% of portfolio` : undefined}
                  color={betaColor(data.portfolio_beta)}
                  tooltip="Market-value weighted beta vs S&P 500. <1 = less volatile than market, >1 = more volatile."
                />
                <MetricCard
                  label="Dividend Yield"
                  value={fmtPct(data.dividend_yield_pct)}
                  sub={data.dividend_coverage_pct != null ? `${data.dividend_coverage_pct.toFixed(0)}% of portfolio` : undefined}
                  color="text-emerald-700"
                  tooltip="Market-value weighted average dividend yield for positions with yield data (shown as % of portfolio in coverage below)."
                />
                <MetricCard
                  label="30-Day Volatility"
                  value={fmtPct(data.volatility_30d_pct)}
                  sub="annualised"
                  color={volColor(data.volatility_30d_pct)}
                  tooltip="Annualised standard deviation of daily log returns over the last 45 days."
                />
                <MetricCard
                  label="90-Day Volatility"
                  value={fmtPct(data.volatility_90d_pct)}
                  sub="annualised"
                  color={volColor(data.volatility_90d_pct)}
                  tooltip="Annualised standard deviation of daily log returns over the last 120 days."
                />
              </div>

              {/* Row 2: Concentration */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-gray-700">Concentration</h3>
                  {data.hhi != null && <HhiGauge hhi={data.hhi} />}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="space-y-0.5">
                      <div className="text-xs text-gray-500">Largest Position</div>
                      <div className="font-semibold text-gray-800">
                        {data.largest_position_ticker ?? '—'}
                        {data.largest_position_pct != null && (
                          <span className={`ml-1.5 text-sm ${data.largest_position_pct > 20 ? 'text-amber-600' : 'text-gray-500'}`}>
                            {data.largest_position_pct.toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-xs text-gray-500">Top 5 Positions</div>
                      <div className={`font-semibold ${(data.top5_concentration_pct ?? 0) > 60 ? 'text-amber-600' : 'text-gray-800'}`}>
                        {fmtPct(data.top5_concentration_pct)}
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-xs text-gray-500">Top Sector</div>
                      <div className="font-semibold text-gray-800 text-xs leading-tight">
                        {data.top_sector ?? '—'}
                        {data.top_sector_pct != null && (
                          <span className="ml-1 text-gray-500">{data.top_sector_pct.toFixed(1)}%</span>
                        )}
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-xs text-gray-500">Positions</div>
                      <div className="font-semibold text-gray-800">{data.position_count}</div>
                    </div>
                  </div>
                </div>

                {/* Currency exposure */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-gray-700">Currency Exposure</h3>
                  {data.currency_exposure && data.currency_exposure.length > 0
                    ? <CurrencyBar exposure={data.currency_exposure} />
                    : <p className="text-xs text-gray-400">No data</p>}
                </div>
              </div>

              {/* Coverage note */}
              {(data.beta_coverage_pct ?? 0) < 50 && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  Beta and dividend yield cover {data.beta_coverage_pct?.toFixed(0)}% of the portfolio.
                  Click <strong>Refresh Fundamentals</strong> to fetch missing data from Yahoo Finance.
                </div>
              )}

              {refreshMut.isSuccess && (
                <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-700">
                  <Info className="h-3.5 w-3.5 flex-shrink-0" />
                  Fundamentals refresh started in background.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
