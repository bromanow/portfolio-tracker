import { useState, useCallback, useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import PlaidSyncPanel from '../components/PlaidSyncPanel'
import StatementImportPanel from '../components/StatementImportPanel'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getImports, getAccounts, getSecurities, uploadFile, getImportPreview,
  commitImport, rejectImport, deleteImport, deleteAllImports, updateRawRow, remapImportTypes,
  checkImportDuplicates,
  getMyFlexConfig, syncMyFlexAccounts, uploadFlexXml, saveMyFlexConfig, deleteMyFlexConfig,
  createTransaction,
} from '../api/client'
import type { ImportBatch, Account, Security, IBKRFlexConfig, FlexConfigIn, ImportDetail, Transaction } from '../api/client'
import {
  Upload, CheckCircle, XCircle, AlertCircle, Eye, Trash2,
  AlertTriangle, Edit2, X, SkipForward, RotateCcw, RefreshCw,
  ChevronDown, ChevronRight, Database, Loader2, Plus,
} from 'lucide-react'

const STATUS_COLORS: Record<string, string> = {
  PENDING:   'bg-yellow-100 text-yellow-800',
  COMMITTED: 'bg-green-100 text-green-800',
  REJECTED:  'bg-red-100 text-red-800',
}
const ROW_STATUS_BADGE: Record<string, string> = {
  PENDING:  'bg-yellow-200 text-yellow-800',
  IMPORTED: 'bg-green-200 text-green-800',
  ERROR:    'bg-red-200 text-red-800',
  SKIPPED:  'bg-gray-200 text-gray-600',
}
const ROW_BG: Record<string, string> = {
  PENDING:  '',
  IMPORTED: 'bg-green-50/40',
  ERROR:    'bg-red-50/40',
  SKIPPED:  'bg-gray-50/60 opacity-60',
}

function getRowBg(row: RawRow): string {
  if (row.status === 'PENDING' && row.error_message === 'Duplicate transaction') return 'bg-orange-50/50'
  return ROW_BG[row.status] || ''
}

const ALL_TX_TYPES = [
  'BUY','SELL','DIVIDEND','DRIP','RETURN_OF_CAPITAL',
  'OPTION_BUY','OPTION_SELL','OPTION_EXPIRY','OPTION_ASSIGNMENT','OPTION_EXERCISE',
  'TRANSFER_IN','TRANSFER_OUT','JOURNAL','FX_CONVERSION','FX_ADJUSTMENT',
  'SPLIT','FORWARD_SPLIT','REVERSE_SPLIT','INTEREST','FEE','DEPOSIT','WITHDRAWAL',
  'CASH_OPENING','OPENING_BALANCE','ADJUSTMENT','OTHER',
]

interface RawRow {
  id: number
  row_number: number
  parsed_date: string | null
  raw_data: Record<string, unknown>
  status: string
  error_message: string | null
  resolved_account_id?: number | null
  resolved_account_name?: string | null
}

interface EditFields {
  transaction_date: string
  transaction_type: string
  ticker: string
  account_id: string
  quantity: string
  price: string
  settlement_amount: string
  net_amount: string
  commission: string
  transaction_currency: string
}

interface ConfirmState {
  type: 'delete-batch' | 'delete-all' | 'reject-batch'
  batchId?: number
  label?: string
}

function fmtRawValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function initEditFields(raw: Record<string, unknown>): EditFields {
  return {
    transaction_date:    String(raw.transaction_date   ?? ''),
    transaction_type:    String(raw.transaction_type   ?? ''),
    ticker:              String(raw.ticker             ?? raw.raw_symbol ?? ''),
    account_id:          String(raw.account_id         ?? ''),
    quantity:            String(raw.quantity           ?? ''),
    price:               String(raw.price              ?? ''),
    settlement_amount:   String(raw.settlement_amount  ?? ''),
    net_amount:          String(raw.net_amount         ?? ''),
    commission:          String(raw.commission         ?? ''),
    transaction_currency: String(raw.transaction_currency ?? 'CAD'),
  }
}

// Keys to hide from the "original CSV" panel (shown in edit fields instead)
const EDIT_KEYS = new Set([
  'transaction_date','transaction_type','ticker','raw_symbol','account_id',
  'quantity','price','settlement_amount','net_amount','commission','transaction_currency',
])

// ── IBKR Flex tab ─────────────────────────────────────────────────────────────

