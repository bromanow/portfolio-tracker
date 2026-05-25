import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getTransactions, getAccounts, getSecurities, createTransaction, createTransferPair, deleteTransaction, updateTransaction, deleteAllTransactions, getFxRateLookup, bulkUpdateTransactions, bulkDeleteTransactions } from '../api/client'
import type { Transaction, Security, Account, TransferPairCreate } from '../api/client'
import { Trash2, AlertTriangle, X, Edit2, Check, ChevronUp, ChevronDown, ChevronsUpDown, Plus, Download, RefreshCw } from 'lucide-react'
import MultiSelectDropdown from '../components/MultiSelectDropdown'
import { usePortfolioFilters } from '../hooks/usePortfolioFilters'

const TYPE_COLORS: Record<string, string> = {
  BUY: 'bg-blue-100 text-blue-800',
  SELL: 'bg-orange-100 text-orange-800',
  DIVIDEND: 'bg-green-100 text-green-800',
  DRIP: 'bg-teal-100 text-teal-800',
  OPTION_BUY: 'bg-purple-100 text-purple-800',
  OPTION_SELL: 'bg-pink-100 text-pink-800',
  OPTION_EXPIRY: 'bg-gray-100 text-gray-600',
  OPTION_ASSIGNMENT: 'bg-violet-100 text-violet-800',
  FX_CONVERSION: 'bg-cyan-100 text-cyan-800',
  JOURNAL: 'bg-slate-100 text-slate-700',
  TRANSFER_IN: 'bg-sky-100 text-sky-800',
  TRANSFER_OUT: 'bg-sky-100 text-sky-700',
  TRANSFER: 'bg-sky-100 text-sky-800',
  FEE: 'bg-red-100 text-red-700',
  INTEREST: 'bg-lime-100 text-lime-800',
  DEPOSIT: 'bg-emerald-100 text-emerald-800',
  WITHDRAWAL: 'bg-rose-100 text-rose-800',
  OPENING_BALANCE: 'bg-amber-100 text-amber-800',
}

export function TxTypeBadge({ type }: { type: string }) {
  const cls = TYPE_COLORS[type] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {type.replace(/_/g, ' ')}
    </span>
  )
}

function fmtNum(val: string | null | undefined, decimals = 2) {
  if (!val) return '—'
  const n = parseFloat(val)
  if (isNaN(n)) return val
  return n.toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

const ALL_TYPES = [
  'BUY', 'SELL', 'DIVIDEND', 'DRIP', 'RETURN_OF_CAPITAL',
  'OPTION_BUY', 'OPTION_SELL', 'OPTION_EXPIRY', 'OPTION_ASSIGNMENT', 'OPTION_EXERCISE',
  'TRANSFER_IN', 'TRANSFER_OUT', 'JOURNAL', 'FX_CONVERSION', 'FX_ADJUSTMENT',
  'SPLIT', 'FORWARD_SPLIT', 'REVERSE_SPLIT', 'INTEREST', 'FEE', 'DEPOSIT', 'WITHDRAWAL',
  'OPENING_BALANCE', 'CASH_OPENING', 'ADJUSTMENT', 'OTHER',
]

// Numeric fields that may contain user-typed commas (e.g. "2,536")
const NUMERIC_FIELDS = ['quantity','price','commission','transaction_amount','account_currency_amount','cad_amount','fx_rate_to_account','fx_rate_to_cad'] as const

function cleanNumericFields<T extends Record<string, unknown>>(data: T): T {
  const result: Record<string, unknown> = { ...data }
  for (const f of NUMERIC_FIELDS) {
    if (typeof result[f] === 'string') {
      result[f] = (result[f] as string).replace(/,/g, '')
    }
  }
  return result as T
}

function fmtApiError(err: unknown): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: string }
  const detail = e?.response?.data?.detail
  if (Array.isArray(detail)) {
    // Pydantic 422 returns array of {loc, msg, type}
    return detail.map((d: { msg?: string; loc?: string[] }) =>
      `${d.loc?.slice(1).join('.') ?? ''}: ${d.msg ?? ''}`.trim()
    ).join('; ')
  }
  if (typeof detail === 'string') return detail
  return e?.message || 'Request failed'
}

interface ConfirmState {
  type: 'delete-one' | 'delete-all'
  txId?: number
  label?: string
}

interface EditState {
  tx: Transaction
  fields: Partial<Transaction>
}

type SortCol = 'transaction_date' | 'transaction_type' | 'security_ticker' | 'account_name' | 'quantity' | 'price' | 'transaction_amount' | 'cad_amount'

