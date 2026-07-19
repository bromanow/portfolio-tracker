import { useState } from 'react'
import Transactions from './Transactions'
import Import from './Import'

type Tab = 'transactions' | 'import'

export default function Activity() {
  const [tab, setTab] = useState<Tab>('transactions')

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="border-b border-border">
        <nav className="-mb-px flex gap-1">
          <button
            onClick={() => setTab('transactions')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'transactions'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            Transactions
          </button>
          {/* Import is desktop-only — hide on mobile */}
          <button
            onClick={() => setTab('import')}
            className={`hidden md:block px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'import'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
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
