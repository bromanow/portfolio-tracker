import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Loader2, Power, RotateCcw, Database, Zap } from 'lucide-react'
import {
  getSchedulerStatus, runSchedulerNow,
  getSystemHealth, restartBackend, getDbStats, optimizeDb,
  computeSnapshots, getSnapshotFreshness, getPortfolioJob,
} from '../../api/client'
import type { DbStats } from '../../api/client'

// ─── System Tab ───────────────────────────────────────────────────────────────
type RestartStatus = 'idle' | 'restarting' | 'online' | 'error'

function SchedulerSection() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['scheduler-status'],
    queryFn: getSchedulerStatus,
    refetchInterval: 15_000,
  })
  const [running, setRunning] = useState(false)
  const runNow = async () => {
    setRunning(true)
    try { await runSchedulerNow() } finally {
      // Poll the log a few times so the user sees results land.
      setTimeout(() => { refetch(); setRunning(false) }, 3000)
    }
  }
  const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">Scheduled Jobs</h3>
        </div>
        <button
          onClick={runNow}
          disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Run nightly jobs now
        </button>
      </div>
      <p className="text-xs text-muted-foreground">Nightly: Bank of Canada FX → Plaid → IBKR Flex → snapshot recompute → view refresh.</p>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-2 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground font-medium">Next runs</div>
        <div className="divide-y divide-border/60">
          {(data?.jobs ?? []).map(j => (
            <div key={j.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-foreground">{j.name}</span>
              <span className="text-xs text-muted-foreground">{fmtTime(j.next_run)}</span>
            </div>
          ))}
          {(data?.jobs ?? []).length === 0 && <div className="px-4 py-2 text-sm text-muted-foreground">No jobs scheduled.</div>}
        </div>
        <div className="px-4 py-2 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground font-medium border-t border-border flex items-center justify-between">
          <span>Recent runs</span>
          {isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="divide-y divide-border/60 max-h-72 overflow-y-auto">
          {(data?.log ?? []).map((r, i) => (
            <div key={i} className="flex items-start gap-2 px-4 py-2 text-sm">
              <span className={`mt-1 h-2 w-2 rounded-full flex-shrink-0 ${r.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{r.name}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtTime(r.at)}</span>
                </div>
                <div className="text-xs text-muted-foreground break-words">{r.detail}</div>
              </div>
            </div>
          ))}
          {(data?.log ?? []).length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">No runs recorded yet (since last restart).</div>}
        </div>
      </div>
    </div>
  )
}

export default function SystemTab() {
  const queryClient = useQueryClient()
  const [restartStatus, setRestartStatus] = useState<RestartStatus>('idle')
  const [lastChecked, setLastChecked] = useState<string | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeMsg, setOptimizeMsg] = useState<string | null>(null)

  // Manual snapshot recompute (post-deploy / ops). Day-to-day this happens automatically
  // (nightly job + on-load when the Performance page detects stale data); this button is
  // the escape hatch for forcing a full rebuild after a code change that alters snapshot
  // output without new transactions/prices.
  const [recomputing, setRecomputing] = useState(false)
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null)
  const { data: freshness, refetch: refetchFreshness } = useQuery({
    queryKey: ['snapshot-freshness'],
    queryFn: getSnapshotFreshness,
    refetchInterval: 60_000,
  })
  const handleRecomputeSnapshots = async () => {
    setRecomputing(true)
    setRecomputeMsg(null)
    try {
      const { job_id } = await computeSnapshots()
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(async () => {
          try {
            const job = await getPortfolioJob(job_id)
            if (job.status === 'done' || job.status === 'failed') {
              clearInterval(poll)
              if (job.status === 'failed') reject(new Error(job.error || 'recompute failed'))
              else resolve()
            }
          } catch (e) { clearInterval(poll); reject(e) }
        }, 2000)
      })
      setRecomputeMsg('Snapshots rebuilt.')
      refetchFreshness()
      queryClient.invalidateQueries({ queryKey: ['perf-timeline'] })
      queryClient.invalidateQueries({ queryKey: ['perf-returns'] })
    } catch (e: any) {
      setRecomputeMsg(e?.message || 'Recompute failed.')
    } finally {
      setRecomputing(false)
    }
  }

  const { data: health, refetch: recheckHealth } = useQuery({
    queryKey: ['system-health'],
    queryFn: getSystemHealth,
    refetchInterval: 30_000,
  })

  const handleRestart = async () => {
    setRestartStatus('restarting')
    try {
      await restartBackend()
    } catch {
      // Connection drop is expected as the server restarts
    }
    // Poll /api/system/health until the backend comes back up
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        await getSystemHealth()
        setRestartStatus('online')
        setLastChecked(new Date().toLocaleTimeString())
        queryClient.invalidateQueries()
        return
      } catch {
        // Still restarting — keep polling
      }
    }
    setRestartStatus('error')
  }

  const handleReload = () => window.location.reload()

  const { data: dbStats, refetch: refetchDbStats } = useQuery<DbStats>({
    queryKey: ['db-stats'],
    queryFn: getDbStats,
    staleTime: 60_000,
  })

  const handleOptimize = async () => {
    setOptimizing(true)
    setOptimizeMsg(null)
    try {
      const result = await optimizeDb()
      setOptimizeMsg(result.message)
      refetchDbStats()
    } catch {
      setOptimizeMsg('Optimize failed — check backend logs.')
    } finally {
      setOptimizing(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-foreground">System Controls</h2>
        <p className="text-sm text-muted-foreground mt-1">Restart the backend server after updates, or reload the page to clear cached data.</p>
      </div>

      {/* Status card */}
      <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-4">
        <div className={`h-3 w-3 rounded-full flex-shrink-0 ${
          restartStatus === 'restarting' ? 'bg-yellow-400 animate-pulse' :
          restartStatus === 'error'      ? 'bg-red-500' :
          health                         ? 'bg-emerald-500' : 'bg-muted-foreground/30'
        }`} />
        <div>
          <p className="font-medium text-foreground">
            {restartStatus === 'restarting' ? 'Restarting backend…' :
             restartStatus === 'error'      ? 'Backend did not come back — check the terminal' :
             restartStatus === 'online'     ? `Backend restarted successfully` :
             health                         ? 'Backend is running' : 'Checking…'}
          </p>
          {restartStatus === 'online' && lastChecked && (
            <p className="text-xs text-muted-foreground">Came back online at {lastChecked}</p>
          )}
          {health && restartStatus === 'idle' && (
            <p className="text-xs text-muted-foreground">Last checked {new Date(health.timestamp).toLocaleTimeString()}</p>
          )}
        </div>
        <button
          onClick={() => { recheckHealth(); setRestartStatus('idle') }}
          className="ml-auto text-xs text-muted-foreground hover:text-muted-foreground flex items-center gap-1"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh status
        </button>
      </div>

      {/* Action cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Restart backend */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Power className="h-5 w-5 text-muted-foreground" />
            <h3 className="font-semibold text-foreground">Restart Backend</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Restart the backend service — it will be back online in a few seconds. Useful
            after changing environment variables or if the server is misbehaving.
          </p>
          <button
            onClick={handleRestart}
            disabled={restartStatus === 'restarting'}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gray-700 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {restartStatus === 'restarting'
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Restarting…</>
              : <><Power className="h-4 w-4" /> Restart Backend</>}
          </button>
        </div>

        {/* Reload page */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-muted-foreground" />
            <h3 className="font-semibold text-foreground">Reload Page</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Clear all cached data and reload the app — useful if charts or tables look out of date.
          </p>
          <button
            onClick={handleReload}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gray-700 text-white text-sm font-medium hover:bg-gray-800 transition-colors"
          >
            <RotateCcw className="h-4 w-4" /> Reload Page
          </button>
        </div>

      </div>

      {/* Portfolio snapshots section */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">Portfolio Snapshots</h3>
        </div>
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <p className="text-sm text-muted-foreground">
            Snapshots rebuild automatically — nightly, and on-demand when the Performance page
            detects new data. Use this only to force a full rebuild after a code change that
            alters snapshot output without new transactions or prices.
          </p>
          {freshness && (
            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>Latest snapshot: <strong className="text-foreground">{freshness.latest_snapshot_date ?? '—'}</strong></span>
              <span>Latest price: <strong className="text-foreground">{freshness.latest_price_date ?? '—'}</strong></span>
              <span className={freshness.stale ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>
                {freshness.stale ? 'Stale — rebuild recommended' : 'Up to date'}
              </span>
            </div>
          )}
          {recomputeMsg && (
            <p className="text-xs text-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">{recomputeMsg}</p>
          )}
          <button
            onClick={handleRecomputeSnapshots}
            disabled={recomputing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${recomputing ? 'animate-spin' : ''}`} />
            {recomputing ? 'Recomputing…' : 'Recompute All Snapshots'}
          </button>
        </div>
      </div>

      {/* Scheduled jobs section */}
      <SchedulerSection />

      {/* Database section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-foreground">Database</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetchDbStats()}
              className="text-xs text-muted-foreground hover:text-muted-foreground flex items-center gap-1"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button
              onClick={handleOptimize}
              disabled={optimizing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {optimizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {optimizing ? 'Optimizing…' : 'Optimize DB'}
            </button>
          </div>
        </div>

        {optimizeMsg && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {optimizeMsg}
          </div>
        )}

        {dbStats && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            {/* Row counts */}
            <div className="px-4 py-2.5 border-b border-border bg-muted/50">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Table Row Counts</p>
            </div>
            <div className="divide-y divide-border/60">
              {Object.entries(dbStats.row_counts).map(([table, count]) => (
                <div key={table} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted-foreground font-mono text-xs">{table}</span>
                  <span className="font-medium text-foreground">{count?.toLocaleString() ?? '—'}</span>
                </div>
              ))}
            </div>

            {/* DB size */}
            <div className="px-4 py-2.5 border-t border-border bg-muted/50 flex items-center justify-between text-xs text-muted-foreground">
              <span>DB size: <strong className="text-foreground">{dbStats.db_size_mb} MB</strong></span>
              <span>Page: <strong className="text-foreground">{(dbStats.page_size / 1024).toFixed(0)} KB</strong></span>
              <span>Freelist: <strong className="text-foreground">{dbStats.freelist_count}</strong></span>
            </div>

            {/* Index status */}
            <div className="px-4 py-2.5 border-t border-border bg-muted/50">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Index Status</p>
            </div>
            <div className="divide-y divide-border/60">
              {dbStats.index_status.map(idx => (
                <div key={idx.name} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${idx.present ? 'bg-emerald-500' : 'bg-red-400'}`} />
                  <span className="font-mono text-xs text-muted-foreground flex-1">{idx.name}</span>
                  <span className={`text-xs font-medium ${idx.present ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                    {idx.present ? 'OK' : 'Missing'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
