import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, AlertTriangle, CheckCircle, ChevronRight, Loader2 } from 'lucide-react'
import { getImportStatus, type ImportStatusRow } from '../api/client'

type LoaderTab = 'csv' | 'flex' | 'plaid' | 'statement' | 'manual'

const SOURCE_TAB: Record<string, LoaderTab> = {
  'Plaid': 'plaid',
  'IBKR Flex': 'flex',
  'Statement': 'statement',
  'CSV': 'csv',
  'Manual': 'manual',
}

const SOURCE_BADGE: Record<string, string> = {
  'Plaid': 'bg-emerald-50 text-emerald-700',
  'IBKR Flex': 'bg-indigo-50 text-indigo-700',
  'Statement': 'bg-blue-50 text-blue-700',
  'CSV': 'bg-amber-50 text-amber-700',
  'Manual': 'bg-gray-100 text-gray-600',
}

function ageLabel(iso: string | null): string {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${(days / 365).toFixed(1)}y ago`
}

export default function ImportStatusPanel({ onGo }: { onGo: (tab: LoaderTab) => void }) {
  const [rows, setRows] = useState<ImportStatusRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => { setLoading(true); getImportStatus().then(setRows).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [])

  const groups = useMemo(() => {
    const m = new Map<string, ImportStatusRow[]>()
    for (const r of rows) { if (!m.has(r.brokerage)) m.set(r.brokerage, []); m.get(r.brokerage)!.push(r) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  const staleCount = rows.filter(r => r.stale).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-800">Data status</h2>
          <p className="text-sm text-gray-500">
            {loading ? 'Loading…' : staleCount > 0
              ? <>{staleCount} account{staleCount > 1 ? 's' : ''} need attention — sorted to the top.</>
              : 'All accounts are up to date.'}
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {groups.map(([brokerage, accts]) => (
        <div key={brokerage} className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-700">{brokerage}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 border-b border-gray-100">
                <th className="text-left font-medium px-4 py-2">Account</th>
                <th className="text-left font-medium px-3 py-2">Source</th>
                <th className="text-left font-medium px-3 py-2">Last loaded</th>
                <th className="text-left font-medium px-3 py-2">Latest txn</th>
                <th className="text-right font-medium px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {accts.map(r => (
                <tr key={r.account_id} className={`border-b border-gray-50 last:border-0 ${r.stale ? 'bg-red-50/40' : ''}`}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      {r.stale
                        ? <AlertTriangle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
                        : <CheckCircle className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />}
                      <span className="text-gray-800">{r.account}</span>
                      <span className="text-xs text-gray-400">{r.owner}</span>
                    </div>
                    {r.note && <div className="text-xs text-red-500 ml-5 mt-0.5">{r.note}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${SOURCE_BADGE[r.source] || 'bg-gray-100 text-gray-600'}`}>{r.source}</span>
                  </td>
                  <td className={`px-3 py-2 ${r.stale ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
                    {ageLabel(r.last_loaded)}
                    {r.last_loaded && <span className="text-gray-300 text-xs"> · {r.last_loaded}</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {r.latest_txn ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => onGo(SOURCE_TAB[r.source] ?? 'csv')}
                      className="inline-flex items-center gap-0.5 text-xs text-blue-600 hover:underline">
                      {r.source === 'Plaid' || r.source === 'IBKR Flex' ? 'Sync' : 'Load'} <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {!loading && rows.length === 0 && (
        <div className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="h-4 w-4" /> No accounts yet.</div>
      )}
    </div>
  )
}
