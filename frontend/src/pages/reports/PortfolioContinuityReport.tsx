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
        <button
          onClick={() => setCommitted({ fromDate: fromDateStr, toDate: toDate, accountIds })}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Play className="w-3.5 h-3.5" /> Run
        </button>
      </div>

      {/* Continuity table */}
      {committed === null ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">Configure your filters and click <strong className="text-primary">Run</strong> to generate this report.</p>
        </div>
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-primary" />
        </div>
      ) : !continuity ? (
        <div className="text-center py-16 text-muted-foreground">No data for selected period.</div>
      ) : (
        <div className="bg-card border border-border rounded-xl p-6">
          <ContinuityTable data={continuity} />
        </div>
      )}
    </div>
  )
}
