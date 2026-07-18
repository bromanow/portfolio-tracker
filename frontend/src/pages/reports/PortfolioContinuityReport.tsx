import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { getAccounts, getPortfolioContinuity } from '../../api/client'
import type { Account } from '../../api/client'
import MultiSelectDropdown from '../../components/MultiSelectDropdown'
import { useAccountCascade, computePortfolioRange, type PortfolioRange, ContinuityTable } from './shared'

// ── Portfolio Continuity ──────────────────────────────────────────────────────

export default function PortfolioContinuityReport() {
  const [range, setRange] = useState<PortfolioRange>('ALL')

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const {
    brokerageFilter, setBrokerageFilter, brokerages,
    accountOptions, selectedAccountIds, setSelectedAccountIds, accountIds,
  } = useAccountCascade(accounts as Account[])

  const { fromDate, toDate } = useMemo(() => computePortfolioRange(range), [range])
  const fromDateStr = fromDate ?? '2000-01-01'

  // Pending (what the user is editing) vs committed (what was last run)
  const [committed, setCommitted] = useState<{
    fromDate: string; toDate: string; accountIds: string | undefined
  } | null>(null)

  const { data: continuity, isLoading } = useQuery({
    queryKey: ['portfolio-continuity', committed?.fromDate, committed?.toDate, committed?.accountIds],
    queryFn: () => getPortfolioContinuity({
      from_date: committed!.fromDate,
      to_date: committed!.toDate,
      account_ids: committed!.accountIds,
    }),
    enabled: committed !== null,
  })

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select
            value={brokerageFilter}
            onChange={e => setBrokerageFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Account(s)</label>
          <MultiSelectDropdown
            placeholder="All accounts"
            options={accountOptions}
            selected={selectedAccountIds}
            onChange={ids => setSelectedAccountIds(ids)}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Range</label>
          <div className="flex gap-1">
            {(['YTD', '1Y', '3Y', '5Y', 'ALL'] as PortfolioRange[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-2.5 py-1.5 text-xs rounded font-medium transition-colors ${range === r ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => setCommitted({ fromDate: fromDateStr, toDate: toDate, accountIds })}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Play className="w-3.5 h-3.5" /> Run
        </button>
      </div>

      {/* Continuity table */}
      {committed === null ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-sm">Configure your filters and click <strong className="text-blue-600">Run</strong> to generate this report.</p>
        </div>
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-blue-600" />
        </div>
      ) : !continuity ? (
        <div className="text-center py-16 text-gray-400">No data for selected period.</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <ContinuityTable data={continuity} />
        </div>
      )}
    </div>
  )
}
