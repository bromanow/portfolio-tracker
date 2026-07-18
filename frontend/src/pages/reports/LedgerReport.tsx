import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { getAccounts } from '../../api/client'
import type { Account } from '../../api/client'
import Transactions from '../Transactions'

export default function LedgerReport() {
  const { data: rawAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const accounts = rawAccounts as Account[]
  const queryClient = useQueryClient()

  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [accountId, setAccountId] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    await queryClient.invalidateQueries({ queryKey: ['transactions'] })
    setRefreshing(false)
  }

  const brokerages = useMemo(
    () => [...new Set(accounts.map(a => a.brokerage_name).filter(Boolean))].sort(),
    [accounts],
  )

  const filteredAccounts = useMemo(
    () => brokerageFilter ? accounts.filter(a => a.brokerage_name === brokerageFilter) : accounts,
    [accounts, brokerageFilter],
  )

  const accountIdsParam = useMemo(() => {
    if (accountId) return accountId
    if (brokerageFilter) return filteredAccounts.map(a => a.id).join(',')
    return undefined
  }, [accountId, brokerageFilter, filteredAccounts])

  const handleBrokerageChange = (b: string) => {
    setBrokerageFilter(b)
    setAccountId('')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 whitespace-nowrap">Brokerage:</label>
          <select
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            value={brokerageFilter}
            onChange={e => handleBrokerageChange(e.target.value)}
          >
            <option value="">All</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 whitespace-nowrap">Account:</label>
          <select
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            value={accountId}
            onChange={e => setAccountId(e.target.value)}
          >
            <option value="">All{brokerageFilter ? ' (filtered)' : ''}</option>
            {filteredAccounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
          </select>
        </div>
        {(brokerageFilter || accountId) && (
          <button
            onClick={() => { setBrokerageFilter(''); setAccountId('') }}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Clear
          </button>
        )}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 text-gray-600 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      <Transactions showHeader={false} accountIds={accountIdsParam} />
    </div>
  )
}
