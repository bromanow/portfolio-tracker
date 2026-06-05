import { useState } from 'react'
import Transactions from './Transactions'
import Import from './Import'

type Tab = 'transactions' | 'import'

export default function Activity() {
  const [tab, setTab] = useState<Tab>('transactions')

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-1">
          <button
            onClick={() => setTab('transactions')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'transactions'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Transactions
          </button>
          {/* Import is desktop-only — hide on mobile */}
          <button
            onClick={() => setTab('import')}
            className={`hidden md:block px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'import'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            Import
          </button>
        </nav>
      </div>

      {/* Content */}
      {tab === 'transactions' && <Transactions />}
      {tab === 'import' && <Import />}
    </div>
  )
}
