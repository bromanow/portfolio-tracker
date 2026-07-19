import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getAccounts, getPositions, getCashBalances } from '../api/client'
import type { Account, Position, CashBalance } from '../api/client'
import PositionsPanel from '../components/PositionsPanel'
import PortfolioAnalyticsPanel from '../components/PortfolioAnalyticsPanel'
import RiskScoringPanel from '../components/RiskScoringPanel'
import FundamentalsTab from '../components/FundamentalsTab'
import SignalsTab from '../components/SignalsTab'
import Options from './Options'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'
import { useFilterContext } from '../context/FilterContext'

type Tab = 'positions' | 'options' | 'fundamentals' | 'signals'

const TABS: { id: Tab; label: string }[] = [
  { id: 'positions',    label: 'Positions' },
  { id: 'options',      label: 'Options' },
  { id: 'fundamentals', label: 'Fundamentals' },
  { id: 'signals',      label: 'Signals' },
]

export default function Holdings() {
  const { toDate: asOf } = useFilterContext()
  const [activeTab, setActiveTab] = useState<Tab>('positions')

  const { data: rawAccounts = [], isLoading: accountsLoading } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const { data: cashBalances = [] } = useQuery({ queryKey: ['cash-balances', asOf],   queryFn: () => getCashBalances({ as_of: asOf }) })
  const { data: positions    = [] } = useQuery({ queryKey: ['positions', asOf],        queryFn: () => getPositions({ as_of: asOf }) })

  const accounts = rawAccounts as Account[]
  const { effectiveAccountIds, histAccountIds, hasFilter } = usePortfolioFilters(accounts)

  const readyAccountIds: string | null | undefined =
    (accountsLoading && hasFilter) ? null : histAccountIds

  // Filter unconditionally by the non-demo account set (not just when the user has
  // applied a manual filter) — getCashBalances/getPositions return every account the
  // backend authorizes for this user, demo accounts included, so without this, demo
  // cash/positions leak into the page whenever no filter is active (the default state).
  const filteredCash = useMemo(() => {
    if (accountsLoading) return []
    return effectiveAccountIds.size > 0
      ? (cashBalances as CashBalance[]).filter(c => effectiveAccountIds.has(c.account_id))
      : (cashBalances as CashBalance[])
  }, [cashBalances, effectiveAccountIds, accountsLoading])

  const filteredPositions = useMemo(() => {
    if (accountsLoading) return []
    return effectiveAccountIds.size > 0
      ? (positions as Position[]).filter(p => effectiveAccountIds.has(p.account_id))
      : (positions as Position[])
  }, [positions, effectiveAccountIds, accountsLoading])

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Holdings</h1>
        <span className="text-xs text-gray-400">
          {filteredPositions.length} position{filteredPositions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Tab navigation */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-1">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'positions' && (
        <div className="space-y-6">
          <PositionsPanel accountIds={readyAccountIds} cash={filteredCash} asOf={asOf} />
          <PortfolioAnalyticsPanel accountIds={histAccountIds} asOf={asOf} />
          <RiskScoringPanel accountIds={histAccountIds} />
        </div>
      )}

      {activeTab === 'options' && (
        <Options />
      )}

      {activeTab === 'fundamentals' && (
        <FundamentalsTab accountIds={readyAccountIds} asOf={asOf} />
      )}

      {activeTab === 'signals' && (
        <SignalsTab accountIds={readyAccountIds} asOf={asOf} />
      )}
    </div>
  )
}