function SortTh({ label, col, sortBy, sortDir, onSort, className = '' }: {
  label: string; col: SortCol; sortBy: SortCol; sortDir: 'asc' | 'desc'
  onSort: (c: SortCol) => void; className?: string
}) {
  const active = sortBy === col
  return (
    <th className={`cursor-pointer select-none hover:bg-gray-100 ${className}`} onClick={() => onSort(col)}>
      <div className="flex items-center gap-1">
        {label}
        {active
          ? sortDir === 'asc'
            ? <ChevronUp className="h-3 w-3 text-blue-600" />
            : <ChevronDown className="h-3 w-3 text-blue-600" />
          : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
      </div>
    </th>
  )
}

interface TxFormFieldsProps {
  fields: Partial<Transaction>
  onChange: (fields: Partial<Transaction>) => void
  accounts: Account[]
  securities: Security[]
  tickerInput: string
  onTickerChange: (val: string) => void
  tickerDatalistId: string
  mode: 'create' | 'edit'
}

function TxFormFields({ fields, onChange, accounts, securities, tickerInput, onTickerChange, tickerDatalistId, mode }: TxFormFieldsProps) {
  const [systemFxRate, setSystemFxRate] = useState<string | null>(null)
  const [fxLoading, setFxLoading] = useState(false)
  const [cadManual, setCadManual] = useState(false)
  // Track last fetched params so we don't double-apply on re-render
  const lastFetchRef = useRef<string>('')

  const currency = (fields.transaction_currency as string) || 'CAD'
  const isNonCAD = currency !== 'CAD'
  const isJournal = (fields.transaction_type as string) === 'JOURNAL'
  // For JOURNALs we always show the CAD book-value section (even when currency = CAD)
  const showFxSection = isNonCAD || isJournal

  const computeCad = useCallback((txAmt: string | null | undefined, fx: string | null | undefined): string | null => {
    const a = parseFloat(txAmt as string)
    const f = parseFloat(fx as string)
    if (isNaN(a) || isNaN(f)) return null
    return (a * f).toFixed(4)
  }, [])

  // Fetch system FX rate when date or currency changes
  useEffect(() => {
    const txDate = fields.transaction_date as string | undefined
    if (!txDate || !isNonCAD) {
      setSystemFxRate(null)
      return
    }
    const key = `${txDate}|${currency}`
    if (lastFetchRef.current === key) return
    lastFetchRef.current = key
    setFxLoading(true)
    getFxRateLookup(txDate, currency)
      .then(res => {
        const rate = res.rate
        setSystemFxRate(rate)
        if (mode === 'create') {
          const cadAmt = computeCad(fields.transaction_amount as string | undefined, rate)
          onChange({
            ...fields,
            fx_rate_to_cad: rate,
            fx_rate_to_account: rate,
            ...(cadAmt !== null ? { cad_amount: cadAmt } : {}),
          })
        }
      })
      .catch(() => setSystemFxRate(null))
      .finally(() => setFxLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.transaction_date, currency])

  const handleTxAmountChange = (val: string) => {
    const updates: Partial<Transaction> = { ...fields, transaction_amount: val || undefined }
    if (isNonCAD) {
      const txAmt = parseFloat(val.replace(/,/g, ''))
      if (cadManual) {
        // CAD amount is the driver — back-compute FX rate from cad ÷ tx_amount
        const cadAmt = parseFloat((fields.cad_amount as string | undefined)?.replace(/,/g, '') ?? '')
        if (!isNaN(txAmt) && txAmt !== 0 && !isNaN(cadAmt)) {
          const back = (cadAmt / txAmt).toFixed(6)
          updates.fx_rate_to_cad = back
          updates.fx_rate_to_account = back
        }
      } else {
        // FX rate is the driver — forward-compute cad_amount
        const cad = computeCad(val, fields.fx_rate_to_cad as string | undefined)
        if (cad !== null) updates.cad_amount = cad
      }
    }
    onChange(updates)
  }

  const handleFxRateChange = (val: string) => {
    // FX rate edited manually — switch to forward mode
    setCadManual(false)
    const updates: Partial<Transaction> = { ...fields, fx_rate_to_cad: val || undefined, fx_rate_to_account: val || undefined }
    if (isNonCAD) {
      const cad = computeCad(fields.transaction_amount as string | undefined, val)
      if (cad !== null) updates.cad_amount = cad
    }
    onChange(updates)
  }

  const handleCadAmountChange = (val: string) => {
    // CAD amount edited manually — switch to reverse mode and back-compute FX rate
    setCadManual(true)
    const updates: Partial<Transaction> = { ...fields, cad_amount: val || undefined }
    if (isNonCAD) {
      const cadAmt = parseFloat(val.replace(/,/g, ''))
      const txAmt = parseFloat((fields.transaction_amount as string | undefined)?.replace(/,/g, '') ?? '')
      if (!isNaN(cadAmt) && !isNaN(txAmt) && txAmt !== 0) {
        const back = (cadAmt / txAmt).toFixed(6)
        updates.fx_rate_to_cad = back
        updates.fx_rate_to_account = back
      }
    } else if (isJournal) {
      // JOURNAL with CAD currency: book value is entered directly in CAD;
      // keep transaction_amount in sync (same currency, same number)
      updates.transaction_amount = val || undefined
      updates.account_currency_amount = val || undefined
    }
    onChange(updates)
  }

  const handleCadReset = () => {
    // Reset to forward mode: recompute cad_amount from tx_amount × fx_rate
    setCadManual(false)
    const cad = computeCad(fields.transaction_amount as string | undefined, fields.fx_rate_to_cad as string | undefined)
    onChange({ ...fields, cad_amount: cad ?? undefined })
  }

  const fxRateStr = (fields.fx_rate_to_cad as string | undefined) || ''
  const systemRateHint = () => {
    if (!isNonCAD) return null
    const backComputedNote = cadManual
      ? <span className="text-xs text-amber-600 ml-1">← back-computed from CAD ÷ amount</span>
      : null
    if (fxLoading) return <span className="text-xs text-gray-400">Fetching system rate…{backComputedNote}</span>
    if (!systemFxRate) return <span className="text-xs text-gray-400">No system rate for this date{backComputedNote}</span>
    const rounded = parseFloat(fxRateStr).toFixed(4)
    const roundedSys = parseFloat(systemFxRate).toFixed(4)
    if (rounded === roundedSys) return <span className="text-xs text-gray-400">System rate ✓{backComputedNote}</span>
    return (
      <span className="text-xs text-gray-400">
        System: {systemFxRate}{' '}
        <button type="button" className="text-xs text-blue-500 underline" onClick={() => handleFxRateChange(systemFxRate)}>
          {mode === 'create' ? 'Apply' : 'Apply system rate'}
        </button>
        {backComputedNote}
      </span>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      {/* Account */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Account {mode === 'create' && <span className="text-red-400">*</span>}
        </label>
        <select className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={fields.account_id || ''}
          onChange={e => onChange({ ...fields, account_id: e.target.value ? Number(e.target.value) : undefined })}>
          {mode === 'edit' && <option value="">— unchanged —</option>}
          {mode === 'create' && <option value="">Select account</option>}
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      {/* Date */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Date <span className="text-red-400">*</span></label>
        <input type="date" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={(fields.transaction_date as string) || ''}
          onChange={e => {
            lastFetchRef.current = ''
            onChange({ ...fields, transaction_date: e.target.value })
          }} />
      </div>
      {/* Type */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Type <span className="text-red-400">*</span></label>
        <select className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={(fields.transaction_type as string) || ''}
          onChange={e => onChange({ ...fields, transaction_type: e.target.value })}>
          {ALL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {/* Ticker */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Ticker (Security)</label>
        <input list={tickerDatalistId} className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full uppercase"
          value={tickerInput}
          onChange={e => onTickerChange(e.target.value.toUpperCase())}
          placeholder="e.g. ENB" />
        <datalist id={tickerDatalistId}>
          {(securities as Security[]).map(s => (
            <option key={s.id} value={s.ticker}>{s.name || s.ticker}</option>
          ))}
        </datalist>
        {tickerInput && !(securities as Security[]).find(s => s.ticker.toUpperCase() === tickerInput) && (
          <p className="text-xs text-amber-600 mt-0.5">
            {mode === 'create' ? '⚠ Ticker not found — new security will be created' : '⚠ Ticker not found in securities list'}
          </p>
        )}
      </div>
      {/* Quantity */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Quantity</label>
        <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={(fields.quantity as string) || ''}
          onChange={e => onChange({ ...fields, quantity: e.target.value || undefined })} />
      </div>
      {/* Transaction Currency */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Transaction Currency</label>
        <select className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={currency}
          onChange={e => {
            lastFetchRef.current = ''
            onChange({ ...fields, transaction_currency: e.target.value })
          }}>
          <option>CAD</option>
          <option>USD</option>
        </select>
      </div>
      {/* Price */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Price ({currency})</label>
        <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={(fields.price as string) || ''}
          onChange={e => onChange({ ...fields, price: e.target.value || undefined })} />
      </div>
      {/* Commission */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Commission ({currency})</label>
        <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={(fields.commission as string) || ''}
          onChange={e => onChange({ ...fields, commission: e.target.value || undefined })} />
      </div>
      {/* Net Amount / Book Value */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          {isJournal ? `Book Value (${currency})` : `Net Amount (${currency})`}
        </label>
        <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={(fields.transaction_amount as string) || ''}
          onChange={e => handleTxAmountChange(e.target.value)} />
      </div>
      {/* Spacer to keep grid even */}
      <div />
      {/* ACB Book Value section — FX + CAD amount for non-CAD, or CAD-only for JOURNAL */}
      {showFxSection && (
        <>
          {/* Explanation banner for JOURNAL transactions */}
          {isJournal && (
            <div className="col-span-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 space-y-0.5">
              <p className="font-semibold">ACB Book Value Transfer</p>
              <p>
                For the <strong>receiving leg (+qty)</strong>, enter the book value of the transferred shares.
                This sets the cost basis (ACB) in the destination account.
                Use the original purchase cost — <strong>not</strong> the current market price.
              </p>
              {fields.quantity && parseFloat(fields.quantity as string) < 0 && (
                <p className="text-amber-600 italic">
                  This appears to be the <strong>outgoing leg (−qty)</strong>. The ACB here has no effect —
                  edit the receiving leg (+qty) instead.
                </p>
              )}
            </div>
          )}
          <div className={`col-span-2 grid gap-3 ${isNonCAD ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {/* FX Rate — only for non-CAD */}
            {isNonCAD && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  {isJournal ? `FX Rate on transfer date (${currency} → CAD)` : `FX Rate (${currency} → CAD)`}
                </label>
                <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
                  value={fxRateStr}
                  onChange={e => handleFxRateChange(e.target.value)} />
                <div className="mt-0.5">{systemRateHint()}</div>
              </div>
            )}
            {/* CAD Amount — always shown for JOURNAL or non-CAD */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                {isJournal ? 'Book Value (CAD) ← used as ACB' : 'CAD Amount'}
              </label>
              <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
                value={(fields.cad_amount as string) || ''}
                onChange={e => handleCadAmountChange(e.target.value)} />
              <div className="mt-0.5">
                {isNonCAD
                  ? cadManual
                    ? <span className="text-xs text-gray-400">manual —{' '}
                        <button type="button" className="text-xs text-blue-500 underline" onClick={handleCadReset}>↺ auto</button>
                      </span>
                    : <span className="text-xs text-gray-400">auto-computed from amount × FX rate</span>
                  : isJournal
                    ? <span className="text-xs text-gray-400">enter the CAD book value directly</span>
                    : null
                }
              </div>
            </div>
          </div>
        </>
      )}
      {/* Notes */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Notes {mode === 'edit' && <span className="text-gray-400">(user field)</span>}</label>
        <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
          value={(fields.notes as string) || ''}
          onChange={e => onChange({ ...fields, notes: e.target.value || undefined })} />
      </div>
      {/* Description */}
      <div className="col-span-2">
        <label className="block text-xs text-gray-500 mb-1">
          Description{mode === 'edit' && <span className="text-gray-400"> (original CSV text — editable)</span>}
          {mode === 'create' && <span className="text-gray-400"> (optional)</span>}
        </label>
        <input type="text" className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full text-gray-600"
          value={(fields.raw_description as string) || ''}
          onChange={e => onChange({ ...fields, raw_description: e.target.value || undefined })} />
      </div>
    </div>
  )
}

const CSV_COLUMNS: { key: keyof Transaction | 'account_name' | 'security_ticker'; label: string }[] = [
  { key: 'id', label: 'ID' },
  { key: 'transaction_date', label: 'Date' },
  { key: 'settlement_date', label: 'Settlement Date' },
  { key: 'account_name', label: 'Account' },
  { key: 'security_ticker', label: 'Ticker' },
  { key: 'transaction_type', label: 'Type' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'price', label: 'Price' },
  { key: 'commission', label: 'Commission' },
  { key: 'transaction_currency', label: 'Currency' },
  { key: 'transaction_amount', label: 'Tx Amount' },
  { key: 'account_currency_amount', label: 'Acct CCY Amount' },
  { key: 'cad_amount', label: 'CAD Amount' },
  { key: 'fx_rate_to_cad', label: 'FX Rate (CAD)' },
  { key: 'notes', label: 'Notes' },
  { key: 'raw_description', label: 'Raw Description' },
  { key: 'tags', label: 'Tags' },
  { key: 'is_verified', label: 'Verified' },
]

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return ''
  const s = Array.isArray(val) ? val.join('; ') : String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function exportTransactionsCsv(params: {
  account_ids?: string
  transaction_type?: string
  ticker?: string
  date_from?: string
  date_to?: string
  sort_by?: string
  sort_dir?: 'asc' | 'desc'
}) {
  const data = await getTransactions({ ...params, page: 1, page_size: 9999 })
  const header = CSV_COLUMNS.map(c => c.label).join(',')
  const rows = data.items.map(tx =>
    CSV_COLUMNS.map(c => csvEscape(tx[c.key as keyof Transaction])).join(',')
  )
  const csv = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `transactions_${new Date().toISOString().slice(0, 10)}.csv`
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 100)
}

export default function Transactions({ showHeader = true, accountIds: accountIdsOverride }: { showHeader?: boolean; accountIds?: string }) {
  const qc = useQueryClient()
  const [txTypes, setTxTypes] = useState<string[]>([])
  const [ticker, setTicker] = useState<string>('')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sortBy, setSortBy] = useState<SortCol>('transaction_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [dialog, setDialog] = useState<ConfirmState | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [tickerInput, setTickerInput] = useState<string>('')
  const [deleteAllAccountId, setDeleteAllAccountId] = useState<string>('')
  // Create new transaction
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [createTickerInput, setCreateTickerInput] = useState('')
  const [newTxn, setNewTxn] = useState<Partial<Transaction>>({
    transaction_date: new Date().toISOString().slice(0, 10),
    transaction_type: 'BUY',
    transaction_currency: 'CAD',
  })
  // Linked account for transfer-pair creation
  const [linkedAccountId, setLinkedAccountId] = useState<string>('')
  const [linkedTransferType, setLinkedTransferType] = useState<'JOURNAL' | 'TRANSFER'>('JOURNAL')

  // ── Bulk selection & type-change ───────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkType, setBulkType] = useState<string>('DRIP')
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [selectAllLoading, setSelectAllLoading] = useState(false)
  // When true, selection covers ALL rows matching current filter (not just this page)
  const [selectAllMatching, setSelectAllMatching] = useState(false)

  const { data: rawAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const accounts = rawAccounts as Account[]
  const { data: securities = [] } = useQuery({ queryKey: ['securities'], queryFn: () => getSecurities() })

  const { histAccountIds, hasFilter: hasAccountFilter, clearFilters, effectiveAccountIds } = usePortfolioFilters(accounts)

  // When embedded in another page (e.g. Reports), the parent can override account scoping
  const accountIdsParam = accountIdsOverride !== undefined ? accountIdsOverride : histAccountIds

  // Reset page when account filter changes
  useEffect(() => { setPage(1) }, [accountIdsParam])

  const handleSort = (col: SortCol) => {
    if (col === sortBy) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      setSortDir('desc')
    }
    setPage(1)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['transactions', accountIdsParam, txTypes, ticker, dateFrom, dateTo, page, pageSize, sortBy, sortDir],
    queryFn: () => getTransactions({
      account_ids: accountIdsParam,
      transaction_type: txTypes.length ? txTypes.join(',') : undefined,
      ticker: ticker || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      page,
      page_size: pageSize,
      sort_by: sortBy,
      sort_dir: sortDir,
    }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteTransaction(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
      setDialog(null)
      setDialogError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) => {
      setDialogError(err?.response?.data?.detail || err?.message || 'Delete failed')
    },
  })

  const deleteAllMutation = useMutation({
    mutationFn: (acctId: number | undefined) => deleteAllTransactions(acctId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
      setDialog(null)
      setDialogError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) => {
      setDialogError(err?.response?.data?.detail || err?.message || 'Delete failed')
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, fields }: { id: number; fields: Partial<Transaction> }) =>
      updateTransaction(id, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setEditing(null)
      setEditError(null)
    },
    onError: (err: unknown) => setEditError(fmtApiError(err)),
  })

  const bulkUpdateMutation = useMutation({
    mutationFn: ({ ids, type }: { ids: number[]; type: string }) =>
      bulkUpdateTransactions(ids, type),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setSelectedIds(new Set())
      setSelectAllMatching(false)
      setBulkConfirm(false)
      alert(`✓ Updated ${res.updated} transaction${res.updated !== 1 ? 's' : ''} to ${bulkType}.`)
    },
    onError: (err: unknown) => alert('Bulk update failed: ' + fmtApiError(err)),
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => bulkDeleteTransactions(ids),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
      setSelectedIds(new Set())
      setSelectAllMatching(false)
      setBulkDeleteConfirm(false)
      alert(`✓ Deleted ${res.deleted} transaction${res.deleted !== 1 ? 's' : ''}.`)
    },
    onError: (err: unknown) => { setBulkDeleteConfirm(false); alert('Bulk delete failed: ' + fmtApiError(err)) },
  })

  // Clear selection when filter/page changes
  useEffect(() => {
    setSelectedIds(new Set())
    setSelectAllMatching(false)
  }, [accountIdsParam, txTypes, ticker, dateFrom, dateTo, page, pageSize])

  const resetCreateForm = () => {
    setNewTxn({ transaction_date: new Date().toISOString().slice(0, 10), transaction_type: 'BUY', transaction_currency: 'CAD' })
    setCreateTickerInput('')
    setLinkedAccountId('')
  }

  const createMutation = useMutation({
    mutationFn: (data: Partial<Transaction>) => createTransaction(cleanNumericFields(data)),
    onSuccess: (created: Transaction) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setCreating(false)
      setCreateError(null)
      resetCreateForm()
      // If the new transaction's account isn't visible under the current filter, clear it
      if (hasAccountFilter && created.account_id && !effectiveAccountIds.has(Number(created.account_id))) {
        clearFilters()
      }
    },
    onError: (err: unknown) => setCreateError(fmtApiError(err)),
  })

  const createPairMutation = useMutation({
    mutationFn: (data: TransferPairCreate) => createTransferPair(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setCreating(false)
      setCreateError(null)
      resetCreateForm()
      // A paired transfer spans two accounts — clear any account filter so both legs are visible
      if (hasAccountFilter) clearFilters()
    },
    onError: (err: unknown) => setCreateError(fmtApiError(err)),
  })

  const handleDelete = (tx: Transaction) => {
    setDialogError(null)
    setDialog({
      type: 'delete-one',
      txId: tx.id,
      label: `${tx.transaction_date} · ${tx.transaction_type} · ${tx.security_ticker || '—'}`,
    })
  }

  const handleEdit = (tx: Transaction) => {
    setEditError(null)
    setTickerInput(tx.security_ticker || '')
    setEditing({ tx, fields: { ...tx } })
  }

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0

  // Page-level selection helpers
  const pageIds = (data?.items ?? []).map((t: Transaction) => t.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id))
  const somePageSelected = pageIds.some(id => selectedIds.has(id))

  const togglePageSelect = () => {
    if (allPageSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        pageIds.forEach(id => next.delete(id))
        return next
      })
      setSelectAllMatching(false)
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        pageIds.forEach(id => next.add(id))
        return next
      })
    }
  }

  const toggleRow = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id); setSelectAllMatching(false) }
      else next.add(id)
      return next
    })
  }

  const handleSelectAllMatching = async () => {
    setSelectAllLoading(true)
    try {
      const all = await getTransactions({
        account_ids: accountIdsParam,
        transaction_type: txTypes.length ? txTypes.join(',') : undefined,
        ticker: ticker || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        page: 1,
        page_size: 9999,
      })
      setSelectedIds(new Set(all.items.map((t: Transaction) => t.id)))
      setSelectAllMatching(true)
    } finally {
      setSelectAllLoading(false)
    }
  }

  const handleBulkApply = () => {
    if (selectedIds.size === 0) return
    if (selectedIds.size > 10) {
      setBulkConfirm(true)
    } else {
      bulkUpdateMutation.mutate({ ids: Array.from(selectedIds), type: bulkType })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        {showHeader && <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>}
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              setIsExporting(true)
              try {
                await exportTransactionsCsv({
                  account_ids: accountIdsParam,
                  transaction_type: txTypes.length ? txTypes.join(',') : undefined,
                  ticker: ticker || undefined,
                  date_from: dateFrom || undefined,
                  date_to: dateTo || undefined,
                  sort_by: sortBy,
                  sort_dir: sortDir,
                })
              } finally {
                setIsExporting(false)
              }
            }}
            disabled={isExporting}
            className="flex items-center gap-2 text-sm text-green-700 border border-green-300 rounded px-3 py-1.5 hover:bg-green-50 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {isExporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button
            onClick={() => { setCreateError(null); setCreateTickerInput(''); setLinkedAccountId(''); setLinkedTransferType('JOURNAL'); setNewTxn({ transaction_date: new Date().toISOString().slice(0, 10), transaction_type: 'BUY', transaction_currency: 'CAD' }); setCreating(true) }}
            className="flex items-center gap-2 text-sm text-blue-600 border border-blue-300 rounded px-3 py-1.5 hover:bg-blue-50"
          >
            <Plus className="h-4 w-4" />
            New Transaction
          </button>
          <button
            onClick={() => { setDialogError(null); setDialog({ type: 'delete-all' }) }}
            className="flex items-center gap-2 text-sm text-red-600 border border-red-300 rounded px-3 py-1.5 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete All
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectDropdown
          placeholder="All Tx Types"
          options={ALL_TYPES.map(t => ({ value: t, label: t }))}
          selected={txTypes}
          onChange={v => { setTxTypes(v); setPage(1) }}
        />

        <input
          type="text"
          className="border border-gray-200 rounded px-2 py-1 text-xs text-gray-600 w-24"
          placeholder="Ticker…"
          value={ticker}
          onChange={e => { setTicker(e.target.value.toUpperCase()); setPage(1) }}
        />

        <div className="flex items-center gap-1 text-xs text-gray-500">
          <input
            type="date"
            className="border border-gray-200 rounded px-2 py-1 text-xs text-gray-600"
            value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1) }}
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            className="border border-gray-200 rounded px-2 py-1 text-xs text-gray-600"
            value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1) }}
          />
        </div>

        {(txTypes.length > 0 || ticker || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setTxTypes([]); setTicker(''); setDateFrom(''); setDateTo('')
              setPage(1); setSortBy('transaction_date'); setSortDir('desc')
            }}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Clear
          </button>
        )}
      </div>

      {/* Results */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-gray-600 font-medium">
            {data ? (
              <>
                <span className="text-gray-900 font-semibold">{data.total.toLocaleString()}</span>
                {' '}transaction{data.total !== 1 ? 's' : ''}
                {data.total > pageSize && (
                  <span className="text-gray-400 ml-1">
                    — showing {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, data.total)}
                  </span>
                )}
              </>
            ) : ''}
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm">
              <label className="text-xs text-gray-500">Rows:</label>
              <select
                className="border border-gray-300 rounded px-2 py-1 text-sm"
                value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
              >
                {[25, 50, 100, 200, 500].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            {data && data.total > pageSize && (
              <div className="flex items-center gap-2 text-sm">
                <button
                  disabled={page === 1}
                  onClick={() => setPage(p => p - 1)}
                  className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  Prev
                </button>
                <span className="text-gray-600">{page} / {totalPages}</span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                  className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
        {/* ── Bulk action bar ── */}
        {selectedIds.size > 0 && (
          <div className="px-5 py-2.5 bg-blue-50 border-b border-blue-200 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-blue-800">
              {selectedIds.size.toLocaleString()} transaction{selectedIds.size !== 1 ? 's' : ''} selected
              {selectAllMatching && data && selectedIds.size === data.total && (
                <span className="ml-1 text-blue-600">(all matching filter)</span>
              )}
            </span>
            <button
              onClick={() => { setSelectedIds(new Set()); setSelectAllMatching(false) }}
              className="text-xs text-blue-500 hover:text-blue-700 underline"
            >
              Clear selection
            </button>
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={() => setBulkDeleteConfirm(true)}
                disabled={bulkDeleteMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Selected
              </button>
              <span className="text-gray-300">|</span>
              <span className="text-xs text-blue-700 font-medium">Change type to:</span>
              <select
                className="border border-blue-300 rounded px-2 py-1 text-sm bg-white"
                value={bulkType}
                onChange={e => setBulkType(e.target.value)}
              >
                {ALL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <button
                onClick={handleBulkApply}
                disabled={bulkUpdateMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {bulkUpdateMutation.isPending
                  ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Updating…</>
                  : <><Check className="h-3.5 w-3.5" /> Apply</>
                }
              </button>
            </div>
          </div>
        )}

        {/* ── Select all matching banner ── */}
        {allPageSelected && !selectAllMatching && data && data.total > pageSize && (
          <div className="px-5 py-2 bg-blue-50 border-b border-blue-100 text-center text-sm text-blue-700">
            All {pageIds.length} on this page selected.{' '}
            <button
              onClick={handleSelectAllMatching}
              disabled={selectAllLoading}
              className="font-semibold underline hover:text-blue-900 disabled:opacity-50"
            >
              {selectAllLoading
                ? 'Loading…'
                : `Select all ${data.total.toLocaleString()} matching this filter`}
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm divide-y divide-gray-100">
              <thead className="bg-gray-50">
                <tr className="text-xs text-gray-500 uppercase">
                  <th className="pl-3 pr-1 py-3 w-8">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300 text-blue-600"
                      checked={allPageSelected}
                      ref={el => { if (el) el.indeterminate = somePageSelected && !allPageSelected }}
                      onChange={togglePageSelect}
                      title="Select / deselect all on this page"
                    />
                  </th>
                  <SortTh label="Date" col="transaction_date" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-left" />
                  <SortTh label="Type" col="transaction_type" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-left" />
                  <SortTh label="Ticker" col="security_ticker" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-left" />
                  <SortTh label="Account" col="account_name" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-left" />
                  <SortTh label="Qty" col="quantity" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-right" />
                  <SortTh label="Price" col="price" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-right" />
                  <SortTh label="Amount (Tx CCY)" col="transaction_amount" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-right" />
                  <SortTh label="Amount (CAD)" col="cad_amount" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="px-3 py-3 text-right" />
                  <th className="px-3 py-3 text-center">CCY</th>
                  <th className="px-3 py-3 text-left">Description</th>
                  <th className="px-3 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {data?.items.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-gray-400">No transactions found</td>
                  </tr>
                ) : (
                  data?.items.map((t: Transaction) => (
                    <tr key={t.id} className={`hover:bg-gray-50 ${selectedIds.has(t.id) ? 'bg-blue-50' : ''}`}>
                      <td className="pl-3 pr-1 py-2.5">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300 text-blue-600"
                          checked={selectedIds.has(t.id)}
                          onChange={() => toggleRow(t.id)}
                        />
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{t.transaction_date}</td>
                      <td className="px-3 py-2.5"><TxTypeBadge type={t.transaction_type} /></td>
                      <td className="px-3 py-2.5 font-mono text-xs font-medium">{t.security_ticker || '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-500 whitespace-nowrap">{t.account_name}</td>
                      <td className="px-3 py-2.5 text-right text-gray-700">{fmtNum(t.quantity, 4)}</td>
                      <td className="px-3 py-2.5 text-right text-gray-700">{fmtNum(t.price)}</td>
                      <td className="px-3 py-2.5 text-right font-medium">{fmtNum(t.transaction_amount)}</td>
                      <td className="px-3 py-2.5 text-right font-medium">{fmtNum(t.cad_amount)}</td>
                      <td className="px-3 py-2.5 text-center text-xs text-gray-500">{t.transaction_currency || '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-gray-400 max-w-xs truncate">{t.raw_description || t.notes || '—'}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleEdit(t)}
                            className="text-gray-400 hover:text-blue-600 transition-colors"
                            title="Edit"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(t)}
                            className="text-gray-400 hover:text-red-600 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {data && data.items.length > 0 && (() => {
                const pageTotal = data.items.reduce((sum: number, t: Transaction) => {
                  const v = t.cad_amount != null ? parseFloat(t.cad_amount) : 0
                  return sum + (isNaN(v) ? 0 : v)
                }, 0)
                return (
                  <tfoot className="bg-gray-50 border-t-2 border-gray-200">
                    <tr>
                      <td colSpan={8} className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        Page Total
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-gray-800">
                        {pageTotal.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                )
              })()}
            </table>
          </div>
        )}

        {/* Bottom pagination — mirrors top */}
        {data && data.total > pageSize && (
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between flex-wrap gap-3">
            <span className="text-sm text-gray-400">
              {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-2 text-sm">
              <button
                disabled={page === 1}
                onClick={() => { setPage(p => p - 1); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
              >
                Prev
              </button>
              <span className="text-gray-600">{page} / {totalPages}</span>
              <button
                disabled={page >= totalPages}
                onClick={() => { setPage(p => p + 1); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Confirm Delete Modal ── */}
      {dialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-500 mt-0.5 shrink-0" />
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">
                  {dialog.type === 'delete-all' ? 'Delete All Transactions' : 'Delete Transaction'}
                </h3>
                {dialog.type === 'delete-all' ? (
                  <div className="space-y-3 mt-2">
                    <p className="text-sm text-gray-600">
                      This will permanently delete transactions and cannot be undone.
                    </p>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Scope (leave blank to delete ALL)</label>
                      <select
                        className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
                        value={deleteAllAccountId}
                        onChange={e => setDeleteAllAccountId(e.target.value)}
                      >
                        <option value="">All accounts</option>
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 font-medium">
                      ⚠️ This action is irreversible.
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-600 mt-1">
                    Delete: <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">{dialog.label}</span>
                  </p>
                )}
                {dialogError && (
                  <div className="mt-3 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                    Error: {dialogError}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => { setDialog(null); setDialogError(null) }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (dialog.type === 'delete-one' && dialog.txId) {
                    deleteMutation.mutate(dialog.txId)
                  } else if (dialog.type === 'delete-all') {
                    deleteAllMutation.mutate(deleteAllAccountId ? Number(deleteAllAccountId) : undefined)
                  }
                }}
                disabled={deleteMutation.isPending || deleteAllMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {(deleteMutation.isPending || deleteAllMutation.isPending) ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Transaction Modal ── */}
      {creating && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">New Transaction</h3>
              <button onClick={() => setCreating(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <TxFormFields
              fields={newTxn}
              onChange={fields => setNewTxn(fields)}
              accounts={accounts as Account[]}
              securities={securities as Security[]}
              tickerInput={createTickerInput}
              onTickerChange={val => {
                setCreateTickerInput(val)
                const sec = (securities as Security[]).find(s => s.ticker.toUpperCase() === val)
                setNewTxn(p => ({ ...p, security_id: sec?.id ?? undefined }))
              }}
              tickerDatalistId="create-tx-tickers"
              mode="create"
            />

            {/* ── Transfer counterpart panel ── */}
            {(['JOURNAL', 'TRANSFER_OUT', 'TRANSFER_IN'] as string[]).includes(newTxn.transaction_type as string) && (
              <div className="border border-sky-200 bg-sky-50 rounded-lg p-3 space-y-3">
                <p className="text-xs font-medium text-sky-800">
                  Auto-create counterpart transaction
                </p>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Transfer to / from account</label>
                    <select
                      className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
                      value={linkedAccountId}
                      onChange={e => setLinkedAccountId(e.target.value)}
                    >
                      <option value="">— Single transaction only —</option>
                      {(accounts as Account[])
                        .filter(a => a.id !== Number(newTxn.account_id))
                        .map(a => <option key={a.id} value={a.id}>{a.name}</option>)
                      }
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Transfer style</label>
                    <select
                      className="border border-gray-300 rounded px-3 py-1.5 text-sm w-full"
                      value={linkedTransferType}
                      onChange={e => setLinkedTransferType(e.target.value as 'JOURNAL' | 'TRANSFER')}
                    >
                      <option value="JOURNAL">Journal (iTrade-style — both legs JOURNAL)</option>
                      <option value="TRANSFER">Transfer (TRANSFER_OUT / TRANSFER_IN)</option>
                    </select>
                  </div>
                </div>
                {linkedAccountId && (
                  <p className="text-xs text-sky-700">
                    Will create: <strong>{linkedTransferType === 'JOURNAL' ? 'JOURNAL −qty' : 'TRANSFER_OUT'}</strong> in source account
                    + <strong>{linkedTransferType === 'JOURNAL' ? 'JOURNAL +qty' : 'TRANSFER_IN'}</strong> in counterpart.
                    Quantity entered above is used as-is for the receiving leg; source leg is automatically negated.
                  </p>
                )}
              </div>
            )}

            {createError && (
              <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                Error: {createError}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
              <button
                onClick={() => { setCreating(false); setCreateError(null); resetCreateForm() }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const isPending = createMutation.isPending || createPairMutation.isPending
                  if (isPending) return

                  // Transfer-pair path: create both legs atomically
                  if (linkedAccountId && newTxn.account_id) {
                    const fromId  = Number(newTxn.account_id)
                    const toId    = Number(linkedAccountId)
                    const txType  = newTxn.transaction_type as string
                    // Determine source / dest: TRANSFER_IN means current account is the destination
                    const [sourceId, destId] = txType === 'TRANSFER_IN'
                      ? [toId, fromId]
                      : [fromId, toId]
                    const pair: TransferPairCreate = {
                      from_account_id: sourceId,
                      to_account_id:   destId,
                      transaction_date: newTxn.transaction_date as string,
                      transfer_type: linkedTransferType,
                      security_id: newTxn.security_id as number | undefined,
                      quantity: newTxn.quantity as string | undefined,
                      price: newTxn.price as string | undefined,
                      cad_amount: newTxn.cad_amount as string | undefined,
                      notes: newTxn.notes as string | undefined,
                    }
                    createPairMutation.mutate(pair)
                    return
                  }

                  // Single transaction path
                  const payload = { ...newTxn }
                  const txCcy = (payload.transaction_currency as string | undefined) || 'CAD'
                  if (txCcy === 'CAD' && payload.transaction_amount) {
                    payload.cad_amount = payload.transaction_amount
                    payload.account_currency_amount = payload.transaction_amount
                  } else if (!payload.account_currency_amount) {
                    payload.account_currency_amount = payload.cad_amount
                  }
                  createMutation.mutate(payload)
                }}
                disabled={createMutation.isPending || createPairMutation.isPending || !newTxn.account_id || !newTxn.transaction_date || !newTxn.transaction_type}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {(createMutation.isPending || createPairMutation.isPending)
                  ? 'Creating…'
                  : linkedAccountId ? 'Create Both Transactions' : 'Create Transaction'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Change Type Confirm Modal ── */}
      {bulkConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-amber-500 mt-0.5 shrink-0" />
              <div>
                <h3 className="font-semibold text-gray-900">Confirm Bulk Type Change</h3>
                <p className="text-sm text-gray-600 mt-1">
                  Change <strong>{selectedIds.size.toLocaleString()}</strong> transactions to type{' '}
                  <strong className="font-mono">{bulkType}</strong>?
                </p>
                <p className="text-xs text-gray-400 mt-1">This cannot be undone in bulk.</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setBulkConfirm(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => bulkUpdateMutation.mutate({ ids: Array.from(selectedIds), type: bulkType })}
                disabled={bulkUpdateMutation.isPending}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {bulkUpdateMutation.isPending ? 'Updating…' : `Change ${selectedIds.size.toLocaleString()} transactions`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Delete Confirm Modal ── */}
      {bulkDeleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-500 mt-0.5 shrink-0" />
              <div>
                <h3 className="font-semibold text-gray-900">Delete Selected Transactions</h3>
                <p className="text-sm text-gray-600 mt-1">
                  Permanently delete <strong>{selectedIds.size.toLocaleString()}</strong> selected transaction{selectedIds.size !== 1 ? 's' : ''}?
                </p>
                <p className="text-xs text-red-600 mt-2 font-medium">⚠️ This action cannot be undone.</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setBulkDeleteConfirm(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
                disabled={bulkDeleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {bulkDeleteMutation.isPending ? 'Deleting…' : `Delete ${selectedIds.size.toLocaleString()} transactions`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Transaction Modal ── */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Edit Transaction #{editing.tx.id}</h3>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <TxFormFields
              fields={editing.fields}
              onChange={fields => setEditing(p => p ? { ...p, fields } : null)}
              accounts={accounts as Account[]}
              securities={securities as Security[]}
              tickerInput={tickerInput}
              onTickerChange={val => {
                setTickerInput(val)
                const sec = (securities as Security[]).find(s => s.ticker.toUpperCase() === val)
                setEditing(p => p ? { ...p, fields: { ...p.fields, security_id: sec?.id ?? null } } : null)
              }}
              tickerDatalistId="edit-tx-tickers"
              mode="edit"
            />
            {editError && (
              <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                Error: {editError}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
              <button
                onClick={() => { setEditing(null); setEditError(null) }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const f = cleanNumericFields(editing.fields)
                  const txCcy = (f.transaction_currency as string | undefined) || 'CAD'
                  // For CAD transactions cad_amount always equals transaction_amount —
                  // always sync so editing the amount in the form propagates to cad_amount
                  if (txCcy === 'CAD' && f.transaction_amount) {
                    f.cad_amount = f.transaction_amount
                    f.account_currency_amount = f.transaction_amount
                  } else if (!f.account_currency_amount) {
                    f.account_currency_amount = f.cad_amount
                  }
                  updateMutation.mutate({ id: editing.tx.id, fields: f })
                }}
                disabled={updateMutation.isPending}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
                {updateMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
