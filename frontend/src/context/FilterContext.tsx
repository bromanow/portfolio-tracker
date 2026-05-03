import { createContext, useContext, useMemo, useState, useCallback } from 'react'

export type TimeRange = 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL' | 'CUSTOM'
export type ChartInterval = 'daily' | 'weekly' | 'monthly'

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export function computeDateRange(
  range: TimeRange,
  customFrom: string,
  customTo: string,
): { fromDate: string | undefined; toDate: string } {
  const today = new Date()
  const toStr = todayStr()
  if (range === 'CUSTOM') return { fromDate: customFrom || undefined, toDate: customTo || toStr }
  if (range === 'ALL')    return { fromDate: undefined, toDate: toStr }
  if (range === 'YTD')   return { fromDate: `${today.getFullYear()}-01-01`, toDate: toStr }
  const years = range === '1Y' ? 1 : range === '3Y' ? 3 : 5
  const d = new Date(today)
  d.setFullYear(d.getFullYear() - years)
  return { fromDate: d.toISOString().slice(0, 10), toDate: toStr }
}

interface FilterContextValue {
  // ── Account filters ────────────────────────────────────────────────────────
  filterBrokerages: string[]
  setFilterBrokerages: (v: string[]) => void
  filterAccountTypes: string[]
  setFilterAccountTypes: (v: string[]) => void
  filterAccounts: string[]
  setFilterAccounts: (v: string[]) => void
  clearFilters: () => void

  // ── Time range ─────────────────────────────────────────────────────────────
  timeRange: TimeRange
  setTimeRange: (r: TimeRange) => void
  customFrom: string
  setCustomFrom: (d: string) => void
  customTo: string
  setCustomTo: (d: string) => void
  // computed
  fromDate: string | undefined
  toDate: string
}

const FilterContext = createContext<FilterContextValue>({
  filterBrokerages: [], setFilterBrokerages: () => {},
  filterAccountTypes: [], setFilterAccountTypes: () => {},
  filterAccounts: [], setFilterAccounts: () => {},
  clearFilters: () => {},
  timeRange: 'YTD', setTimeRange: () => {},
  customFrom: '', setCustomFrom: () => {},
  customTo: todayStr(), setCustomTo: () => {},
  fromDate: undefined, toDate: todayStr(),
})

export function FilterProvider({ children }: { children: React.ReactNode }) {
  // ── Account filter state ───────────────────────────────────────────────────
  const [filterBrokerages,   setFilterBrokerages]   = useState<string[]>([])
  const [filterAccountTypes, setFilterAccountTypes] = useState<string[]>([])
  const [filterAccounts,     setFilterAccounts]     = useState<string[]>([])

  // ── Time range state ───────────────────────────────────────────────────────
  const [timeRange,   setTimeRange]   = useState<TimeRange>('YTD')
  const [customFrom,  setCustomFromRaw] = useState('')
  const [customTo,    setCustomToRaw]   = useState(todayStr)

  const setCustomFrom = useCallback((d: string) => {
    setCustomFromRaw(d)
    setTimeRange('CUSTOM')
  }, [])

  const setCustomTo = useCallback((d: string) => {
    setCustomToRaw(d)
    setTimeRange('CUSTOM')
  }, [])

  const clearFilters = useCallback(() => {
    setFilterBrokerages([])
    setFilterAccountTypes([])
    setFilterAccounts([])
  }, [])

  const { fromDate, toDate } = useMemo(
    () => computeDateRange(timeRange, customFrom, customTo),
    [timeRange, customFrom, customTo],
  )

  return (
    <FilterContext.Provider value={{
      filterBrokerages, setFilterBrokerages,
      filterAccountTypes, setFilterAccountTypes,
      filterAccounts, setFilterAccounts,
      clearFilters,
      timeRange, setTimeRange,
      customFrom, setCustomFrom,
      customTo, setCustomTo,
      fromDate, toDate,
    }}>
      {children}
    </FilterContext.Provider>
  )
}

export const useFilterContext = () => useContext(FilterContext)
