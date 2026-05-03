import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAccounts, getPositions, getCashBalances } from '../api/client'
import type { Account, Position, CashBalance } from '../api/client'
import PositionsPanel from '../components/PositionsPanel'
import PortfolioAnalyticsPanel from '../components/PortfolioAnalyticsPanel'
import RiskScoringPanel from '../components/RiskScoringPanel'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'
import { useFilterContext } from '../context/FilterContext'

export default function Holdings() {
  const { toDate: asOf } = useFilterContext()

  const { data: rawAccounts = [], isLoading: accountsLoading } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const { data: cashBalances = [] } = useQuery({ queryKey: ['cash-balances', asOf],   queryFn: () => getCashBalances({ as_of: asOf }) })
  const { data: positions    = [] } = useQuery({ queryKey: ['positions', asOf],        queryFn: () => getPositions({ as_of: asOf }) })

  const accounts = rawAccounts as Account[]
  const { effectiveAccountIds, histAccountIds, hasFilter } = usePortfolioFilters(accounts)

  // When filters are active and accounts are still loading, pass null to PositionsPanel
  // so it defers its query until the correct account filter is known. This prevents
  // firing two queries (undefined → all, then filtered) in a fresh tab.
  const readyAccountIds: string | null | undefined =
    (accountsLoading && hasFilter) ? null : histAccountIds

  const filteredCash = useMemo(() =>
    hasFilter
      ? (cashBalances as CashBalance[]).filter(c => effectiveAccountIds.has(c.account_id))
      : (cashBalances as CashBalance[])
  , [cashBalances, effectiveAccountIds, hasFilter])

  const filteredPositions = useMemo(() =>
    hasFilter
      ? (positions as Position[]).filter(p => effectiveAccountIds.has(p.account_id))
      : (positions as Position[])
  , [positions, effectiveAccountIds, hasFilter])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Holdings</h1>
        <span className="text-xs text-gray-400">
          {filteredPositions.length} position{filteredPositions.length !== 1 ? 's' : ''}
        </span>
      </div>

      <PositionsPanel accountIds={readyAccountIds} cash={filteredCash} asOf={asOf} />
      <PortfolioAnalyticsPanel accountIds={histAccountIds} asOf={asOf} />
      <RiskScoringPanel accountIds={histAccountIds} />
    </div>
  )
}
