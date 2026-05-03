import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import {
  getPriceStatus, refreshAllPrices, getPriceJob, getAccounts,
  getIBKRStatus, connectIBKR, launchIBKRGateway,
  syncIBKRTransactions, getIBKRManagedAccounts,
} from '../api/client'
import type { Account } from '../api/client'
import { RefreshCw, Clock, X, Wifi, WifiOff, Settings, Download, AlertCircle } from 'lucide-react'
import MultiSelectDropdown from './MultiSelectDropdown'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'
import { useFilterContext } from '../context/FilterContext'
import type { TimeRange } from '../context/FilterContext'

// Pages that show portfolio account filters
const ACCOUNT_FILTER_PATHS = new Set(['/dashboard', '/holdings', '/options', '/transactions'])
// Pages that also show time range controls
const TIME_RANGE_PATHS = new Set(['/dashboard', '/holdings'])

function usePriceAge(liveLastUpdated: string | null) {
  if (!liveLastUpdated) return { label: 'Never', colorClass: 'text-red-500', isStale: true }
  const updatedAt = new Date(liveLastUpdated + 'Z')
  const diffMs = Date.now() - updatedAt.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHr  = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)
  let label: string
  if (diffMin < 1)   label = 'Just now'
  else if (diffMin < 60)  label = `${diffMin}m ago`
  else if (diffHr < 24)  label = `${diffHr}h ago`
  else                   label = `${diffDays}d ago`
  const isStale = diffHr >= 4
  const colorClass = diffMin < 60 ? 'text-emerald-600' : diffHr < 4 ? 'text-yellow-600' : 'text-red-500'
  return { label, colorClass, isStale }
}

