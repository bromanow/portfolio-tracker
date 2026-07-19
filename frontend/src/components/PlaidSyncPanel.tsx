import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, Loader2, Link2 } from 'lucide-react'
import {
  getPlaidStatus, getPlaidItems, syncAllPlaid, syncPlaidItem, type PlaidItem,
} from '../api/client'

// Data-pull only. Connecting / disconnecting institutions lives in Admin → Plaid (setup).
export default function PlaidSyncPanel() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [items, setItems] = useState<PlaidItem[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setItems(await getPlaidItems()) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    getPlaidStatus().then(s => setConfigured(s.configured)).catch(() => setConfigured(false))
    refresh()
  }, [refresh])

  const syncAll = async () => {
    setBusy(true); setError(null); setResult(null)
    try {
      const r: any = await syncAllPlaid()
      const parts = (r.items || []).map((it: any) =>
        it.error ? `${it.item_id}: ${it.error}` : `${it.accounts} account(s), ${it.holdings} holdings`)
      setResult(parts.join(' · ') || 'Synced')
      await refresh()
    } catch (e: any) { setError(e?.response?.data?.detail ?? 'Sync failed') }
    finally { setBusy(false) }
  }

  const syncOne = async (id: number) => {
    setBusy(true); setError(null); setResult(null)
    try { await syncPlaidItem(id); await refresh() }
    catch (e: any) { setError(e?.response?.data?.detail ?? 'Sync failed') }
    finally { setBusy(false) }
  }

  if (configured === false) {
    return (
      <div className="bg-card rounded-lg border border-border p-4 text-sm text-muted-foreground">
        Plaid isn't set up yet. Connect an institution in <strong>Admin → Plaid</strong>.
      </div>
    )
  }

  return (
    <div className="bg-card rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          <h2 className="font-semibold text-foreground">Plaid sync</h2>
        </div>
        <button
          onClick={syncAll}
          disabled={busy || items.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-sm rounded hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Sync all
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Pulls the latest holdings from your connected institutions. No login or 2FA needed —
        Plaid keeps the connection alive. Connect or remove institutions in <strong>Admin → Plaid</strong>.
      </p>

      {error && <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
      {result && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">{result}</div>}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No connected institutions yet — add one in Admin → Plaid.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground text-left">
              <th className="py-1">Institution</th><th>Accounts</th><th>Last sync</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id} className="border-t border-border">
                <td className="py-1.5 font-medium text-foreground">{it.institution ?? '—'}</td>
                <td className="text-muted-foreground">{it.accounts}</td>
                <td className="text-muted-foreground">{it.last_synced_at ? new Date(it.last_synced_at).toLocaleString('en-CA') : '—'}</td>
                <td className="text-right">
                  <button onClick={() => syncOne(it.id)} disabled={busy} title="Sync this one"
                    className="text-muted-foreground hover:text-primary disabled:opacity-40">
                    <RefreshCw className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
