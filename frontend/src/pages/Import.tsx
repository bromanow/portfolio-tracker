import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getImports, getAccounts, getSecurities, uploadFile, getImportPreview,
  commitImport, rejectImport, deleteImport, deleteAllImports, updateRawRow, remapImportTypes,
  checkImportDuplicates,
} from '../api/client'
import type { ImportBatch, Account, Security } from '../api/client'
import {
  Upload, CheckCircle, XCircle, AlertCircle, Eye, Trash2,
  AlertTriangle, Edit2, X, SkipForward, RotateCcw, RefreshCw,
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

export default function Import() {
  const qc = useQueryClient()
  const [selectedAccountId, setSelectedAccountId] = useState<number | undefined>()
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

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadFile(file, selectedAccountId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['imports'] })
      setUploadError(null)
      if (data?.batch_id) setPreviewBatchId(data.batch_id)
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

  // Row update (edit or skip/restore)
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
    // Only send non-empty changed fields
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
    // Always include ticker in updates if changed (also update raw_symbol for compatibility)
    if (updates.ticker) updates.raw_symbol = updates.ticker
    // account_id should be a number
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Import Transactions</h1>
        <button
          onClick={() => { setDialogError(null); setDialog({ type: 'delete-all' }) }}
          className="flex items-center gap-2 text-sm text-red-600 border border-red-300 rounded px-3 py-1.5 hover:bg-red-50"
        >
          <Trash2 className="h-4 w-4" /> Delete All Imports
        </button>
      </div>

      {/* Upload zone */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-4">
        <h2 className="font-semibold text-gray-800">Upload CSV File</h2>
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-600">Account (required for iTrade &amp; Scotia Wealth files):</label>
          <select
            className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            value={selectedAccountId ?? ''}
            onChange={e => setSelectedAccountId(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">Auto-detect (IBKR multi-account)</option>
            {(accounts as Account[]).map(a => (
              <option key={a.id} value={a.id}>{a.brokerage_name} – {a.name}</option>
            ))}
          </select>
          {selectedAccountId && (() => {
            const acct = (accounts as Account[]).find(a => a.id === selectedAccountId)
            return acct ? (
              <span className="text-xs bg-blue-50 border border-blue-200 text-blue-700 px-2 py-1 rounded">
                ✓ {acct.brokerage_name} · {acct.name}
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

      {/* Import history */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h2 className="font-semibold text-gray-800 mb-4">Import History</h2>
        {isLoading ? (
          <div className="text-gray-400 text-sm">Loading...</div>
        ) : imports.length === 0 ? (
          <p className="text-gray-400 text-sm">No imports yet</p>
        ) : (
          <div className="overflow-x-auto">
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
                {(imports as ImportBatch[]).map(batch => (
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

      {/* ── Row Edit Modal ── */}
      {editRow && editFields && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            {/* Modal header */}
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

            {/* Two-panel body */}
            <div className="flex gap-0 flex-1 min-h-0 overflow-hidden">

              {/* Left: Original CSV data */}
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

              {/* Right: Editable mapped fields */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Edit Mapped Fields
                </h4>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  {/* Date */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Transaction Date</label>
                    <input type="date" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.transaction_date}
                      onChange={e => setEditFields(f => f && ({ ...f, transaction_date: e.target.value }))} />
                  </div>

                  {/* Type */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Transaction Type</label>
                    <select className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.transaction_type}
                      onChange={e => setEditFields(f => f && ({ ...f, transaction_type: e.target.value }))}>
                      <option value="">— select —</option>
                      {ALL_TX_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                    </select>
                  </div>

                  {/* Ticker */}
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

                  {/* Account override */}
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

                  {/* Quantity */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.quantity}
                      onChange={e => setEditFields(f => f && ({ ...f, quantity: e.target.value }))} />
                  </div>

                  {/* Price */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Price per Unit</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.price}
                      onChange={e => setEditFields(f => f && ({ ...f, price: e.target.value }))} />
                  </div>

                  {/* Settlement amount (iTrade) */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Settlement Amount (iTrade)</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.settlement_amount}
                      onChange={e => setEditFields(f => f && ({ ...f, settlement_amount: e.target.value }))} />
                  </div>

                  {/* Net amount (IBKR) */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Net Amount (IBKR)</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.net_amount}
                      onChange={e => setEditFields(f => f && ({ ...f, net_amount: e.target.value }))} />
                  </div>

                  {/* Commission */}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Commission</label>
                    <input type="number" step="any" className="border rounded px-3 py-1.5 text-sm w-full"
                      value={editFields.commission}
                      onChange={e => setEditFields(f => f && ({ ...f, commission: e.target.value }))} />
                  </div>

                  {/* Currency */}
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

            {/* Footer */}
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
