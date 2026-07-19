import { useState, useMemo, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { RefreshCw, Play, Database, Trash2 } from 'lucide-react'
import {
  getAccounts, getPortfolioHistory, computeSnapshots, purgeSnapshots,
} from '../../api/client'
import type { Account, PortfolioHistoryPoint } from '../../api/client'
import MultiSelectDropdown from '../../components/MultiSelectDropdown'
import { fmtCAD0, fmtCADAxis, useAccountCascade, computePortfolioRange, type PortfolioRange } from './shared'

function fmtAxisDate(dateStr: string, interval: 'daily' | 'weekly' | 'monthly'): string {
  const d = new Date(dateStr + 'T00:00:00')
  if (interval === 'monthly') return d.toLocaleDateString('en-CA', { month: 'short', year: '2-digit' })
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}

// ── Portfolio Value Over Time ──────────────────────────────────────────────────

export default function PortfolioValueReport() {
  const [range, setRange]               = useState<PortfolioRange>('1Y')
  const [chartInterval, setChartInterval] = useState<'daily' | 'weekly' | 'monthly'>('weekly')

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const {
    brokerageFilter, setBrokerageFilter, brokerages,
    accountOptions, selectedAccountIds, setSelectedAccountIds, accountIds,
  } = useAccountCascade(accounts as Account[])

  const { fromDate, toDate } = useMemo(() => computePortfolioRange(range), [range])

  // Committed state: what was last Run
  const [committed, setCommitted] = useState<{
    fromDate: string | undefined; toDate: string; accountIds: string | undefined; interval: 'daily' | 'weekly' | 'monthly'
  } | null>(null)

  const [lastRunTime, setLastRunTime] = useState<string | null>(null)
  const [rebuildStatus, setRebuildStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const queryClient = useQueryClient()

  const handleRebuildSnapshots = useCallback(async () => {
    setRebuildStatus('running')
    try {
      // 1. Purge existing snapshots for selected accounts so phantom data is gone
      await purgeSnapshots(accountIds ? { account_ids: accountIds } : undefined)
      // 2. Recompute from scratch
      await computeSnapshots(accountIds ? { account_ids: accountIds } : undefined)
      // 3. Invalidate queries so the chart refreshes when user hits Run
      await queryClient.invalidateQueries({ queryKey: ['portfolio-history'] })
      setRebuildStatus('done')
      setTimeout(() => setRebuildStatus('idle'), 3000)
    } catch {
      setRebuildStatus('error')
      setTimeout(() => setRebuildStatus('idle'), 4000)
    }
  }, [accountIds, queryClient])

  const { data: history = [], isLoading } = useQuery({
    queryKey: ['portfolio-history', committed?.fromDate, committed?.toDate, committed?.accountIds, committed?.interval],
    queryFn: async () => {
      const result = await getPortfolioHistory({
        from_date: committed!.fromDate,
        to_date: committed!.toDate,
        interval: committed!.interval,
        account_ids: committed!.accountIds,
      })
      setLastRunTime(new Date().toLocaleTimeString())
      return result
    },
    enabled: committed !== null,
  })

  const histPoints = history as PortfolioHistoryPoint[]
  const hasMarketPrices = histPoints.some(h => h.total_value_cad !== null)
  const chartData = histPoints.map(h => ({
    date: h.date,
    bookValue:  parseFloat(h.book_value_cad),
    totalValue: h.total_value_cad !== null ? parseFloat(h.total_value_cad) : null,
  }))
  const xTickInterval = chartData.length <= 24 ? 0
    : chartData.length <= 52 ? Math.floor(chartData.length / 12) - 1
    : Math.floor(chartData.length / 10) - 1

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Brokerage</label>
          <select
            value={brokerageFilter}
            onChange={e => setBrokerageFilter(e.target.value)}
            className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Account(s)</label>
          <MultiSelectDropdown
            placeholder="All accounts"
            options={accountOptions}
            selected={selectedAccountIds}
            onChange={ids => setSelectedAccountIds(ids)}
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Range</label>
          <div className="flex gap-1">
            {(['YTD', '1Y', '3Y', '5Y', 'ALL'] as PortfolioRange[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${range === r ? 'bg-primary text-white' : 'bg-accent text-muted-foreground hover:bg-accent'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Interval</label>
          <div className="flex gap-1">
            {(['daily', 'weekly', 'monthly'] as const).map(iv => (
              <button key={iv} onClick={() => setChartInterval(iv)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium capitalize transition-colors ${chartInterval === iv ? 'bg-primary text-white' : 'bg-accent text-muted-foreground hover:bg-accent'}`}>
                {iv[0].toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setCommitted({ fromDate, toDate, accountIds, interval: chartInterval })}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Play className="w-3.5 h-3.5" /> Run
          </button>
          {lastRunTime && <span className="text-xs text-muted-foreground text-center">Last run: {lastRunTime}</span>}
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={handleRebuildSnapshots}
            disabled={rebuildStatus === 'running'}
            title="Purge and regenerate portfolio snapshots for selected accounts. Use this to fix phantom positions."
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors
              ${rebuildStatus === 'running' ? 'bg-accent text-muted-foreground border-border cursor-not-allowed'
              : rebuildStatus === 'done'    ? 'bg-green-50 text-green-600 dark:text-green-400 border-green-300'
              : rebuildStatus === 'error'   ? 'bg-red-50 text-red-700 border-red-300'
              : 'bg-card text-muted-foreground border-border hover:bg-muted/50'}`}
          >
            {rebuildStatus === 'running'
              ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Rebuilding…</>
              : rebuildStatus === 'done'
              ? <><Database className="w-3.5 h-3.5" /> Rebuilt!</>
              : rebuildStatus === 'error'
              ? <><Trash2 className="w-3.5 h-3.5" /> Failed</>
              : <><Database className="w-3.5 h-3.5" /> Rebuild Snapshots</>}
          </button>
          <span className="text-xs text-muted-foreground text-center">Fixes phantom positions</span>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-card rounded-xl border border-border p-5">
        {committed === null ? (
          <div className="h-72 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <p className="text-sm">Configure your filters and click <strong className="text-primary">Run</strong> to generate this report.</p>
          </div>
        ) : isLoading ? (
          <div className="h-72 flex items-center justify-center">
            <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary" />
          </div>
        ) : !hasMarketPrices ? (
          <div className="h-72 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <p className="text-sm">No historical price data for this period.</p>
            <p className="text-xs">Use <strong>Refresh Prices</strong> in the header to populate prices.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-8 h-0.5 bg-primary rounded" /> Total Value
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-8 border-t-2 border-dashed border-border" /> Book Value
              </span>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} interval={xTickInterval}
                  tickFormatter={v => fmtAxisDate(v, chartInterval)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtCADAxis} width={72} />
                <Tooltip
                  formatter={(value: number, name: string) => [fmtCAD0(value), name === 'totalValue' ? 'Total Value' : 'Book Value']}
                  labelFormatter={v => fmtAxisDate(v, chartInterval)}
                />
                <Line type="monotone" dataKey="bookValue"  stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls name="bookValue" />
                <Line type="monotone" dataKey="totalValue" stroke="#3b82f6" strokeWidth={2}   dot={false} connectNulls name="totalValue" />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>
    </div>
  )
}
