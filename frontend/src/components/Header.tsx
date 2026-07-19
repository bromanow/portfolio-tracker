import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import {
  getPriceStatus, refreshAllPrices, getPriceJob, getAccounts, getScannerMeta,
} from '../api/client'
import type { Account } from '../api/client'
import { RefreshCw, Clock, X, SlidersHorizontal, LogOut, Eye, EyeOff } from 'lucide-react'
import MultiSelectDropdown from './MultiSelectDropdown'
import DatePicker from './DatePicker'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'
import { useFilterContext } from '../context/FilterContext'
import type { TimeRange } from '../context/FilterContext'
import { useAuth } from '../context/AuthContext'
import { getPref, usePreference } from '../hooks/usePreference'

// Pages that show portfolio account filters
const ACCOUNT_FILTER_PATHS = new Set(['/dashboard', '/holdings', '/activity'])
// Pages that also show time range controls
const TIME_RANGE_PATHS = new Set(['/dashboard', '/holdings'])

function usePriceAge(liveLastUpdated: string | null) {
  if (!liveLastUpdated) return { label: 'Never', colorClass: 'text-red-500 dark:text-red-400', isStale: true }
  const updatedAt = new Date(liveLastUpdated + 'Z')
  const diffMs = Date.now() - updatedAt.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHr  = Math.floor(diffMs / 3_600_000)
  const diffDays = Math.floor(diffMs / 86_400_000)
  let label: string
  if (diffMin < 1)        label = 'Just now'
  else if (diffMin < 60)  label = `${diffMin}m ago`
  else if (diffHr < 24)   label = `${diffHr}h ago`
  else                    label = `${diffDays}d ago`
  const isStale = diffHr >= 4
  const colorClass = diffMin < 60 ? 'text-emerald-600 dark:text-emerald-400' : diffHr < 4 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-500 dark:text-red-400'
  return { label, colorClass, isStale }
}

// ── Page title map for mobile header ─────────────────────────────────────────
const PAGE_TITLES: Record<string, string> = {
  '/dashboard':   'Net Worth',
  '/holdings':    'Securities',
  '/performance': 'Performance & Reports',
  '/activity':    'Activity',
  '/scanner':     'Research',
  '/admin':       'Admin',
  '/prices':      'Prices',
}

