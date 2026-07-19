import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'
import { Loader2, RefreshCw, Database, Pencil, Trash2, Plus, Eye, EyeOff } from 'lucide-react'
import {
  getMyFlexConfig, saveMyFlexConfig, deleteMyFlexConfig, syncMyFlexAccounts, uploadFlexXml,
  getAllFlexConfigs, syncAllFlexAccounts,
} from '../../api/client'
import type { IBKRFlexConfig } from '../../api/client'

// ─── IBKR Flex Query Tab ──────────────────────────────────────────────────────
export default function IBKRFlexTab() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()

  const SYNC_TS_KEY = 'ibkr_sync_started'

  // My config — auto-polls every 3 s while running or shortly after sync triggered
  const { data: myConfig, isLoading: myLoading } = useQuery({
    queryKey: ['ibkr-flex-my-config'],
    queryFn: getMyFlexConfig,
    refetchInterval: (query) => {
      const data = query.state.data as IBKRFlexConfig | null | undefined
      // Keep polling if DB says running
      if (data?.last_sync_status === 'running') return 3000
      // Also keep polling for up to 5 min after a sync was triggered
      // (handles navigation away and back)
      const ts = localStorage.getItem(SYNC_TS_KEY)
      if (ts && Date.now() - Number(ts) < 5 * 60 * 1000) return 3000
      return false
    },
    refetchIntervalInBackground: true,
  })

  // Clear the "waiting" flag once the DB reflects a terminal status
  const prevStatus = myConfig?.last_sync_status
  if (prevStatus === 'ok' || prevStatus === 'error') {
    localStorage.removeItem(SYNC_TS_KEY)
  }

  const [form, setForm] = useState({ query_id: '', token: '', enabled: true })
  const [editing, setEditing] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [uploadResult, setUploadResult] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const xmlInputRef = useRef<HTMLInputElement | null>(null)

  // Derive syncing from DB status + localStorage timestamp (survives navigation)
  const syncPending = (() => {
    if (myConfig?.last_sync_status === 'running') return true
    const ts = localStorage.getItem(SYNC_TS_KEY)
    return !!ts && Date.now() - Number(ts) < 5 * 60 * 1000
  })()

  // Populate form when editing
  const startEdit = () => {
    setForm({ query_id: myConfig?.query_id ?? '', token: '', enabled: myConfig?.enabled ?? true })
    setEditing(true)
  }

  const saveMut = useMutation({
    mutationFn: (data: { query_id: string; token: string; enabled: boolean }) =>
      saveMyFlexConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
      if (isAdmin) qc.invalidateQueries({ queryKey: ['ibkr-flex-configs'] })
      setEditing(false)
    },
  })

  const deleteMut = useMutation({
    mutationFn: deleteMyFlexConfig,
    onSuccess: () => {
      localStorage.removeItem(SYNC_TS_KEY)
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
      if (isAdmin) qc.invalidateQueries({ queryKey: ['ibkr-flex-configs'] })
    },
  })

  const handleSync = async () => {
    setSyncError(null)
    try {
      localStorage.setItem(SYNC_TS_KEY, String(Date.now()))
      await syncMyFlexAccounts()
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
    } catch (e: unknown) {
      localStorage.removeItem(SYNC_TS_KEY)
      setSyncError((e as Error).message ?? 'Sync failed — check your Query ID and token')
    }
  }

  const handleUploadXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadResult(null)
    setUploadError(null)
    try {
      const result = await uploadFlexXml(file)
      setUploadResult(result.message ?? `Imported ${result.imported} transaction(s)`)
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } }; message?: string })
      setUploadError(msg?.response?.data?.detail ?? msg?.message ?? 'Upload failed')
    } finally {
      setUploading(false)
      if (xmlInputRef.current) xmlInputRef.current.value = ''
    }
  }

  // Admin: all configs
  const { data: allConfigs = [] } = useQuery({
    queryKey: ['ibkr-flex-configs'],
    queryFn: getAllFlexConfigs,
    enabled: isAdmin,
  })
  const [adminSyncAll, setAdminSyncAll] = useState(false)

  const handleSyncAll = async () => {
    setAdminSyncAll(true)
    try {
      await syncAllFlexAccounts()
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['ibkr-flex-configs'] })
        setAdminSyncAll(false)
      }, 8000)
    } catch (e: unknown) {
      alert((e as Error).message ?? 'Sync all failed')
      setAdminSyncAll(false)
    }
  }

  const cfg = myConfig as IBKRFlexConfig | null | undefined
  const hasConfig = cfg != null

  return (
    <div className="space-y-6">
      {/* ── My Flex Config ── */}
      <div className="bg-card rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-foreground">My IBKR Flex Query</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              One query covers all your IBKR accounts. Accounts are matched by IBKR account number (set in Admin → Accounts → Acct #).
            </p>
          </div>
          {hasConfig && !editing && (
            <div className="flex flex-col gap-2 items-start">
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={handleSync}
                  disabled={syncPending}
                  className="flex items-center gap-1.5 text-sm bg-primary text-white rounded-lg px-3 py-1.5 hover:bg-primary/90 disabled:opacity-50"
                >
                  {syncPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {syncPending ? 'Syncing…' : 'Sync Now'}
                </button>
                <button
                  onClick={() => xmlInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 text-sm bg-green-600 text-white rounded-lg px-3 py-1.5 hover:bg-green-700 disabled:opacity-50"
                  title="Upload a Flex Query XML file downloaded directly from IBKR — bypasses the API rate limit"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
                  {uploading ? 'Importing…' : 'Upload XML'}
                </button>
                <input
                  ref={xmlInputRef}
                  type="file"
                  accept=".xml"
                  className="bg-background text-foreground hidden"
                  onChange={handleUploadXml}
                />
                <button onClick={startEdit} className="flex items-center gap-1.5 text-sm border border-border rounded-lg px-3 py-1.5 hover:bg-muted/50">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button onClick={() => deleteMut.mutate()} className="flex items-center gap-1.5 text-sm border border-red-200 text-red-600 dark:text-red-400 rounded-lg px-3 py-1.5 hover:bg-red-50">
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
              {syncError && (
                <p className="text-sm text-red-600 dark:text-red-400 max-w-md">
                  {syncError.includes('429')
                    ? 'IBKR limits syncs to once every 10 minutes. The last sync status is shown below — check if it already completed successfully.'
                    : syncError}
                </p>
              )}
              {uploadResult && (
                <p className="text-sm text-emerald-600 dark:text-emerald-400 max-w-md">✓ {uploadResult}</p>
              )}
              {uploadError && (
                <p className="text-sm text-red-600 dark:text-red-400 max-w-md">Upload failed: {uploadError}</p>
              )}
            </div>
          )}
        </div>

        {myLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : !hasConfig && !editing ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">No Flex Query configured yet.</p>
            <button
              onClick={() => { setForm({ query_id: '', token: '', enabled: true }); setEditing(true) }}
              className="flex items-center gap-2 text-sm bg-primary text-white rounded-lg px-4 py-2 hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Add Flex Query
            </button>
          </div>
        ) : editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Query ID</label>
                <input
                  className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm w-full"
                  placeholder="e.g. 1403268"
                  value={form.query_id}
                  onChange={e => setForm(f => ({ ...f, query_id: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  Token {hasConfig && <span className="text-muted-foreground">(leave blank to keep existing)</span>}
                </label>
                <div className="relative">
                  <input
                    className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm w-full pr-9"
                    placeholder={hasConfig ? '(unchanged)' : 'Flex token'}
                    type={showToken ? 'text' : 'password'}
                    value={form.token}
                    onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
                  />
                  <button type="button" onClick={() => setShowToken(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground">
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <button
                  onClick={() => saveMut.mutate({ query_id: form.query_id, token: form.token, enabled: form.enabled })}
                  disabled={saveMut.isPending || !form.query_id || (!form.token && !hasConfig)}
                  className="flex-1 bg-primary text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  Save
                </button>
                {hasConfig && (
                  <button onClick={() => setEditing(false)}
                    className="px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted/50">
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : cfg ? (
          // Config summary card
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Query ID</div>
                <div className="font-mono text-foreground">{cfg.query_id}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Token</div>
                <div className="font-mono text-muted-foreground">{cfg.token_hint}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Last Sync</div>
                <div className="text-foreground">
                  {cfg.last_sync_at
                    ? new Date(cfg.last_sync_at).toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short' })
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Status</div>
                {cfg.last_sync_status === 'ok' ? (
                  <span className="text-emerald-600 dark:text-emerald-400 text-xs">{cfg.last_sync_message}</span>
                ) : cfg.last_sync_status === 'error' ? (
                  <span className="text-red-600 dark:text-red-400 text-xs" title={cfg.last_sync_message ?? ''}>{cfg.last_sync_message}</span>
                ) : cfg.last_sync_status === 'running' ? (
                  <span className="flex items-center gap-1 text-primary text-xs"><Loader2 className="h-3 w-3 animate-spin" /> Running…</span>
                ) : (
                  <span className="text-muted-foreground text-xs">Never synced</span>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Admin: all users' configs ── */}
      {isAdmin && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border">
            <h3 className="font-semibold text-foreground">All Users' Flex Configs</h3>
            <button
              onClick={handleSyncAll}
              disabled={adminSyncAll}
              className="flex items-center gap-2 text-sm bg-primary/10 text-primary border border-primary/20 rounded-lg px-3 py-1.5 hover:bg-primary/15 disabled:opacity-50"
            >
              {adminSyncAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync All Users
            </button>
          </div>
          {(allConfigs as IBKRFlexConfig[]).length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">No configs configured yet.</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 text-left">Query ID</th>
                  <th className="px-4 py-3 text-left">Token</th>
                  <th className="px-4 py-3 text-left">Last Sync</th>
                  <th className="px-4 py-3 text-left">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(allConfigs as IBKRFlexConfig[]).map(c => (
                  <tr key={c.id} className="hover:bg-muted/50">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {c.user_name ?? `User ${c.user_id}`}
                      {!c.enabled && <span className="ml-2 text-xs text-muted-foreground">(disabled)</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.query_id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.token_hint}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {c.last_sync_status === 'ok' && <span className="text-emerald-600 dark:text-emerald-400">{c.last_sync_message}</span>}
                      {c.last_sync_status === 'error' && <span className="text-red-600 dark:text-red-400">{c.last_sync_message}</span>}
                      {c.last_sync_status === 'running' && <span className="text-primary flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Running…</span>}
                      {!c.last_sync_status && <span className="text-muted-foreground">Never</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