// ── IBKR Connect Modal ────────────────────────────────────────────────────────
function IBKRModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ['ibkr-status'],
    queryFn: getIBKRStatus,
    refetchInterval: 3000,   // poll so gateway_running updates after launch
  })

  const [host, setHost] = useState(status?.host ?? '127.0.0.1')
  const [port, setPort] = useState(status?.port ?? 7497)
  const [clientId, setClientId] = useState(status?.client_id ?? 10)
  const [result, setResult] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)
  const [launching, setLaunching] = useState(false)

  // Sync transactions state
  const [syncJobId, setSyncJobId] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{
    imported: number; skipped: number; errors: string[]; unmatched_accounts: string[]
  } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  // IB managed accounts discovery
  const [showManagedAccts, setShowManagedAccts] = useState(false)
  const { data: managedAccts, isFetching: fetchingAccts } = useQuery({
    queryKey: ['ibkr-managed-accounts'],
    queryFn: getIBKRManagedAccounts,
    enabled: showManagedAccts,
    staleTime: 60_000,
  })

  const syncMut = useMutation({
    mutationFn: syncIBKRTransactions,
    onSuccess: (data) => {
      if (data.job_id) setSyncJobId(data.job_id)
      setSyncError(null)
    },
    onError: (err: any) => {
      setSyncError(err?.response?.data?.detail ?? 'Sync failed')
    },
  })

  // Poll sync job until done
  const { data: syncJob } = useQuery({
    queryKey: ['ibkr-sync-job', syncJobId],
    queryFn: () => getPriceJob(syncJobId!),
    enabled: !!syncJobId,
    refetchInterval: (q) => {
      const d = q.state.data
      return !d || d.status === 'running' ? 2000 : false
    },
  })
  useEffect(() => {
    if (!syncJob) return
    if (syncJob.status === 'done') {
      setSyncJobId(null)
      setSyncResult(syncJob.result as any)
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
    } else if (syncJob.status === 'error') {
      setSyncJobId(null)
      setSyncError(syncJob.result as any)
    }
  }, [syncJob?.status])

  const connectMut = useMutation({
    mutationFn: () => connectIBKR({ host, port, client_id: clientId }),
    onSuccess: (data) => {
      setResult(`✓ ${data.message}${data.tws_version ? ` (TWS v${data.tws_version})` : ''}`)
      setIsError(false)
      qc.invalidateQueries({ queryKey: ['ibkr-status'] })
    },
    onError: (err: any) => {
      setResult(err?.response?.data?.detail ?? 'Connection failed')
      setIsError(true)
    },
  })

  const launchMut = useMutation({
    mutationFn: launchIBKRGateway,
    onSuccess: (data) => {
      setLaunching(true)
      setResult(`IB Gateway is launching… wait ~20 seconds for it to finish loading, then click Test & Save.`)
      setIsError(false)
      // Poll until gateway_running flips to true
      const poll = setInterval(() => {
        refetchStatus().then(r => {
          if (r.data?.gateway_running) {
            clearInterval(poll)
            setLaunching(false)
            setResult('✓ IB Gateway is running — click Test & Save to connect.')
          }
        })
      }, 3000)
      // Stop polling after 60 seconds regardless
      setTimeout(() => { clearInterval(poll); setLaunching(false) }, 60_000)
    },
    onError: (err: any) => {
      setResult(err?.response?.data?.detail ?? 'Could not launch IB Gateway')
      setIsError(true)
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Wifi className="h-4 w-4 text-blue-600" />
            Connect to TWS / IB Gateway
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Gateway running status */}
        <div className={`flex items-center justify-between rounded-lg px-3 py-2 mb-4 text-xs ${
          status?.gateway_running
            ? 'bg-emerald-50 text-emerald-700'
            : 'bg-gray-50 text-gray-500'
        }`}>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full flex-shrink-0 ${status?.gateway_running ? 'bg-emerald-500' : 'bg-gray-300'}`} />
            <span>
              {status?.gateway_running
                ? 'IB Gateway is running'
                : 'IB Gateway is not running'}
            </span>
            {status?.gateway_app_path && !status.gateway_running && (
              <span className="text-gray-400 truncate max-w-[180px]" title={status.gateway_app_path}>
                ({status.gateway_app_path.split('/').pop()})
              </span>
            )}
          </div>
          {!status?.gateway_running && status?.gateway_app_path && (
            <button
              onClick={() => launchMut.mutate()}
              disabled={launchMut.isPending || launching}
              className="ml-3 flex-shrink-0 flex items-center gap-1 px-2.5 py-1 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {(launchMut.isPending || launching) && <RefreshCw className="h-3 w-3 animate-spin" />}
              {launching ? 'Launching…' : 'Launch'}
            </button>
          )}
        </div>

        <div className="space-y-3 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Host</label>
            <input
              type="text"
              value={host}
              onChange={e => setHost(e.target.value)}
              className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
              placeholder="127.0.0.1"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Port <span className="font-normal text-gray-400">(TWS: 7497 · Gateway: 4001)</span>
              </label>
              <input
                type="number"
                value={port}
                onChange={e => setPort(Number(e.target.value))}
                className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
              />
            </div>
            <div className="w-28">
              <label className="block text-xs font-medium text-gray-600 mb-1">Client ID</label>
              <input
                type="number"
                value={clientId}
                onChange={e => setClientId(Number(e.target.value))}
                className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
              />
            </div>
          </div>
        </div>

        {result && (
          <div className={`text-xs rounded px-3 py-2 mb-3 ${isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
            {result}
          </div>
        )}

        {!status?.available && (
          <div className="text-xs rounded px-3 py-2 mb-3 bg-amber-50 text-amber-700">
            ib_insync is not installed on the server. Run: <span className="font-mono">pip install ib_insync</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-600 hover:text-gray-800">
            Cancel
          </button>
          <button
            onClick={() => connectMut.mutate()}
            disabled={connectMut.isPending || !status?.available}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {connectMut.isPending && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
            {connectMut.isPending ? 'Testing…' : 'Test & Save'}
          </button>
        </div>

        {/* Last refresh info */}
        {status?.last_refresh_at && (
          <div className="mt-4 pt-4 border-t border-gray-100 text-xs text-gray-400 space-y-0.5">
            <div>Last price refresh: {new Date(status.last_refresh_at + 'Z').toLocaleString()}</div>
            {status.last_refresh_result && (
              <div>
                Result: {status.last_refresh_result.ok} ok
                {status.last_refresh_result.failed > 0 && `, ${status.last_refresh_result.failed} failed`}
                {status.last_refresh_result.skipped > 0 && `, ${status.last_refresh_result.skipped} skipped`}
              </div>
            )}
          </div>
        )}

        {/* ── IB Account Numbers ── */}
        {status?.last_connected_at && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-gray-700">IB Account Numbers</div>
              <button
                onClick={() => setShowManagedAccts(v => !v)}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                {showManagedAccts ? 'Hide' : 'Show'}
              </button>
            </div>
            {showManagedAccts && (
              <div className="mt-2">
                {fetchingAccts ? (
                  <div className="text-xs text-gray-400 flex items-center gap-1">
                    <RefreshCw className="h-3 w-3 animate-spin" /> Loading…
                  </div>
                ) : managedAccts?.ok ? (
                  <div className="space-y-1">
                    <div className="text-xs text-gray-400 mb-1.5">
                      Set these in Admin → Accounts → Account Number to enable transaction sync.
                    </div>
                    {managedAccts.accounts.map(acct => (
                      <div key={acct} className="font-mono text-xs bg-gray-100 rounded px-2 py-1 text-gray-700">
                        {acct}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-red-600">{managedAccts?.error ?? 'Could not load accounts'}</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Sync Transactions ── */}
        {status?.last_connected_at && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-xs font-medium text-gray-700">Sync Transactions</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  Imports today's executions from IB Gateway into the transactions table.
                </div>
              </div>
              <button
                onClick={() => { setSyncResult(null); setSyncError(null); syncMut.mutate() }}
                disabled={syncMut.isPending || !!syncJobId}
                className="ml-4 flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium"
              >
                {(syncMut.isPending || !!syncJobId)
                  ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Syncing…</>
                  : <><Download className="h-3.5 w-3.5" /> Sync Now</>
                }
              </button>
            </div>

            {/* Sync result */}
            {syncResult && (
              <div className="text-xs rounded-lg bg-gray-50 px-3 py-2 space-y-1">
                <div className="font-medium text-gray-700">
                  {syncResult.imported > 0
                    ? `✓ ${syncResult.imported} transaction${syncResult.imported !== 1 ? 's' : ''} imported`
                    : '✓ No new transactions'
                  }
                  {syncResult.skipped > 0 && `, ${syncResult.skipped} already imported`}
                </div>
                {syncResult.unmatched_accounts.length > 0 && (
                  <div className="flex items-start gap-1.5 text-amber-700 bg-amber-50 rounded px-2 py-1.5">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium">Unmatched IB accounts:</div>
                      <div className="font-mono">{syncResult.unmatched_accounts.join(', ')}</div>
                      <div className="mt-0.5 text-amber-600">
                        Set these account numbers in Admin → Accounts → Account Number field.
                      </div>
                    </div>
                  </div>
                )}
                {syncResult.errors.length > 0 && (
                  <div className="text-red-600">
                    Errors: {syncResult.errors.slice(0, 3).join('; ')}
                  </div>
                )}
              </div>
            )}
            {syncError && (
              <div className="text-xs text-red-600 bg-red-50 rounded px-3 py-2">{syncError}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Header ───────────────────────────────────────────────────────────────
export default function Header() {
  const location = useLocation()
  const showAccountFilters = ACCOUNT_FILTER_PATHS.has(location.pathname)
  const showTimeRange      = TIME_RANGE_PATHS.has(location.pathname)

  const qc = useQueryClient()
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [showIBKRModal, setShowIBKRModal] = useState(false)

  // Account filter state (global)
  const { data: rawAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const accounts = rawAccounts as Account[]
  const {
    filterBrokerages, setFilterBrokerages,
    filterAccountTypes, setFilterAccountTypes,
    filterAccounts, setFilterAccounts,
    brokerages, accountTypes, accountOptions,
    hasFilter, clearFilters,
  } = usePortfolioFilters(accounts)

  // Time range state (global)
  const {
    timeRange, setTimeRange,
    customFrom, setCustomFrom,
    customTo, setCustomTo,
    fromDate, toDate,
  } = useFilterContext()

  const displayFrom = timeRange === 'CUSTOM' ? customFrom : (fromDate ?? '')
  const displayTo   = timeRange === 'CUSTOM' ? customTo   : toDate

  // Price refresh (smart: IBKR first if configured, then yfinance/TMX)
  const { data: status } = useQuery({
    queryKey: ['price-status'], queryFn: getPriceStatus,
    refetchInterval: 60_000, staleTime: 30_000,
  })
  const refreshMut = useMutation({
    mutationFn: refreshAllPrices,
    onSuccess: (data) => { const jobId = data.job_id ?? data.id; if (jobId) setActiveJobId(jobId) },
  })

  // IBKR status (for badge + modal only — refresh goes through the unified endpoint)
  const { data: ibkrStatus } = useQuery({
    queryKey: ['ibkr-status'],
    queryFn: getIBKRStatus,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const ibkrConfigured = !!(ibkrStatus?.available && ibkrStatus?.last_connected_at)

  // Shared job poller (works for both yfinance and IBKR jobs)
  const { data: jobData } = useQuery({
    queryKey: ['price-job', activeJobId],
    queryFn: () => getPriceJob(activeJobId!),
    enabled: !!activeJobId,
    refetchInterval: (q) => { const d = q.state.data; return !d || d.status === 'running' ? 2000 : false },
  })
  useEffect(() => {
    if (!jobData) return
    if (jobData.status === 'done' || jobData.status === 'error') {
      if (jobData.status === 'done') {
        qc.invalidateQueries({ queryKey: ['price-status'] })
        qc.invalidateQueries({ queryKey: ['price-report'] })
        qc.invalidateQueries({ queryKey: ['positions'] })
        qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
        qc.invalidateQueries({ queryKey: ['cash-balances'] })
        qc.invalidateQueries({ queryKey: ['portfolio-history'] })
        qc.invalidateQueries({ queryKey: ['portfolio-continuity'] })
        qc.invalidateQueries({ queryKey: ['options'] })
        qc.invalidateQueries({ queryKey: ['ibkr-status'] })
      }
      setActiveJobId(null)
    }
  }, [jobData?.status])

  const isBusy = refreshMut.isPending || (!!activeJobId && jobData?.status === 'running')
  const isDone = !activeJobId && refreshMut.isSuccess
  const isErr  = refreshMut.isError || jobData?.status === 'error'
  const { label, colorClass, isStale } = usePriceAge(status?.live_last_updated ?? null)

  return (
    <>
      <header className="bg-white border-b border-gray-200 flex items-center flex-wrap px-4 py-2 gap-x-3 gap-y-2 shrink-0">

        {/* ── Account filters ── */}
        {showAccountFilters && (
          <div className="flex items-center gap-2 shrink-0">
            <MultiSelectDropdown
              placeholder="All Brokerages"
              options={brokerages.map(b => ({ value: b, label: b }))}
              selected={filterBrokerages}
              onChange={vals => { setFilterBrokerages(vals); setFilterAccounts([]) }}
            />
            <MultiSelectDropdown
              placeholder="All Types"
              options={accountTypes.map(t => ({ value: t, label: t }))}
              selected={filterAccountTypes}
              onChange={vals => { setFilterAccountTypes(vals); setFilterAccounts([]) }}
            />
            <MultiSelectDropdown
              placeholder="All Accounts"
              options={accountOptions}
              selected={filterAccounts}
              onChange={setFilterAccounts}
              disabled={accountOptions.length === 0}
            />
            {hasFilter && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
                title="Clear account filters"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        )}

        {/* ── Time range (Dashboard + Holdings) ── */}
        {showTimeRange && (
          <>
            {showAccountFilters && <span className="text-gray-200 select-none shrink-0">|</span>}
            <div className="flex items-center gap-2 shrink-0">
              {/* Preset buttons */}
              <div className="flex gap-1">
                {(['YTD', '1Y', '3Y', '5Y', 'ALL'] as TimeRange[]).map(r => (
                  <button
                    key={r}
                    onClick={() => setTimeRange(r)}
                    className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                      timeRange === r ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {/* Custom date inputs */}
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={displayFrom}
                  onChange={e => setCustomFrom(e.target.value)}
                  className={`border rounded px-2 py-1 text-xs text-gray-600 w-30 ${timeRange === 'CUSTOM' ? 'border-blue-400' : 'border-gray-200'}`}
                />
                <span className="text-gray-400 text-xs">→</span>
                <input
                  type="date"
                  value={displayTo}
                  onChange={e => setCustomTo(e.target.value)}
                  className={`border rounded px-2 py-1 text-xs text-gray-600 w-30 ${timeRange === 'CUSTOM' ? 'border-blue-400' : 'border-gray-200'}`}
                />
              </div>
            </div>
          </>
        )}

        {/* ── Right: IBKR status + price status + refresh buttons ── */}
        <div className="flex items-center gap-3 ml-auto shrink-0">

          {/* IBKR status badge */}
          {ibkrStatus?.available && (
            <button
              onClick={() => setShowIBKRModal(true)}
              className="flex items-center gap-1.5 text-xs group"
              title={ibkrConfigured ? 'IBKR connected — click to configure' : 'Click to configure IBKR connection'}
            >
              {ibkrConfigured
                ? <Wifi className="h-3.5 w-3.5 text-emerald-500" />
                : <WifiOff className="h-3.5 w-3.5 text-gray-300" />}
              <span className={ibkrConfigured ? 'text-emerald-600 font-medium' : 'text-gray-400'}>
                IB
              </span>
              <Settings className="h-3 w-3 text-gray-300 group-hover:text-gray-500 transition-colors" />
            </button>
          )}

          {/* Price age */}
          <div className={`flex items-center gap-1.5 text-xs ${colorClass}`}>
            <Clock className="h-3.5 w-3.5" />
            <span>Prices: <span className="font-medium">{label}</span></span>
            {status?.history_last_date && (
              <span className="text-gray-400 ml-1">· history to {status.history_last_date}</span>
            )}
          </div>

          {/* Single smart refresh button */}
          <button
            onClick={() => refreshMut.mutate()}
            disabled={isBusy}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-medium transition-colors disabled:opacity-50 ${
              isStale ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
            title={ibkrConfigured ? 'Refresh prices — IBKR first, then yfinance/TMX for the rest' : 'Refresh prices via yfinance / TMX'}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`} />
            {isBusy ? 'Refreshing…' : 'Refresh Prices'}
            {ibkrConfigured && !isBusy && (
              <span className="flex items-center gap-0.5 ml-0.5 opacity-70">
                <Wifi className="h-3 w-3" />
              </span>
            )}
          </button>

          {isDone && <span className="text-xs text-emerald-600">✓ Updated</span>}
          {isErr  && <span className="text-xs text-red-500">Failed — try again</span>}
        </div>
      </header>

      {showIBKRModal && <IBKRModal onClose={() => setShowIBKRModal(false)} />}
    </>
  )
}
