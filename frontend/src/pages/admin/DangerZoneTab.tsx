import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, AlertTriangle, X } from 'lucide-react'
import { getAccounts, deleteAllTransactions, deleteAllImports } from '../../api/client'
import type { Account } from '../../api/client'
import { ConfirmDialog } from './shared'

// ─── Danger Zone Tab ──────────────────────────────────────────────────────────
export default function DangerZoneTab() {
  const qc = useQueryClient()
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts', 'admin'], queryFn: () => getAccounts(true) })
  const [confirm, setConfirm] = useState<{
    type: 'all-transactions' | 'account-transactions' | 'all-imports'
    accountId?: number
    accountName?: string
  } | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const deleteAllTxnsMut = useMutation({
    mutationFn: () => deleteAllTransactions(confirm?.accountId),
    onSuccess: (data: { deleted_count: number }) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
      setResult(`✅ Deleted ${data.deleted_count} transactions`)
      setConfirm(null)
    },
  })

  const deleteAllImportsMut = useMutation({
    mutationFn: deleteAllImports,
    onSuccess: (data: { batches_deleted: number; rows_deleted: number }) => {
      qc.invalidateQueries({ queryKey: ['imports'] })
      setResult(`✅ Deleted ${data.batches_deleted} import batches and ${data.rows_deleted} raw rows`)
      setConfirm(null)
    },
  })

  return (
    <div className="space-y-6">
      {confirm && (
        <ConfirmDialog
          title={
            confirm.type === 'all-transactions' ? 'Delete ALL Transactions' :
            confirm.type === 'account-transactions' ? `Delete All Transactions for ${confirm.accountName}` :
            'Delete All Import History'
          }
          message={
            confirm.type === 'all-transactions'
              ? 'This will permanently delete EVERY transaction across all accounts. All positions, P&L, and import history references will be lost. This cannot be undone.'
              : confirm.type === 'account-transactions'
              ? `This will delete all transactions for account "${confirm.accountName}". This cannot be undone.`
              : 'This will delete all import batches and raw transaction rows. Committed transactions are NOT affected — only the import log is cleared.'
          }
          confirmLabel={confirm.type === 'all-transactions' ? 'Delete Everything' : 'Confirm Delete'}
          requireTyping={confirm.type === 'all-transactions' ? 'DELETE ALL' : undefined}
          onConfirm={() => {
            if (confirm.type === 'all-imports') deleteAllImportsMut.mutate()
            else deleteAllTxnsMut.mutate()
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-start gap-2 mb-3">
          <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-red-800">Danger Zone</h3>
            <p className="text-sm text-red-700 mt-1">These actions are irreversible. Use them to reset test data before loading real data.</p>
          </div>
        </div>
      </div>

      {result && (
        <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-700 flex justify-between">
          <span>{result}</span>
          <button onClick={() => setResult(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="space-y-4">
        {/* Delete all transactions */}
        <div className="border border-red-200 rounded-lg p-4 bg-white">
          <h4 className="font-medium text-gray-800 mb-1">Delete All Transactions</h4>
          <p className="text-sm text-gray-500 mb-3">Removes every transaction from every account. Use to reset before loading real data.</p>
          <button
            onClick={() => setConfirm({ type: 'all-transactions' })}
            className="bg-red-600 text-white text-sm px-4 py-2 rounded hover:bg-red-700 flex items-center gap-2"
          >
            <Trash2 className="h-4 w-4" /> Delete All Transactions
          </button>
        </div>

        {/* Delete transactions by account */}
        <div className="border border-orange-200 rounded-lg p-4 bg-white">
          <h4 className="font-medium text-gray-800 mb-1">Delete Transactions for One Account</h4>
          <p className="text-sm text-gray-500 mb-3">Removes all transactions for a specific account only.</p>
          <div className="flex gap-3 items-center">
            <select className="border rounded px-3 py-1.5 text-sm flex-1 max-w-xs" id="danger-account">
              <option value="">Select account…</option>
              {(accounts as Account[]).map(a => <option key={a.id} value={`${a.id}|${a.name}`}>{a.name}</option>)}
            </select>
            <button
              onClick={() => {
                const sel = (document.getElementById('danger-account') as HTMLSelectElement).value
                if (!sel) return
                const [id, name] = sel.split('|')
                setConfirm({ type: 'account-transactions', accountId: Number(id), accountName: name })
              }}
              className="bg-orange-600 text-white text-sm px-4 py-2 rounded hover:bg-orange-700 flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" /> Delete Account Transactions
            </button>
          </div>
        </div>

        {/* Delete all imports */}
        <div className="border border-yellow-200 rounded-lg p-4 bg-white">
          <h4 className="font-medium text-gray-800 mb-1">Clear Import History</h4>
          <p className="text-sm text-gray-500 mb-3">Deletes all import batches and raw rows. Does NOT delete committed transactions.</p>
          <button
            onClick={() => setConfirm({ type: 'all-imports' })}
            className="bg-yellow-600 text-white text-sm px-4 py-2 rounded hover:bg-yellow-700 flex items-center gap-2"
          >
            <Trash2 className="h-4 w-4" /> Clear Import History
          </button>
        </div>
      </div>
    </div>
  )
}