// ── Main Header ───────────────────────────────────────────────────────────────
export default function Header() {
  const location = useLocation()
  const { user, logout } = useAuth()
  const showAccountFilters = ACCOUNT_FILTER_PATHS.has(location.pathname)
  const showTimeRange      = TIME_RANGE_PATHS.has(location.pathname)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [hideValues, setHideValues] = usePreference('hideValues')

  const qc = useQueryClient()
  const [activeJobId, setActiveJobId] = useState<string | null>(null)

  // Account filter state (global)
  const { data: rawAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
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

  // IBeam connection status
  const { data: scannerMeta } = useQuery({
    queryKey: ['scanner-meta'],
    queryFn: getScannerMeta,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const ibeamConnected = scannerMeta?.ibeam_available === true

  // Price refresh
  const { data: status } = useQuery({
    queryKey: ['price-status'], queryFn: getPriceStatus,
    refetchInterval: 60_000, staleTime: 30_000,
  })
  const refreshMut = useMutation({
    mutationFn: refreshAllPrices,
    onSuccess: (data) => { const jobId = data.job_id ?? data.id; if (jobId) setActiveJobId(jobId) },
  })

  // "Refresh prices on login" preference (My Account) — drives the SAME button/mutation as a
  // manual click, so it shows up as the header button spinning/"Refreshing…" rather than a
  // separate indicator. Fires once per login (Header unmounts on logout, so `fired` resets
  // naturally on the next login).
  const loginRefreshFired = useRef(false)
  useEffect(() => {
    if (!user || loginRefreshFired.current) return
    loginRefreshFired.current = true
    if (getPref('refreshOnLogin')) refreshMut.mutate()
  }, [user])

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

  // Close filter sheet on route change
  useEffect(() => { setFilterSheetOpen(false) }, [location.pathname])

  const pageTitle = Object.entries(PAGE_TITLES).find(([p]) => location.pathname.startsWith(p))?.[1] ?? ''
  const activeFilterCount = filterBrokerages.length + filterAccountTypes.length + filterAccounts.length

  return (
    <>
      {/* ── Desktop header ── */}
      <header className="hidden md:flex bg-card border-b border-border items-center flex-wrap px-4 py-2 gap-x-3 gap-y-2 shrink-0">

        {/* Account filters */}
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
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                title="Clear account filters"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        )}

        {/* Time range */}
        {showTimeRange && (
          <>
            {showAccountFilters && <span className="text-border select-none shrink-0">|</span>}
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex gap-1">
                {(['YTD', '1Y', '3Y', '5Y', 'ALL'] as TimeRange[]).map(r => (
                  <button
                    key={r}
                    onClick={() => setTimeRange(r)}
                    className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
                      timeRange === r ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground hover:bg-accent/70'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <DatePicker value={displayFrom || ''} onChange={setCustomFrom}
                  min="2000-01-01" max={new Date().toISOString().slice(0, 10)}
                  placeholder="From" highlight={timeRange === 'CUSTOM'} />
                <span className="text-muted-foreground text-xs">→</span>
                <DatePicker value={displayTo || ''} onChange={setCustomTo}
                  min="2000-01-01" max={new Date().toISOString().slice(0, 10)}
                  placeholder="To" highlight={timeRange === 'CUSTOM'} />
              </div>
            </div>
          </>
        )}

        {/* Right: price status + refresh */}
        <div className="flex items-center gap-3 ml-auto shrink-0">
          <button
            onClick={() => setHideValues(!hideValues)}
            title={hideValues ? 'Show portfolio values' : 'Hide portfolio values'}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg font-medium transition-colors ${
              hideValues ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'bg-accent text-muted-foreground hover:bg-accent/70'
            }`}
          >
            {hideValues ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <div
            title={ibeamConnected ? 'IBeam connected — live data available' : 'IBeam not connected'}
            className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full border ${
              ibeamConnected
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                : 'bg-accent text-muted-foreground border-border'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${ibeamConnected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
            IBKR
          </div>
          <div className={`flex items-center gap-1.5 text-xs ${colorClass}`}>
            <Clock className="h-3.5 w-3.5" />
            <span>Prices: <span className="font-medium">{label}</span></span>
            {status?.history_last_date && (
              <span className="text-muted-foreground ml-1">· history to {status.history_last_date}</span>
            )}
          </div>
          <button
            onClick={() => refreshMut.mutate()}
            disabled={isBusy}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-medium transition-colors disabled:opacity-50 ${
              isStale ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-accent text-muted-foreground hover:bg-accent/70'
            }`}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`} />
            {isBusy ? 'Refreshing…' : 'Refresh Prices'}
          </button>
          {isDone && <span className="text-xs text-emerald-600 dark:text-emerald-400">✓ Updated</span>}
          {isErr  && <span className="text-xs text-destructive">Failed — try again</span>}
        </div>
      </header>

      {/* ── Mobile header ── */}
      <header className="md:hidden bg-card border-b border-border flex items-center px-4 py-3 gap-3 shrink-0">
        {/* Page title */}
        <h1 className="flex-1 text-base font-semibold text-foreground">{pageTitle}</h1>

        {/* Hide/show portfolio values */}
        <button
          onClick={() => setHideValues(!hideValues)}
          title={hideValues ? 'Show portfolio values' : 'Hide portfolio values'}
          className={`p-1.5 rounded-lg ${hideValues ? 'text-primary' : 'text-muted-foreground'} hover:bg-accent`}
        >
          {hideValues ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>

        {/* Price refresh icon */}
        <button
          onClick={() => refreshMut.mutate()}
          disabled={isBusy}
          title="Refresh prices"
          className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin text-primary' : isStale ? 'text-primary' : ''}`} />
        </button>

        {/* Filter icon — only on pages with filters */}
        {showAccountFilters && (
          <button
            onClick={() => setFilterSheetOpen(true)}
            className="relative p-1.5 rounded-lg text-muted-foreground hover:bg-accent"
            title="Filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {activeFilterCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                {activeFilterCount}
              </span>
            )}
          </button>
        )}

        {/* Sign out */}
        <button
          onClick={logout}
          title="Sign out"
          className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent active:bg-accent/70"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      {/* ── Mobile filter bottom sheet ── */}
      {filterSheetOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end" onClick={() => setFilterSheetOpen(false)}>
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" />

          {/* Sheet */}
          <div
            className="relative bg-card rounded-t-2xl p-5 space-y-4 pb-10"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">Filters</h2>
              <button onClick={() => setFilterSheetOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Account filters */}
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Brokerage</label>
                <MultiSelectDropdown
                  placeholder="All Brokerages"
                  options={brokerages.map(b => ({ value: b, label: b }))}
                  selected={filterBrokerages}
                  onChange={vals => { setFilterBrokerages(vals); setFilterAccounts([]) }}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Account Type</label>
                <MultiSelectDropdown
                  placeholder="All Types"
                  options={accountTypes.map(t => ({ value: t, label: t }))}
                  selected={filterAccountTypes}
                  onChange={vals => { setFilterAccountTypes(vals); setFilterAccounts([]) }}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Account</label>
                <MultiSelectDropdown
                  placeholder="All Accounts"
                  options={accountOptions}
                  selected={filterAccounts}
                  onChange={setFilterAccounts}
                  disabled={accountOptions.length === 0}
                />
              </div>
            </div>

            {/* Time range — shown on Dashboard + Holdings */}
            {showTimeRange && (
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 block">Time Range</label>
                <div className="flex gap-1.5 flex-wrap">
                  {(['YTD', '1Y', '3Y', '5Y', 'ALL'] as TimeRange[]).map(r => (
                    <button
                      key={r}
                      onClick={() => setTimeRange(r)}
                      className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
                        timeRange === r ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <DatePicker value={displayFrom || ''} onChange={setCustomFrom}
                    min="2000-01-01" max={new Date().toISOString().slice(0, 10)}
                    placeholder="From" highlight={timeRange === 'CUSTOM'} />
                  <span className="text-muted-foreground text-sm">→</span>
                  <DatePicker value={displayTo || ''} onChange={setCustomTo}
                    min="2000-01-01" max={new Date().toISOString().slice(0, 10)}
                    placeholder="To" highlight={timeRange === 'CUSTOM'} />
                </div>
              </div>
            )}

            {/* Clear + Apply */}
            <div className="flex gap-3 pt-1">
              {hasFilter && (
                <button
                  onClick={() => { clearFilters(); setFilterSheetOpen(false) }}
                  className="flex-1 py-2.5 border border-border rounded-xl text-sm font-medium text-muted-foreground"
                >
                  Clear filters
                </button>
              )}
              <button
                onClick={() => setFilterSheetOpen(false)}
                className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
