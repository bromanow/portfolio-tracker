import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import {
  getPriceStatus, refreshAllPrices, getPriceJob, getAccounts,
} from '../api/client'
import type { Account } from '../api/client'
import { RefreshCw, Clock, X } from 'lucide-react'
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

// ── Main Header ───────────────────────────────────────────────────────────────
export default function Header() {
  const location = useLocation()
  const showAccountFilters = ACCOUNT_FILTER_PATHS.has(location.pathname)
  const showTimeRange      = TIME_RANGE_PATHS.has(location.pathname)

  const qc = useQueryClient()
  const [activeJobId, setActiveJobId] = useState<string | null>(null)

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

  // Price refresh
  const { data: status } = useQuery({
    queryKey: ['price-status'], queryFn: getPriceStatus,
    refetchInterval: 60_000, staleTime: 30_000,
  })
  const refreshMut = useMutation({
    mutationFn: refreshAllPrices,
    onSuccess: (data) => { const jobId = data.job_id ?? data.id; if (jobId) setActiveJobId(jobId) },
  })

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
      }
      setActiveJobId(null)
    }
  }, [jobData?.status])

  const isBusy = refreshMut.isPending || (!!activeJobId && jobData?.status === 'running')
  const isDone = !activeJobId && refreshMut.isSuccess
  const isErr  = refreshMut.isError || jobData?.status === 'error'
  const { label, colorClass, isStale } = usePriceAge(status?.live_last_updated ?? null)

  return (
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

      {/* ── Right: price status + refresh button ── */}
      <div className="flex items-center gap-3 ml-auto shrink-0">

        {/* Price age */}
        <div className={`flex items-center gap-1.5 text-xs ${colorClass}`}>
          <Clock className="h-3.5 w-3.5" />
          <span>Prices: <span className="font-medium">{label}</span></span>
          {status?.history_last_date && (
            <span className="text-gray-400 ml-1">· history to {status.history_last_date}</span>
          )}
        </div>

        {/* Refresh button */}
        <button
          onClick={() => refreshMut.mutate()}
          disabled={isBusy}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-medium transition-colors disabled:opacity-50 ${
            isStale ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
          title="Refresh prices via yfinance / TMX"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`} />
          {isBusy ? 'Refreshing…' : 'Refresh Prices'}
        </button>

        {isDone && <span className="text-xs text-emerald-600">✓ Updated</span>}
        {isErr  && <span className="text-xs text-red-500">Failed — try again</span>}
      </div>
    </header>
  )
}
