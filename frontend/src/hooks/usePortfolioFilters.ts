import { useMemo } from 'react'
import type { Account } from '../api/client'
import { useFilterContext } from '../context/FilterContext'

/**
 * Derives computed filter values from the global FilterContext.
 * All pages (Dashboard, Holdings, Options, Transactions) call this hook
 * to get consistent account filtering without duplicating logic.
 *
 * The raw filter state (filterBrokerages etc.) lives in FilterContext so it
 * persists across navigation. This hook is pure computation on top of that state.
 */
export function usePortfolioFilters(accounts: Account[]) {
  const ctx = useFilterContext()
  const { filterBrokerages, filterAccountTypes, filterAccounts } = ctx

  const brokerages = useMemo(
    () => [...new Set(accounts.map(a => a.brokerage_name).filter(Boolean))].sort(),
    [accounts],
  )

  const accountTypes = useMemo(
    () => [...new Set(accounts.map(a => a.account_type).filter(Boolean))].sort(),
    [accounts],
  )

  // Account picker options narrowed by current brokerage + type selections
  const accountOptions = useMemo(
    () =>
      accounts
        .filter(
          a =>
            (!filterBrokerages.length || filterBrokerages.includes(a.brokerage_name)) &&
            (!filterAccountTypes.length || filterAccountTypes.includes(a.account_type)),
        )
        .map(a => ({ value: String(a.id), label: a.name })),
    [accounts, filterBrokerages, filterAccountTypes],
  )

  // Full set of account IDs that pass all active filters
  const effectiveAccountIds = useMemo(() => {
    let ids = accounts.map(a => a.id)
    if (filterBrokerages.length)
      ids = ids.filter(id => {
        const a = accounts.find(x => x.id === id)
        return a && filterBrokerages.includes(a.brokerage_name)
      })
    if (filterAccountTypes.length)
      ids = ids.filter(id => {
        const a = accounts.find(x => x.id === id)
        return a && filterAccountTypes.includes(a.account_type)
      })
    if (filterAccounts.length)
      ids = ids.filter(id => filterAccounts.includes(String(id)))
    return new Set(ids)
  }, [accounts, filterBrokerages, filterAccountTypes, filterAccounts])

  const hasFilter =
    filterBrokerages.length > 0 || filterAccountTypes.length > 0 || filterAccounts.length > 0

  // Comma-separated IDs for API params; undefined means "all accounts"
  const histAccountIds = useMemo(() => {
    if (effectiveAccountIds.size === accounts.length) return undefined
    return [...effectiveAccountIds].join(',')
  }, [effectiveAccountIds, accounts])

  return {
    // Re-export context state + actions so callers only need one hook
    ...ctx,
    // Computed
    brokerages,
    accountTypes,
    accountOptions,
    effectiveAccountIds,
    histAccountIds,
    hasFilter,
  }
}