function IBKRFlexPanel() {
  const qc = useQueryClient()
  const xmlInputRef = useRef<HTMLInputElement | null>(null)
  const SYNC_TS_KEY = 'ibkr_sync_started'

  // ── Config query (poll when sync is running) ────────────────────────────────
  const { data: myConfig, isLoading } = useQuery<IBKRFlexConfig | null>({
    queryKey: ['ibkr-flex-my-config'],
    queryFn: getMyFlexConfig,
    refetchInterval: (query) => {
      const d = query.state.data as IBKRFlexConfig | null | undefined
      if (d?.last_sync_status === 'running') return 3000
      const ts = localStorage.getItem(SYNC_TS_KEY)
      if (ts && Date.now() - Number(ts) < 5 * 60 * 1000) return 3000
      return false
    },
    refetchIntervalInBackground: true,
  })

  // Stop polling when sync finishes
  const prevStatus = myConfig?.last_sync_status
  if (prevStatus === 'ok' || prevStatus === 'error') {
    localStorage.removeItem(SYNC_TS_KEY)
  }

  // ── Config form state ───────────────────────────────────────────────────────
  const [showConfigForm, setShowConfigForm] = useState(false)
  const [configForm, setConfigForm] = useState<FlexConfigIn>({ query_id: '', token: '', enabled: true })
  const [configError, setConfigError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const openConfigForm = () => {
    setConfigForm({ query_id: myConfig?.query_id ?? '', token: '', enabled: myConfig?.enabled ?? true })
    setConfigError(null)
    setShowConfigForm(true)
  }

  const saveConfigMutation = useMutation({
    mutationFn: (data: FlexConfigIn) => saveMyFlexConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
      setShowConfigForm(false)
      setConfigError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) =>
      setConfigError(err?.response?.data?.detail ?? err?.message ?? 'Save failed'),
  })

  const deleteConfigMutation = useMutation({
    mutationFn: deleteMyFlexConfig,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
      setDeleteConfirm(false)
      setShowConfigForm(false)
      setSyncError(null)
      setUploadDetails(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) =>
      setConfigError(err?.response?.data?.detail ?? err?.message ?? 'Delete failed'),
  })

  const handleSaveConfig = () => {
    if (!configForm.query_id.trim()) { setConfigError('Query ID is required'); return }
    if (!configForm.token.trim()) { setConfigError('Token is required'); return }
    saveConfigMutation.mutate(configForm)
  }

  // ── Sync / upload state ─────────────────────────────────────────────────────
  const [syncError, setSyncError] = useState<string | null>(null)
  const [uploadDetails, setUploadDetails] = useState<ImportDetail[] | null>(null)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [logOpen, setLogOpen] = useState(false)

  const syncPending = (() => {
    if (myConfig?.last_sync_status === 'running') return true
    const ts = localStorage.getItem(SYNC_TS_KEY)
    return !!ts && Date.now() - Number(ts) < 5 * 60 * 1000
  })()

  const handleSync = async () => {
    setSyncError(null)
    setUploadDetails(null)
    setUploadMessage(null)
    setUploadError(null)
    try {
      localStorage.setItem(SYNC_TS_KEY, String(Date.now()))
      await syncMyFlexAccounts()
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
    } catch (e: unknown) {
      localStorage.removeItem(SYNC_TS_KEY)
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setSyncError(err?.response?.data?.detail ?? err?.message ?? 'Sync failed')
    }
  }

  const handleUploadXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadDetails(null)
    setUploadMessage(null)
    setUploadError(null)
    setSyncError(null)
    try {
      const result = await uploadFlexXml(file)
      setUploadMessage(result.message ?? `Imported ${result.imported} transaction(s)`)
      if (result.details && result.details.length > 0) {
        setUploadDetails(result.details)
        setLogOpen(true)
      }
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setUploadError(err?.response?.data?.detail ?? err?.message ?? 'Upload failed')
    } finally {
      setUploading(false)
      if (xmlInputRef.current) xmlInputRef.current.value = ''
    }
  }

  // Details for the log: upload result takes priority; fall back to last sync details
  const lastSyncDetails: ImportDetail[] | null = (() => {
    if (!myConfig?.last_sync_details) return null
    try { return JSON.parse(myConfig.last_sync_details) as ImportDetail[] }
    catch { return null }
  })()
  const logDetails = uploadDetails ?? (myConfig?.last_sync_status === 'ok' ? lastSyncDetails : null)

  if (isLoading) {
    return <div className="text-sm text-gray-400 py-6">Loading Flex config…</div>
  }

  return (
    <div className="space-y-5">

      {/* ── Configuration card ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Flex Query Configuration</h2>
          {myConfig && !showConfigForm && (
            <div className="flex gap-2 items-center">
              <button onClick={openConfigForm}
                className="text-sm text-blue-600 border border-blue-300 rounded px-3 py-1 hover:bg-blue-50">
                Edit
              </button>
              {!deleteConfirm ? (
                <button onClick={() => setDeleteConfirm(true)}
                  className="text-sm text-red-600 border border-red-300 rounded px-3 py-1 hover:bg-red-50">
                  Remove
                </button>
              ) : (
                <span className="flex items-center gap-1.5 text-sm">
                  <span className="text-red-700 font-medium">Remove config?</span>
                  <button onClick={() => deleteConfigMutation.mutate()}
                    disabled={deleteConfigMutation.isPending}
                    className="text-white bg-red-600 rounded px-2 py-0.5 hover:bg-red-700 disabled:opacity-50">
                    {deleteConfigMutation.isPending ? '…' : 'Yes'}
                  </button>
                  <button onClick={() => { setDeleteConfirm(false); setConfigError(null) }}
                    className="text-gray-600 border border-gray-300 rounded px-2 py-0.5 hover:bg-gray-50">
                    No
                  </button>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Config summary view */}
        {myConfig && !showConfigForm && (
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Query ID</p>
              <p className="font-mono text-gray-800">{myConfig.query_id}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Token</p>
              <p className="font-mono text-gray-500">{myConfig.token_hint}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Auto-sync</p>
              <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${
                myConfig.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              }`}>
                {myConfig.enabled ? '● Enabled' : '○ Disabled'}
              </span>
            </div>
          </div>
        )}

        {/* No config yet → prompt to set up */}
        {!myConfig && !showConfigForm && (
          <div className="text-sm text-gray-500 space-y-3">
            <p>Connect to IBKR Flex Query to automatically import your trades, dividends, and other transactions.</p>
            <button
              onClick={() => { setConfigForm({ query_id: '', token: '', enabled: true }); setConfigError(null); setShowConfigForm(true) }}
              className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700">
              Set Up Flex Query
            </button>
          </div>
        )}

        {/* Config form (create or edit) */}
        {showConfigForm && (
          <div className="space-y-3 border-t border-gray-100 pt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Query ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full font-mono"
                  value={configForm.query_id}
                  onChange={e => setConfigForm(f => ({ ...f, query_id: e.target.value }))}
                  placeholder="e.g. 123456"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Token <span className="text-red-500">*</span>
                  {myConfig && <span className="ml-1 text-gray-400">(re-enter to update)</span>}
                </label>
                <input
                  type="password"
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full font-mono"
                  value={configForm.token}
                  onChange={e => setConfigForm(f => ({ ...f, token: e.target.value }))}
                  placeholder={myConfig ? '••••••••••••' : 'Paste token from IBKR'}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={configForm.enabled}
                onChange={e => setConfigForm(f => ({ ...f, enabled: e.target.checked }))}
                className="rounded"
              />
              Enable automatic nightly sync
            </label>
            {configError && <p className="text-sm text-red-600">{configError}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleSaveConfig}
                disabled={saveConfigMutation.isPending}
                className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50">
                {saveConfigMutation.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setShowConfigForm(false); setConfigError(null) }}
                className="border border-gray-300 rounded-lg px-4 py-2 text-sm hover:bg-gray-50">
                Cancel
              </button>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800 space-y-1">
              <p className="font-semibold">How to find your Query ID and Token:</p>
              <ol className="list-decimal ml-4 space-y-0.5">
                <li>Log in to <strong>interactivebrokers.com</strong> → Reports → Flex Queries</li>
                <li>Create a query that includes <strong>Trades</strong>, <strong>Cash Transactions</strong>, <strong>Option EAE</strong>, and <strong>Corporate Actions</strong> with date range "Year to Date"</li>
                <li>Note the <strong>Query ID</strong> shown next to the query name</li>
                <li>Go to <strong>Settings → Account → Flex Web Service</strong> to create or copy your API token</li>
              </ol>
            </div>
          </div>
        )}
      </div>

      {/* ── Sync card (only shown if config exists and not editing config) ── */}
      {myConfig && !showConfigForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <h2 className="font-semibold text-gray-800">Sync Transactions</h2>
              <p className="text-xs text-gray-500">
                Pulls Year-to-Date trades, cash, option events and corporate actions from IBKR.
                Use "Check Duplicates" in the preview to flag potential duplicates before committing.
              </p>
              {myConfig.last_sync_at && (
                <p className="text-xs text-gray-400">
                  Last sync: {new Date(myConfig.last_sync_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}
                  {' · '}
                  {myConfig.last_sync_status === 'ok' && (
                    <span className="text-emerald-600">{myConfig.last_sync_message}</span>
                  )}
                  {myConfig.last_sync_status === 'error' && (
                    <span className="text-red-600">{myConfig.last_sync_message}</span>
                  )}
                  {myConfig.last_sync_status === 'running' && (
                    <span className="text-blue-600 inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Running…
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={handleSync}
                disabled={syncPending}
                className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700 disabled:opacity-50"
              >
                {syncPending
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Syncing…</>
                  : <><RefreshCw className="h-4 w-4" /> Sync Now</>}
              </button>
              <button
                onClick={() => xmlInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1.5 text-sm bg-green-600 text-white rounded-lg px-4 py-2 hover:bg-green-700 disabled:opacity-50"
                title="Upload a Flex Query XML file downloaded from IBKR — bypasses the API rate limit"
              >
                {uploading
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</>
                  : <><Database className="h-4 w-4" /> Upload XML</>}
              </button>
              <input ref={xmlInputRef} type="file" accept=".xml" className="hidden" onChange={handleUploadXml} />
            </div>
          </div>

          {syncError && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {syncError.includes('429') || syncError.includes('10 minute')
                ? "IBKR limits Flex API requests to once per ~10 minutes. Use Upload XML to bypass this — download the XML directly from the IBKR Flex Query page and upload it here."
                : syncError}
            </div>
          )}
          {uploadMessage && (
            <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-700">
              ✓ {uploadMessage}
            </div>
          )}
          {uploadError && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              Upload failed: {uploadError}
            </div>
          )}
        </div>
      )}

      {/* ── Import log ── */}
      {myConfig && !showConfigForm && (logDetails !== null || myConfig.last_sync_status === 'ok') && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            onClick={() => setLogOpen(o => !o)}
            className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              {logOpen
                ? <ChevronDown className="h-4 w-4 text-gray-400" />
                : <ChevronRight className="h-4 w-4 text-gray-400" />}
              <h2 className="font-semibold text-gray-800">Import Log</h2>
              <span className="text-xs text-gray-400">
                {logDetails && logDetails.length > 0
                  ? `(${logDetails.length} transaction${logDetails.length !== 1 ? 's' : ''} imported)`
                  : '(no new transactions)'}
              </span>
            </div>
          </button>

          {logOpen && (
            <div className="border-t border-gray-100">
              {logDetails && logDetails.length > 0 ? (
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="min-w-full text-xs divide-y divide-gray-100">
                    <thead className="sticky top-0 bg-gray-50 z-10">
                      <tr className="text-gray-500 uppercase">
                        <th className="px-4 py-2 text-left">Date</th>
                        <th className="px-4 py-2 text-left">Account</th>
                        <th className="px-4 py-2 text-left">Type</th>
                        <th className="px-4 py-2 text-left">Ticker</th>
                        <th className="px-4 py-2 text-right">Qty</th>
                        <th className="px-4 py-2 text-right">Amount</th>
                        <th className="px-4 py-2 text-left">Ccy</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {logDetails.map((row, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-4 py-1.5 text-gray-600 whitespace-nowrap">{row.date}</td>
                          <td className="px-4 py-1.5 text-gray-700 max-w-[10rem] truncate" title={row.account}>{row.account}</td>
                          <td className="px-4 py-1.5">
                            <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-700">
                              {row.type}
                            </span>
                          </td>
                          <td className="px-4 py-1.5 font-mono font-medium">{row.ticker || '—'}</td>
                          <td className="px-4 py-1.5 text-right tabular-nums">{row.qty || '—'}</td>
                          <td className="px-4 py-1.5 text-right tabular-nums">{row.amount || '—'}</td>
                          <td className="px-4 py-1.5 text-gray-500">{row.currency}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-6 py-4 text-sm text-gray-400">
                  No new transactions were imported — all were duplicates or already up to date.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* How-to hint */}
      {myConfig && !showConfigForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-800 space-y-1">
          <p className="font-semibold">When "Sync Now" fails with a rate-limit error:</p>
          <ol className="list-decimal ml-4 space-y-0.5">
            <li>Log in to <strong>interactivebrokers.com</strong> → Reports → Flex Queries</li>
            <li>Run your <strong>Portfolio Tracker – All</strong> query and download the XML file</li>
            <li>Click <strong>Upload XML</strong> above and select that file</li>
          </ol>
        </div>
      )}
    </div>
  )
}

// ── Manual Entry panel ────────────────────────────────────────────────────────

const MANUAL_TX_TYPES = [
  'FX_ADJUSTMENT', 'ADJUSTMENT', 'OPENING_BALANCE', 'CASH_OPENING',
  'DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'FEE', 'DIVIDEND',
  'BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT', 'JOURNAL',
  'OPTION_BUY', 'OPTION_SELL', 'OPTION_EXPIRY', 'OPTION_ASSIGNMENT', 'OPTION_EXERCISE',
  'OTHER',
]

function ManualEntryPanel() {
  const qc = useQueryClient()
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const { data: securities = [] } = useQuery({ queryKey: ['securities'], queryFn: () => getSecurities() })

  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState<Partial<Transaction>>({
    transaction_date: today,
    transaction_type: 'FX_ADJUSTMENT',
    transaction_currency: 'CAD',
  })
  const [tickerInput, setTickerInput] = useState('')
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: (data: Partial<Transaction>) => createTransaction(data),
    onSuccess: (tx: Transaction) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
      setSuccess(`Created transaction #${tx.id} (${tx.transaction_type} on ${tx.transaction_date})`)
      setError(null)
      setForm({ transaction_date: today, transaction_type: 'FX_ADJUSTMENT', transaction_currency: 'CAD' })
      setTickerInput('')
    },
    onError: (err: { response?: { data?: { detail?: unknown } }; message?: string }) => {
      const detail = err?.response?.data?.detail
      setError(Array.isArray(detail)
        ? detail.map((d: { msg?: string }) => d.msg ?? '').join('; ')
        : typeof detail === 'string' ? detail : err?.message ?? 'Create failed')
      setSuccess(null)
    },
  })

  const currency = (form.transaction_currency as string) || 'CAD'
  const isCAD = currency === 'CAD'

  const handleSubmit = () => {
    const payload = { ...form }
    if (isCAD && payload.transaction_amount && !payload.cad_amount) {
      payload.cad_amount = payload.transaction_amount
    }
    if (isCAD && !payload.account_currency_amount) {
      payload.account_currency_amount = payload.transaction_amount
    }
    createMutation.mutate(payload)
  }

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
        <p className="font-semibold mb-1">When to use Manual Entry</p>
        <ul className="list-disc ml-4 space-y-0.5 text-xs">
          <li>FX translation adjustments (e.g. year-end unrealized FX position not in Flex XML)</li>
          <li>Opening balances when starting to track an existing account</li>
          <li>One-off corrections or adjustments not captured by CSV or Flex import</li>
        </ul>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-gray-800">Create Manual Transaction</h2>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Account <span className="text-red-400">*</span></label>
            <select
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
              value={form.account_id || ''}
              onChange={e => setForm(f => ({ ...f, account_id: e.target.value ? Number(e.target.value) : undefined }))}
            >
              <option value="">Select account…</option>
              {(accounts as Account[]).map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Date <span className="text-red-400">*</span></label>
            <input
              type="date"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
              value={(form.transaction_date as string) || ''}
              onChange={e => setForm(f => ({ ...f, transaction_date: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Type <span className="text-red-400">*</span></label>
            <select
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
              value={(form.transaction_type as string) || ''}
              onChange={e => setForm(f => ({ ...f, transaction_type: e.target.value }))}
            >
              {MANUAL_TX_TYPES.map(t => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Ticker (optional)</label>
            <input
              list="manual-tickers"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full uppercase"
              value={tickerInput}
              onChange={e => {
                const v = e.target.value.toUpperCase()
                setTickerInput(v)
                const sec = (securities as Security[]).find(s => s.ticker.toUpperCase() === v)
                setForm(f => ({ ...f, security_id: sec?.id ?? undefined }))
              }}
              placeholder="e.g. ENB"
            />
            <datalist id="manual-tickers">
              {(securities as Security[]).map(s => (
                <option key={s.id} value={s.ticker}>{s.name || s.ticker}</option>
              ))}
            </datalist>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Currency</label>
            <select
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
              value={currency}
              onChange={e => setForm(f => ({ ...f, transaction_currency: e.target.value }))}
            >
              <option>CAD</option>
              <option>USD</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Amount ({currency}) <span className="text-red-400">*</span></label>
            <input
              type="number"
              step="0.01"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
              value={(form.transaction_amount as string) || ''}
              onChange={e => setForm(f => ({ ...f, transaction_amount: e.target.value || undefined }))}
              placeholder="e.g. -5.17"
            />
            <p className="text-xs text-gray-400 mt-0.5">Use negative values for losses / outflows</p>
          </div>

          {!isCAD && (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">FX Rate (USD → CAD)</label>
                <input
                  type="number"
                  step="0.000001"
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
                  value={(form.fx_rate_to_cad as string) || ''}
                  onChange={e => setForm(f => ({ ...f, fx_rate_to_cad: e.target.value || undefined, fx_rate_to_account: e.target.value || undefined }))}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">CAD Amount</label>
                <input
                  type="number"
                  step="0.01"
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
                  value={(form.cad_amount as string) || ''}
                  onChange={e => setForm(f => ({ ...f, cad_amount: e.target.value || undefined }))}
                />
              </div>
            </>
          )}

          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Description</label>
            <input
              type="text"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
              value={(form.raw_description as string) || ''}
              onChange={e => setForm(f => ({ ...f, raw_description: e.target.value || undefined }))}
              placeholder="e.g. FX Translation Gain/Loss 2025-01-01 to 2025-12-31"
            />
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-700">
            ✓ {success}
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={createMutation.isPending || !form.account_id || !form.transaction_date || !form.transaction_type || !form.transaction_amount}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {createMutation.isPending ? 'Creating…' : 'Create Transaction'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Import page ──────────────────────────────────────────────────────────

export default function Import() {
  const qc = useQueryClient()

  // Tab state
  const [activeTab, setActiveTab] = useState<'csv' | 'flex' | 'plaid' | 'statement' | 'manual'>('csv')

  // CSV tab state
  const [selectedBrokerageId, setSelectedBrokerageId] = useState<number | undefined>()
  const [selectedAccountId, setSelectedAccountId] = useState<number | undefined>()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [previewBatchId, setPreviewBatchId] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ConfirmState | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  // Row-level edit state
  const [editRow, setEditRow] = useState<RawRow | null>(null)
  const [editFields, setEditFields] = useState<EditFields | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  const { data: imports = [], isLoading } = useQuery({ queryKey: ['imports'], queryFn: getImports })
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const { data: securities = [] } = useQuery({ queryKey: ['securities'], queryFn: () => getSecurities() })
  const { data: preview, refetch: refetchPreview } = useQuery({
    queryKey: ['import-preview', previewBatchId],
    queryFn: () => getImportPreview(previewBatchId!),
    enabled: !!previewBatchId,
  })

  // Derive unique brokerages from accounts list
  const brokerages = (() => {
    const seen = new Map<number, string>()
    ;(accounts as Account[]).forEach(a => {
      if (!seen.has(a.brokerage_id)) seen.set(a.brokerage_id, a.brokerage_name)
    })
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
  })()

  // Accounts filtered to selected brokerage (all accounts when no brokerage selected)
  const filteredAccounts = selectedBrokerageId
    ? (accounts as Account[]).filter(a => a.brokerage_id === selectedBrokerageId)
    : (accounts as Account[])

  // When brokerage changes, clear account if it no longer belongs to it
  const handleBrokerageChange = (brokId: number | undefined) => {
    setSelectedBrokerageId(brokId)
    if (brokId && selectedAccountId) {
      const still = (accounts as Account[]).find(
        a => a.id === selectedAccountId && a.brokerage_id === brokId
      )
      if (!still) setSelectedAccountId(undefined)
    }
  }

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadFile(file, selectedAccountId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['imports'] })
      setUploadError(null)
      if (data?.batch_id) {
        setPreviewBatchId(data.batch_id)
        setHistoryOpen(true)  // auto-expand history when a new upload completes
      }
    },
    onError: (err: Error) => setUploadError(err.message),
  })

  const commitMutation = useMutation({
    mutationFn: commitImport,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['imports'] })
      qc.invalidateQueries({ queryKey: ['import-preview', previewBatchId] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (id: number) => rejectImport(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['imports'] }); setDialog(null); setDialogError(null) },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) =>
      setDialogError(err?.response?.data?.detail || err?.message || 'Reject failed'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteImport(id),
    onSuccess: (_, batchId) => {
      qc.invalidateQueries({ queryKey: ['imports'] })
      if (previewBatchId === batchId) setPreviewBatchId(null)
      setDialog(null); setDialogError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) =>
      setDialogError(err?.response?.data?.detail || err?.message || 'Delete failed'),
  })

  const deleteAllMutation = useMutation({
    mutationFn: () => deleteAllImports(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['imports'] }); setPreviewBatchId(null)
      setDialog(null); setDialogError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) =>
      setDialogError(err?.response?.data?.detail || err?.message || 'Delete failed'),
  })

  const remapMutation = useMutation({
    mutationFn: (id: number) => remapImportTypes(id),
    onSuccess: (data, batchId) => {
      qc.invalidateQueries({ queryKey: ['import-preview', batchId] })
      qc.invalidateQueries({ queryKey: ['imports'] })
    },
  })

  const checkDupMutation = useMutation({
    mutationFn: (id: number) => checkImportDuplicates(id),
    onSuccess: () => refetchPreview(),
  })

  const rowMutation = useMutation({
    mutationFn: ({ rowId, updates }: { rowId: number; updates: Record<string, unknown> }) =>
      updateRawRow(previewBatchId!, rowId, updates),
    onSuccess: () => {
      refetchPreview()
      setEditRow(null); setEditFields(null); setEditError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) =>
      setEditError(err?.response?.data?.detail || err?.message || 'Save failed'),
  })

  const openEdit = (row: RawRow) => {
    setEditError(null)
    setEditRow(row)
    setEditFields(initEditFields(row.raw_data))
  }

  const saveEdit = () => {
    if (!editRow || !editFields) return
    const updates: Record<string, unknown> = {}
    const raw = editRow.raw_data
    const fieldMap: Record<string, string> = {
      transaction_date: 'transaction_date',
      transaction_type: 'transaction_type',
      ticker: 'ticker',
      account_id: 'account_id',
      quantity: 'quantity',
      price: 'price',
      settlement_amount: 'settlement_amount',
      net_amount: 'net_amount',
      commission: 'commission',
      transaction_currency: 'transaction_currency',
    }
    for (const [fk, rk] of Object.entries(fieldMap)) {
      const val = editFields[fk as keyof EditFields]
      if (val !== '' && val !== String(raw[rk] ?? '')) {
        updates[rk] = val
      }
    }
    if (updates.ticker) updates.raw_symbol = updates.ticker
    if (updates.account_id) updates.account_id = Number(updates.account_id)
    rowMutation.mutate({ rowId: editRow.id, updates })
  }

  const skipRow = (row: RawRow) =>
    rowMutation.mutate({ rowId: row.id, updates: { _status: 'SKIPPED' } })

  const restoreRow = (row: RawRow) =>
    rowMutation.mutate({ rowId: row.id, updates: { _status: 'PENDING' } })

  const forceImportRow = (row: RawRow) =>
    rowMutation.mutate({ rowId: row.id, updates: { force_import: true, _status: 'PENDING' } })

  const onDrop = useCallback((files: File[]) => {
    if (files.length > 0) uploadMutation.mutate(files[0])
  }, [uploadMutation])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'text/csv': ['.csv'], 'text/plain': ['.csv', '.txt'] },
    multiple: false,
  })

  const rows: RawRow[] = preview?.rows ?? []
  const pending  = rows.filter(r => r.status === 'PENDING').length
  const errors   = rows.filter(r => r.status === 'ERROR').length
  const skipped  = rows.filter(r => r.status === 'SKIPPED').length
  const imported = rows.filter(r => r.status === 'IMPORTED').length

  const isPending = deleteMutation.isPending || rejectMutation.isPending || deleteAllMutation.isPending

  // Filter import history to match the active brokerage / account selection
  const visibleImports = (imports as ImportBatch[]).filter(b => {
    if (selectedAccountId && b.account_id !== selectedAccountId) return false
    if (selectedBrokerageId && !selectedAccountId && b.brokerage_id !== selectedBrokerageId) return false
    return true
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
        {activeTab === 'csv' && (
          <button
            onClick={() => { setDialogError(null); setDialog({ type: 'delete-all' }) }}
            className="flex items-center gap-2 text-sm text-red-600 border border-red-300 rounded px-3 py-1.5 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" /> Delete All Imports
          </button>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b border-gray-200">
        {(['csv', 'flex', 'plaid', 'statement', 'manual'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'csv' ? 'CSV Upload' : tab === 'flex' ? 'IBKR Flex Query' : tab === 'plaid' ? 'Plaid' : tab === 'statement' ? 'Statements' : 'Manual Entry'}
          </button>
        ))}
      </div>

      {/* ── CSV tab ── */}
      {activeTab === 'csv' && (
        <>
          {/* Upload zone */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-4">
            <h2 className="font-semibold text-gray-800">Upload CSV File</h2>

            {/* Brokerage + Account selectors */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600 whitespace-nowrap">Brokerage:</label>
                <select
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm"
                  value={selectedBrokerageId ?? ''}
                  onChange={e => handleBrokerageChange(e.target.value ? Number(e.target.value) : undefined)}
                >
                  <option value="">All brokerages</option>
                  {brokerages.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600 whitespace-nowrap">Account:</label>
                <select
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm"
                  value={selectedAccountId ?? ''}
                  onChange={e => setSelectedAccountId(e.target.value ? Number(e.target.value) : undefined)}
                >
                  <option value="">Auto-detect</option>
                  {filteredAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>

              {(selectedBrokerageId || selectedAccountId) && (() => {
                const acct = selectedAccountId
                  ? (accounts as Account[]).find(a => a.id === selectedAccountId)
                  : null
                const brok = selectedBrokerageId
                  ? brokerages.find(b => b.id === selectedBrokerageId)
                  : null
                const label = acct
                  ? `${acct.brokerage_name} · ${acct.name}`
                  : brok ? brok.name : ''
                return label ? (
                  <span className="text-xs bg-blue-50 border border-blue-200 text-blue-700 px-2 py-1 rounded">
                    ✓ {label}
                  </span>
                ) : null
              })()}
            </div>

            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                isDragActive ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
              }`}
            >
              <input {...getInputProps()} />
              <Upload className="h-10 w-10 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-600 font-medium">
                {isDragActive ? 'Drop the file here' : 'Drag & drop a CSV file here, or click to select'}
              </p>
              <p className="text-xs text-gray-400 mt-2">
                Supports Scotia iTrade, Scotia Wealth and Interactive Brokers transaction history formats
              </p>
              <p className="text-xs text-blue-500 mt-1">
                For IBKR multi-account files: leave account as "Auto-detect" and set the IB Alias on each account in Admin → Accounts to match the alias names used in the CSV (e.g. "Brian TFSA"). Rows with unrecognized aliases are skipped automatically.
              </p>
            </div>
            {uploadMutation.isPending && (
              <div className="text-blue-600 text-sm flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
                Uploading and parsing...
              </div>
            )}
            {uploadError && (
              <div className="text-red-600 text-sm bg-red-50 rounded p-3 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />{uploadError}
              </div>
            )}
            {uploadMutation.isSuccess && (
              <div className="text-green-600 text-sm bg-green-50 rounded p-3 flex items-center gap-2">
                <CheckCircle className="h-4 w-4" />
                File uploaded and parsed. Review and edit rows below, then commit.
              </div>
            )}
          </div>

          {/* Import history — collapsible */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <button
              onClick={() => setHistoryOpen(o => !o)}
              className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center gap-2">
                {historyOpen
                  ? <ChevronDown className="h-4 w-4 text-gray-400" />
                  : <ChevronRight className="h-4 w-4 text-gray-400" />}
                <h2 className="font-semibold text-gray-800">Import History</h2>
                {!historyOpen && visibleImports.length > 0 && (
                  <span className="text-xs text-gray-400">
                    ({visibleImports.length} batch{visibleImports.length !== 1 ? 'es' : ''}
                    {(selectedBrokerageId || selectedAccountId) ? ', filtered' : ''})
                  </span>
                )}
              </div>
            </button>

            {historyOpen && (
              <div className="px-6 pb-5 border-t border-gray-100">
                {isLoading ? (
                  <div className="text-gray-400 text-sm py-4">Loading...</div>
                ) : visibleImports.length === 0 ? (
                  <p className="text-gray-400 text-sm py-4">
                    {(selectedBrokerageId || selectedAccountId) ? 'No imports match the current filter.' : 'No imports yet.'}
                  </p>
                ) : (
                  <div className="overflow-x-auto mt-4">
                    <table className="min-w-full text-sm divide-y divide-gray-100">
                      <thead>
                        <tr className="text-xs text-gray-500 uppercase">
                          <th className="pb-2 text-left">File</th>
                          <th className="pb-2 text-left">Date</th>
                          <th className="pb-2 text-center">Rows</th>
                          <th className="pb-2 text-center">Imported</th>
                          <th className="pb-2 text-center">Errors</th>
                          <th className="pb-2 text-center">Status</th>
                          <th className="pb-2 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {visibleImports.map(batch => (
                          <tr key={batch.id} className="hover:bg-gray-50">
                            <td className="py-2 pr-4 font-medium text-gray-800">{batch.filename}</td>
                            <td className="py-2 pr-4 text-gray-500">{new Date(batch.import_date).toLocaleDateString()}</td>
                            <td className="py-2 text-center">{batch.row_count}</td>
                            <td className="py-2 text-center text-green-600 font-medium">{batch.imported_count}</td>
                            <td className="py-2 text-center text-red-600 font-medium">{batch.error_count}</td>
                            <td className="py-2 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[batch.status] || 'bg-gray-100 text-gray-600'}`}>
                                {batch.status}
                              </span>
                            </td>
                            <td className="py-2">
                              <div className="flex items-center justify-center gap-2">
                                <button
                                  onClick={() => setPreviewBatchId(previewBatchId === batch.id ? null : batch.id)}
                                  className="text-blue-600 hover:text-blue-800 flex items-center gap-1 text-xs"
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                  {previewBatchId === batch.id ? 'Hide' : 'Preview'}
                                </button>
                                {batch.status === 'PENDING' && (
                                  <>
                                    <button onClick={() => remapMutation.mutate(batch.id)}
                                      disabled={remapMutation.isPending}
                                      title="Re-apply brokerage type mappings to all pending rows"
                                      className="text-purple-500 hover:text-purple-700 flex items-center gap-1 text-xs disabled:opacity-50">
                                      <RefreshCw className="h-3.5 w-3.5" /> Remap Types
                                    </button>
                                    <button onClick={() => commitMutation.mutate(batch.id)}
                                      disabled={commitMutation.isPending}
                                      className="text-green-600 hover:text-green-800 flex items-center gap-1 text-xs disabled:opacity-50">
                                      <CheckCircle className="h-3.5 w-3.5" /> Commit
                                    </button>
                                    <button
                                      onClick={() => { setDialogError(null); setDialog({ type: 'reject-batch', batchId: batch.id, label: batch.filename }) }}
                                      className="text-orange-600 hover:text-orange-800 flex items-center gap-1 text-xs">
                                      <XCircle className="h-3.5 w-3.5" /> Reject
                                    </button>
                                    <button
                                      onClick={() => { setDialogError(null); setDialog({ type: 'delete-batch', batchId: batch.id, label: batch.filename }) }}
                                      className="text-red-500 hover:text-red-700 flex items-center gap-1 text-xs">
                                      <Trash2 className="h-3.5 w-3.5" /> Delete
                                    </button>
                                  </>
                                )}
                                {batch.status === 'REJECTED' && (
                                  <button
                                    onClick={() => { setDialogError(null); setDialog({ type: 'delete-batch', batchId: batch.id, label: batch.filename }) }}
                                    className="text-red-500 hover:text-red-700 flex items-center gap-1 text-xs">
                                    <Trash2 className="h-3.5 w-3.5" /> Delete
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Preview / Edit panel ── */}
          {previewBatchId && preview && (
            <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <h2 className="font-semibold text-gray-800">Preview: {preview.filename}</h2>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[preview.status] || 'bg-gray-100 text-gray-600'}`}>
                    {preview.status}
                  </span>
                </div>
                <div className="flex gap-2 items-center">
                  <div className="flex gap-1.5 text-xs">
                    {pending  > 0 && <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">{pending} pending</span>}
                    {errors   > 0 && <span className="bg-red-100 text-red-700 px-2 py-1 rounded">{errors} errors</span>}
                    {skipped  > 0 && <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded">{skipped} skipped</span>}
                    {imported > 0 && <span className="bg-green-100 text-green-700 px-2 py-1 rounded">{imported} imported</span>}
                  </div>
                  {preview.status === 'PENDING' && (
                    <>
                      <button
                        onClick={() => remapMutation.mutate(previewBatchId)}
                        disabled={remapMutation.isPending}
                        title="Re-apply brokerage type mappings to all pending rows"
                        className="flex items-center gap-1.5 text-sm border border-purple-300 text-purple-600 rounded px-3 py-1.5 hover:bg-purple-50 disabled:opacity-50"
                      >
                        <RefreshCw className={`h-4 w-4 ${remapMutation.isPending ? 'animate-spin' : ''}`} />
                        {remapMutation.isPending ? 'Remapping…' : 'Remap Types'}
                      </button>
                      {remapMutation.isSuccess && (
                        <span className="text-xs text-purple-600">
                          ✓ {(remapMutation.data as { remapped?: number })?.remapped ?? 0} rows updated
                        </span>
                      )}
                      <button
                        onClick={() => checkDupMutation.mutate(previewBatchId)}
                        disabled={checkDupMutation.isPending}
                        title="Pre-check rows for duplicates before committing"
                        className="flex items-center gap-1.5 text-sm border border-orange-300 text-orange-600 rounded px-3 py-1.5 hover:bg-orange-50 disabled:opacity-50"
                      >
                        <AlertTriangle className={`h-4 w-4 ${checkDupMutation.isPending ? 'animate-spin' : ''}`} />
                        {checkDupMutation.isPending ? 'Checking…' : 'Check Duplicates'}
                      </button>
                      {checkDupMutation.isSuccess && (
                        <span className="text-xs text-orange-600">
                          ✓ {(checkDupMutation.data as { duplicates_found?: number })?.duplicates_found ?? 0} duplicates found
                        </span>
                      )}
                      <button
                        onClick={() => commitMutation.mutate(previewBatchId)}
                        disabled={commitMutation.isPending}
                        className="flex items-center gap-1.5 text-sm bg-green-600 text-white rounded px-3 py-1.5 hover:bg-green-700 disabled:opacity-50"
                      >
                        <CheckCircle className="h-4 w-4" />
                        {commitMutation.isPending ? 'Committing…' : 'Commit Import'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Row table */}
              <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
                <table className="min-w-full text-xs divide-y divide-gray-100">
                  <thead className="sticky top-0 bg-white shadow-sm z-10">
                    <tr className="text-gray-500 uppercase">
                      <th className="pb-2 px-2 text-left">#</th>
                      <th className="pb-2 px-2 text-left">Date</th>
                      <th className="pb-2 px-2 text-left">Account</th>
                      <th className="pb-2 px-2 text-left">Type</th>
                      <th className="pb-2 px-2 text-left">Ticker</th>
                      <th className="pb-2 px-2 text-right">Qty</th>
                      <th className="pb-2 px-2 text-right">Amount</th>
                      <th className="pb-2 px-2 text-center">Status</th>
                      <th className="pb-2 px-2 text-left">Error / Note</th>
                      {preview.status === 'PENDING' && <th className="pb-2 px-2 text-center">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const isDuplicate = row.status === 'PENDING' && row.error_message === 'Duplicate transaction'
                      return (
                        <tr key={row.id} className={`${getRowBg(row)} border-b border-gray-100`}>
                          <td className="px-2 py-1.5 text-gray-400">{row.row_number}</td>
                          <td className="px-2 py-1.5">{(row.raw_data.transaction_date as string) || row.parsed_date || '—'}</td>
                          <td className="px-2 py-1.5 max-w-[10rem]">
                            {row.resolved_account_name ? (
                              <span className="text-gray-800 truncate block" title={row.resolved_account_name}>
                                {row.resolved_account_name}
                              </span>
                            ) : (row.raw_data.account_name as string) ? (
                              <span className="text-gray-500 truncate block" title={(row.raw_data.account_name as string)}>
                                {row.raw_data.account_name as string}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-2 py-1.5">{(row.raw_data.transaction_type as string) || '—'}</td>
                          <td className="px-2 py-1.5 font-mono">{(row.raw_data.ticker as string) || (row.raw_data.raw_symbol as string) || '—'}</td>
                          <td className="px-2 py-1.5 text-right">{String(row.raw_data.quantity ?? '—')}</td>
                          <td className="px-2 py-1.5 text-right">
                            {String(row.raw_data.settlement_amount ?? row.raw_data.net_amount ?? '—')}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {isDuplicate ? (
                              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">
                                DUPLICATE
                              </span>
                            ) : (
                              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${ROW_STATUS_BADGE[row.status] || 'bg-gray-200 text-gray-600'}`}>
                                {row.status}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-red-600 max-w-xs truncate">
                            {isDuplicate ? '' : (row.error_message || '')}
                          </td>
                          {preview.status === 'PENDING' && (
                            <td className="px-2 py-1.5">
                              <div className="flex items-center justify-center gap-1.5">
                                {row.status !== 'IMPORTED' && (
                                  <button onClick={() => openEdit(row)}
                                    className="text-gray-400 hover:text-blue-600" title="Edit row">
                                    <Edit2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                {isDuplicate ? (
                                  <button onClick={() => forceImportRow(row)}
                                    className="text-xs px-1.5 py-0.5 border border-orange-400 text-orange-600 hover:bg-orange-50 rounded"
                                    title="Import anyway, ignoring duplicate check">
                                    Force
                                  </button>
                                ) : row.status === 'SKIPPED' ? (
                                  <button onClick={() => restoreRow(row)}
                                    className="text-gray-400 hover:text-green-600" title="Restore to pending">
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </button>
                                ) : row.status !== 'IMPORTED' ? (
                                  <button onClick={() => skipRow(row)}
                                    className="text-gray-400 hover:text-orange-500" title="Skip this row">
                                    <SkipForward className="h-3.5 w-3.5" />
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── IBKR Flex tab ── */}
      {activeTab === 'flex' && <IBKRFlexPanel />}

      {activeTab === 'plaid' && <PlaidSyncPanel />}

      {activeTab === 'statement' && <StatementImportPanel />}

      {/* ── Manual Entry tab ── */}
      {activeTab === 'manual' && <ManualEntryPanel />}

      {/* ── Row Edit Modal ── */}
      {editRow && editFields && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h3 className="font-semibold text-gray-900">Edit Row #{editRow.row_number}</h3>
                <p className="text-xs text-gray-500 mt-0.5">Changes will be applied before committing the import</p>
              </div>
              <button onClick={() => { setEditRow(null); setEditFields(null); setEditError(null) }}
                className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex gap-0 flex-1 min-h-0 overflow-hidden">
              <div className="w-2/5 border-r border-gray-200 overflow-y-auto p-5 bg-gray-50">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Original CSV Data
                </h4>
                <dl className="space-y-1.5">
                  {Object.entries(editRow.raw_data)
                    .filter(([, v]) => v !== null && v !== undefined && v !== '')
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-xs">
                        <dt className={`shrink-0 font-medium w-36 truncate ${EDIT_KEYS.has(k) ? 'text-blue-600' : 'text-gray-500'}`}
                          title={k}>{k}</dt>
                        <dd className="text-gray-700 break-all">{fmtRawValue(v)}</dd>
                      </div>
                    ))}
                </dl>
                <p className="text-xs text-blue-600 mt-4">
                  <span className="font-medium">Blue fields</span> are editable on the right.
                </p>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Edit Mapped Fields
                </h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Transaction Date</label>
                    <input type="date" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.transaction_date}
                      onChange={e => setEditFields(f => f && ({ ...f, transaction_date: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Transaction Type</label>
                    <select className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.transaction_type}
                      onChange={e => setEditFields(f => f && ({ ...f, transaction_type: e.target.value }))}>
                      <option value="">— select —</option>
                      {ALL_TX_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Ticker / Security</label>
                    <input
                      list="ticker-list"
                      className="border rounded px-3 py-1.5 text-sm w-full uppercase"
                      value={editFields.ticker}
                      onChange={e => setEditFields(f => f && ({ ...f, ticker: e.target.value.toUpperCase() }))}
                      placeholder="e.g. AAPL"
                    />
                    <datalist id="ticker-list">
                      {(securities as Security[]).map(s => (
                        <option key={s.id} value={s.ticker}>{s.ticker}{s.name ? ` — ${s.name}` : ''}</option>
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Account Override</label>
                    <select className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.account_id}
                      onChange={e => setEditFields(f => f && ({ ...f, account_id: e.target.value }))}>
                      <option value="">— use batch default —</option>
                      {(accounts as Account[]).map(a => (
                        <option key={a.id} value={a.id}>{a.brokerage_name} – {a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.quantity}
                      onChange={e => setEditFields(f => f && ({ ...f, quantity: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Price per Unit</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.price}
                      onChange={e => setEditFields(f => f && ({ ...f, price: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Settlement Amount (iTrade)</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.settlement_amount}
                      onChange={e => setEditFields(f => f && ({ ...f, settlement_amount: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Net Amount (IBKR)</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.net_amount}
                      onChange={e => setEditFields(f => f && ({ ...f, net_amount: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Commission</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.commission}
                      onChange={e => setEditFields(f => f && ({ ...f, commission: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Transaction Currency</label>
                    <select className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.transaction_currency}
                      onChange={e => setEditFields(f => f && ({ ...f, transaction_currency: e.target.value }))}>
                      <option>CAD</option>
                      <option>USD</option>
                    </select>
                  </div>
                </div>
                {editError && (
                  <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                    Error: {editError}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={() => { setEditRow(null); setEditFields(null); setEditError(null) }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100">
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={rowMutation.isPending}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {rowMutation.isPending ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Batch Confirm Modal ── */}
      {dialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-500 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-2">
                <h3 className="font-semibold text-gray-900">
                  {dialog.type === 'delete-all' ? 'Delete All Import History' :
                   dialog.type === 'reject-batch' ? 'Reject Import' : 'Delete Import Batch'}
                </h3>
                {dialog.type === 'delete-all' ? (
                  <div className="space-y-2">
                    <p className="text-sm text-gray-600">
                      Permanently deletes all import batches and raw rows. Committed transactions are not affected.
                    </p>
                    <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 font-medium">
                      ⚠️ This action cannot be undone.
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-600">
                    {dialog.type === 'reject-batch' ? 'Mark' : 'Permanently delete'} import batch:{' '}
                    <span className="font-medium text-gray-800">{dialog.label}</span>?
                    {dialog.type === 'delete-batch' && ' This cannot be undone.'}
                  </p>
                )}
                {dialogError && (
                  <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                    Error: {dialogError}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => { setDialog(null); setDialogError(null) }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={() => {
                  if (dialog.type === 'delete-batch' && dialog.batchId) deleteMutation.mutate(dialog.batchId)
                  else if (dialog.type === 'reject-batch' && dialog.batchId) rejectMutation.mutate(dialog.batchId)
                  else if (dialog.type === 'delete-all') deleteAllMutation.mutate()
                }}
                disabled={isPending}
                className={`px-4 py-2 text-sm text-white rounded-lg disabled:opacity-50 ${
                  dialog.type === 'reject-batch' ? 'bg-orange-600 hover:bg-orange-700' : 'bg-red-600 hover:bg-red-700'
                }`}>
                {isPending ? 'Processing…' : dialog.type === 'reject-batch' ? 'Reject' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
