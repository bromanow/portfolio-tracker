import { useEffect, useState, useCallback } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { Trash2, Plus, Link2, Loader2 } from 'lucide-react'
import {
  getPlaidStatus, createPlaidLinkToken, exchangePlaidToken, sandboxCreatePlaid,
  getPlaidItems, deletePlaidItem, type PlaidItem,
} from '../api/client'

// Mounts only once a link token exists; auto-opens the Plaid Link widget.
function LinkLauncher({ token, owner, onDone, onExit }: {
  token: string; owner: string; onDone: () => void; onExit: (err: any, meta?: any) => void
}) {
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: async (public_token) => { await exchangePlaidToken(public_token, owner); onDone() },
    // Surface the real Plaid error (code + message + which institution) so a failed
    // connection — e.g. an unsupported product on a Canadian brokerage — is diagnosable.
    onExit: (err, meta) => onExit(err, meta),
  })
  useEffect(() => { if (ready) open() }, [ready, open])
  return null
}

export default function PlaidConnect() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [env, setEnv] = useState('')
  const [items, setItems] = useState<PlaidItem[]>([])
  const [owner, setOwner] = useState('Brian')
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setItems(await getPlaidItems()) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    getPlaidStatus().then(s => { setConfigured(s.configured); setEnv(s.env) }).catch(() => setConfigured(false))
    refresh()
  }, [refresh])

  const startConnect = async () => {
    setError(null); setBusy(true)
    try {
      const { link_token } = await createPlaidLinkToken()
      setLinkToken(link_token)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Could not start Plaid Link')
      setBusy(false)
    }
  }

  const finish = async () => { setLinkToken(null); setBusy(false); await refresh() }

  const simulate = async () => {
    setError(null); setBusy(true)
    try { await sandboxCreatePlaid(owner); await refresh() }
    catch (e: any) { setError(e?.response?.data?.detail ?? 'Sandbox connect failed') }
    finally { setBusy(false) }
  }

  const remove = async (id: number) => {
    if (!confirm('Disconnect this institution? Synced holdings stay; future syncs stop.')) return
    setBusy(true)
    try { await deletePlaidItem(id); await refresh() } finally { setBusy(false) }
  }

  return (
    <div className="bg-white rounded-lg p-4 border border-gray-200 space-y-3">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-blue-600" />
        <h3 className="font-medium text-gray-700">Plaid connections</h3>
        {env && <span className="text-[10px] uppercase tracking-wide bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">{env}</span>}
      </div>
      <p className="text-xs text-gray-400">
        Connect or remove institutions here. To pull the latest holdings, use{' '}
        <strong>Activity → Import → Plaid</strong>.
      </p>

      {configured === false && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Plaid isn't configured. Set <code>PLAID_CLIENT_ID</code> and <code>PLAID_SECRET</code> (and{' '}
          <code>PLAID_ENV=sandbox</code>) in the backend environment, then reload.
        </div>
      )}

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      {configured && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-gray-500">Owner</label>
            <select value={owner} onChange={e => setOwner(e.target.value)}
              className="border border-gray-200 rounded px-2 py-1 text-sm">
              <option>Brian</option>
              <option>Michelle</option>
            </select>
            <button
              onClick={startConnect}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Connect account
            </button>
            {env === 'sandbox' && (
              <button
                onClick={simulate}
                disabled={busy}
                title="Create a fake investment account directly (skips Link's depository-only test banks)"
                className="flex items-center gap-1.5 px-3 py-1.5 border border-blue-300 text-blue-700 text-sm rounded hover:bg-blue-50 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Simulate investment account
              </button>
            )}
          </div>
          {env === 'sandbox' && (
            <p className="text-xs text-gray-400">
              Tip: "Simulate" is the reliable Sandbox path — Plaid Link's test flow only offers
              depository banks. Use the real <strong>Connect account</strong> flow in Production.
            </p>
          )}

          {linkToken && <LinkLauncher token={linkToken} owner={owner} onDone={finish} onExit={(err, meta) => {
            setLinkToken(null); setBusy(false)
            if (err) {
              const inst = meta?.institution?.name ? ` [${meta.institution.name}]` : ''
              setError(`Plaid${inst}: ${err.error_code ?? ''} — ${err.error_message ?? err.display_message ?? 'connection failed'}`)
            }
          }} />}

          {items.length === 0 ? (
            <p className="text-sm text-gray-400">No institutions connected yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 text-left">
                  <th className="py-1">Institution</th><th>Accounts</th><th>Last sync</th><th></th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} className="border-t border-gray-100">
                    <td className="py-1.5 font-medium text-gray-700">{it.institution ?? '—'}</td>
                    <td className="text-gray-500">{it.accounts}</td>
                    <td className="text-gray-500">{it.last_synced_at ? new Date(it.last_synced_at).toLocaleString('en-CA') : '—'}</td>
                    <td className="text-right">
                      <button onClick={() => remove(it.id)} disabled={busy} title="Disconnect"
                        className="text-gray-400 hover:text-red-500 px-1 disabled:opacity-40">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
