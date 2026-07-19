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
  'IBKR Flex': 'bg-primary/10 text-primary',
  'Statement': 'bg-primary/10 text-primary',
  'CSV': 'bg-amber-50 text-amber-700',
  'Manual': 'bg-accent text-muted-foreground',
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
          <h2 className="font-semibold text-foreground">Data status</h2>
          <p className="text-sm text-muted-foreground">
            {loading ? 'Loading…' : staleCount > 0
              ? <>{staleCount} account{staleCount > 1 ? 's' : ''} need attention — sorted to the top.</>
              : 'All accounts are up to date.'}
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground border border-border rounded hover:bg-muted/50 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {groups.map(([brokerage, accts]) => (
        <div key={brokerage} className="border border-border rounded-lg overflow-hidden">
          <div className="bg-muted/50 px-4 py-2 text-sm font-semibold text-foreground">{brokerage}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border">
                <th className="text-left font-medium px-4 py-2">Account</th>
                <th className="text-left font-medium px-3 py-2">Source</th>
                <th className="text-left font-medium px-3 py-2">Last loaded</th>
                <th className="text-left font-medium px-3 py-2">Latest txn</th>
                <th className="text-right font-medium px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {accts.map(r => (
                <tr key={r.account_id} className={`border-b border-border last:border-0 ${r.stale ? 'bg-red-50/40' : ''}`}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      {r.stale
                        ? <AlertTriangle className="h-3.5 w-3.5 text-red-500 dark:text-red-400 flex-shrink-0" />
                        : <CheckCircle className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />}
                      <span className="text-foreground">{r.account}</span>
                      <span className="text-xs text-muted-foreground">{r.owner}</span>
                    </div>
                    {r.note && <div className="text-xs text-red-500 dark:text-red-400 ml-5 mt-0.5">{r.note}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${SOURCE_BADGE[r.source] || 'bg-accent text-muted-foreground'}`}>{r.source}</span>
                  </td>
                  <td className={`px-3 py-2 ${r.stale ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground'}`}>
                    {ageLabel(r.last_loaded)}
                    {r.last_loaded && <span className="text-muted-foreground/50 text-xs"> · {r.last_loaded}</span>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.latest_txn ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => onGo(SOURCE_TAB[r.source] ?? 'csv')}
                      className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">
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
        <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4" /> No accounts yet.</div>
      )}
    </div>
  )
}
